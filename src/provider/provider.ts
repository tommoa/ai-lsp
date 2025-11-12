import type { LanguageModel } from 'ai';

import {
  ModuleResolver,
  type FactoryModule,
  type ProviderFactory,
  type ProviderManifest,
  type ModelCost,
} from './module-resolver';
import type { Log } from '../util';
import { time } from '../util';

/**
 * Result of parsing a provider/model string.
 */
export type ParsedModel = {
  providerId: string;
  modelName: string;
};

/**
 * Parse provider and model name from a string like
 * "anthropic/claude-3-5-sonnet"
 */
export function parseModelString(modelStr: string): ParsedModel {
  const parts = modelStr.split('/');
  return {
    providerId: parts[0] ?? '',
    modelName: parts.slice(1).join('/'),
  };
}

/**
 * A ModelSelector maps a logical model name to a runtime
 * `LanguageModel` instance (or provider client wrapper).
 */
export type ModelSelector = (modelName: string) => LanguageModel;

/**
 * ProviderInitOptions allow callers to override provider metadata
 * discovered from the public index. This is useful for local testing
 * or when running behind custom endpoints.
 */
export interface ProviderInitOptions {
  /** custom npm package specifier */
  npm?: string;
  /** API key to pass to the provider factory */
  apiKey?: string;
  /** Optional base URL to override the manifest `api` field */
  baseURL?: string;
  /** HTTP headers to pass to the provider factory */
  headers?: Record<string, string>;
  /** Additional environment variable names to consult */
  env?: string[];
  /** Additional args to pass through to provider factory (e.g. for mocks) */
  [key: string]: unknown;
}

/**
 * ResolveOptions control how a provider is resolved and instantiated.
 */
export interface ResolveOptions {
  providerId: string;
  providers?: Record<string, ProviderInitOptions>;
  allowInstall?: boolean;
  log?: Log;
}

/**
 * ProviderRegistry is the primary entrypoint for obtaining a
 * `ModelSelector` for a given provider id. It handles:
 * - resolving provider manifests (via `ModuleResolver`)
 * - merging manifest data with user overrides
 * - dynamically loading provider npm packages (installing if needed)
 * - caching selectors to avoid repeated work
 */
export class ProviderRegistry {
  private moduleResolver = new ModuleResolver();
  private selectorCache: Map<string, ModelSelector> = new Map();

  async resolveManifest(providerId: string, log?: Log) {
    return this.moduleResolver.resolveManifest(providerId, log);
  }

  /**
   * Get the cost information for a specific model from the provider's
   * manifest. Returns undefined if cost data is unavailable.
   */
  async getModelCost(
    providerId: string,
    modelName: string,
    log?: Log,
  ): Promise<ModelCost | undefined> {
    const manifest = await this.resolveManifest(providerId, log);
    if (!manifest?.models) return undefined;

    const modelInfo = manifest.models[modelName];
    return modelInfo?.cost;
  }

  /**
   * Inspect an imported module to locate the provider factory function.
   * This supports multiple export styles:
   * - module itself is a function
   * - `default` export is a function
   * - a named export with a `create*` prefix (case-insensitive)
   */
  private getFactory(
    mod: FactoryModule,
    moduleSpecifier: string,
    log?: Log,
  ): ProviderFactory {
    if (!mod) {
      const msg = `Module '${moduleSpecifier}' is empty`;
      log?.('error', msg);
      throw new Error(msg);
    }

    if (typeof mod === 'function') return mod as ProviderFactory;

    if (mod.default && typeof mod.default === 'function') {
      return mod.default as ProviderFactory;
    }

    return mod[
      Object.keys(mod).find(key => key.startsWith('create'))!
    ] as ProviderFactory;
  }

  /**
   * Merge manifest and override options into a single ProviderManifest
   * object used for instantiation. The `override` values take
   * precedence over manifest values. Environment variable lists are
   * concatenated and deduplicated.
   */
  private mergeConfig(
    providerId: string,
    manifest: ProviderManifest | undefined,
    override: ProviderInitOptions | undefined,
  ): ProviderManifest {
    const mergedEnv = Array.from(
      new Set([...(override?.env ?? []), ...(manifest?.env ?? [])]),
    );

    return {
      id: providerId,
      env: mergedEnv,
      npm: override?.npm ?? manifest?.npm,
      api: override?.baseURL ?? manifest?.api,
      name: manifest?.name,
      models: manifest?.models,
    };
  }

  /**
   * Build a cache key for selector caching. The key is a JSON
   * stringification of the entire config to ensure all options
   * are captured, including provider-specific custom fields.
   */
  private buildCacheKey(
    providerId: string,
    config: ProviderManifest,
    allowInstall: boolean,
    override?: ProviderInitOptions,
  ): string {
    return JSON.stringify({
      providerId,
      config,
      allowInstall,
      override,
    });
  }

  /**
   * Create (or return a cached) `ModelSelector` for `providerId`.
   * This orchestrates manifest resolution, module loading, factory
   * detection, and provider client creation.
   */
  async createSelector(opts: ResolveOptions): Promise<ModelSelector> {
    const { providerId, providers, allowInstall = true, log } = opts;
    const override = providers?.[providerId];

    const manifest = await this.resolveManifest(providerId, log);
    if (!manifest && !override) {
      log?.('warn', `No provider entry found for '${providerId}'`);
      return (modelName: string) => modelName as LanguageModel;
    }

    const merged = this.mergeConfig(providerId, manifest, override);

    const cacheKey = this.buildCacheKey(
      providerId,
      merged,
      allowInstall,
      override,
    );
    if (this.selectorCache.has(cacheKey)) {
      log?.('info', `Using cached provider for key ${cacheKey}`);
      return this.selectorCache.get(cacheKey)!;
    }

    let moduleSpecifier = merged.npm;
    if (!moduleSpecifier) {
      const msg = `Provider '${providerId}' does not specify an npm package.`;
      log?.('error', msg);
      throw new Error(msg);
    }

    // Some providers expose a subpath for alternate implementations.
    // Historically `google-vertex-anthropic` requires the `/anthropic`
    // subpath; handle that special-case here.
    if (providerId === 'google-vertex-anthropic') {
      moduleSpecifier = `${moduleSpecifier}/anthropic`;
      log?.('info', `Using Anthropic subpath for ${providerId}`);
    }

    const mod = await this.moduleResolver.loadModule(
      moduleSpecifier as string,
      log,
      allowInstall,
    );
    if (!mod) {
      const msg = `Failed to load module '${moduleSpecifier}'`;
      log?.('error', msg);
      throw new Error(msg);
    }

    const factory = this.getFactory(mod, moduleSpecifier as string, log);

    const selector = this.createSelectorFromFactory(
      factory,
      providerId,
      merged,
      override,
      log,
    );

    this.selectorCache.set(cacheKey, selector);
    return selector;
  }

  /**
   * Determine extra options required for Google Vertex providers by
   * inspecting environment variables. If a `project` cannot be
   * determined the result is empty (no vertex-specific options).
   */
  private getVertexOptions(providerId: string, manifest: ProviderManifest) {
    if (!providerId.includes('google-vertex')) {
      return {};
    }

    const projectCandidates = [
      'GOOGLE_VERTEX_PROJECT',
      'GOOGLE_CLOUD_PROJECT',
      'GCP_PROJECT',
      'GCLOUD_PROJECT',
    ];
    const locationCandidates = [
      'GOOGLE_VERTEX_LOCATION',
      'GOOGLE_CLOUD_LOCATION',
      'VERTEX_LOCATION',
    ];

    const envList = manifest.env ?? [];

    const findEnv = (candidates: string[]) => {
      for (const name of candidates) {
        const value = process.env[name];
        if (value) return value;
      }
      for (const name of envList) {
        const value = process.env[name];
        if (value) return value;
      }
      return undefined;
    };

    const project = findEnv(projectCandidates);
    const location = findEnv(locationCandidates) ?? 'global';

    if (!project) return {};
    return { project, location };
  }

  /**
   * Build the runtime args passed to a provider factory. This gathers
   * API key, base URL, selected environment variables, headers, and
   * any provider-specific options (e.g. Vertex project/location, or
   * mock provider configuration).
   */
  private buildProviderArgs(
    providerId: string,
    merged: ProviderManifest,
    override?: ProviderInitOptions,
  ) {
    const envList = merged.env ?? [];
    const envMap: Record<string, string> = {};
    for (const name of envList) {
      const v = process.env[name];
      if (v) envMap[name] = v;
    }

    const firstEnvValue = envList
      .map(k => process.env[k])
      .filter(Boolean)
      .at(0);
    const apiKey = override?.apiKey ?? firstEnvValue ?? '';
    const baseURL = merged.api ?? undefined;

    const vertexOptions = this.getVertexOptions(providerId, merged);

    // Extract known fields and pass everything else through as-is
    const { npm: _npm, env: _env, ...extraOverrides } = override ?? {};

    return {
      apiKey,
      baseURL,
      env: envMap,
      ...vertexOptions,
      ...extraOverrides,
    };
  }

  /**
   * Given a provider factory function, call it with built args and
   * return a ModelSelector that uses the resulting client function.
   */
  private createSelectorFromFactory(
    factory: ProviderFactory,
    providerId: string,
    merged: ProviderManifest,
    override?: ProviderInitOptions,
    log?: Log,
  ): ModelSelector {
    using _ = log ? time(log, 'info', 'selector') : undefined;

    const args = this.buildProviderArgs(providerId, merged, override);

    log?.('debug', `provider factory args: ${JSON.stringify(args)}`);
    return factory(args);
  }

  /**
   * Clear cached selectors. If `key` is omitted the entire cache is
   * cleared, otherwise only the entry matching `key` is removed.
   */
  clearCache(key?: string) {
    if (!key) {
      this.selectorCache.clear();
      return;
    }
    this.selectorCache.delete(key);
  }
}

export const defaultRegistry = new ProviderRegistry();

export interface ProviderOptions {
  provider: string;
  log?: Log;
  allowInstall?: boolean;
  providers?: Record<string, ProviderInitOptions>;
}

/**
 * createProvider is a convenience wrapper around the default registry.
 */
export async function createProvider({
  provider,
  providers,
  allowInstall,
  log,
}: ProviderOptions): Promise<ModelSelector> {
  return defaultRegistry.createSelector({
    providerId: provider,
    providers,
    allowInstall,
    log,
  });
}

/**
 * clearProviderCache exposes a simple way to purge cached selectors.
 */
export function clearProviderCache(key?: string) {
  defaultRegistry.clearCache(key);
}

/**
 * getModelCostInfo is a convenience wrapper to fetch cost information
 * for a model from the default registry.
 */
export async function getModelCostInfo(
  providerId: string,
  modelName: string,
  log?: Log,
): Promise<ModelCost | undefined> {
  return defaultRegistry.getModelCost(providerId, modelName, log);
}
