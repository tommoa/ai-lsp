import type { LanguageModel } from 'ai';
import { execSync } from 'child_process';
import type { Log } from '../util';
import { time } from '../util';
import { type Model, type Info, type Selector } from './model';
import {
  ProviderNotFoundError,
  NoProviderNpmError,
  ProviderPackageError,
} from './errors';

/**
 * Manifest describes a provider with its metadata and configuration.
 * This represents what we get from models.dev plus local defaults.
 */
export interface Manifest {
  id: string;
  npm: string;
  env?: string[];
  headers?: Record<string, string>;
  api: string;
  name: string;
  models: Record<string, Info>;
}

/**
 * Config represents provider configuration that can come from user
 * overrides. All fields are optional to support partial overrides.
 */
export interface Config {
  npm?: string;
  env?: string[];
  headers?: Record<string, string>;
  apiKey?: string;
  baseURL?: string;
  /**
   * Additional provider-specific options passed through to the provider
   * factory function (e.g., `project` and `location` for Google Vertex).
   */
  [key: string]: unknown;
}

/**
 * FactoryArgs are the runtime arguments passed to a provider factory
 * function. The key difference from Config is that env is transformed
 * from string[] to Record<string, string>, with each env var being resolved.
 */
export interface FactoryArgs {
  apiKey?: string;
  baseURL?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Factory is a function that returns a function that returns a LanguageModel
 * when given runtime args.
 */
export type Factory = (args: FactoryArgs) => (name: string) => LanguageModel;

/**
 * Result of parsing a model string like "anthropic/claude-3-5-sonnet".
 */
export interface ParsedModel {
  provider: string;
  modelName: string;
}

/**
 * Parse provider and model name from a string like
 * "anthropic/claude-3-5-sonnet".
 */
export function parseModelString(modelStr: string): ParsedModel {
  const parts = modelStr.split('/');
  return {
    provider: parts[0] ?? '',
    modelName: parts.slice(1).join('/'),
  };
}

/**
 * Create a Model.Selector for the given provider.
 * Handles:
 * - Resolving provider manifests from models.dev and local defaults
 * - Merging manifest data with user overrides
 * - Dynamically loading provider npm packages (installing if needed)
 */
export async function create(opts: {
  provider: string;
  providers?: Record<string, Config>;
  allowInstall?: boolean;
  log?: Log;
}): Promise<Selector> {
  const { provider, providers, allowInstall = true, log } = opts;
  using _ = log ? time(log, 'info', 'createProvider') : undefined;

  const override = providers?.[provider];
  const manifest = await resolveManifest(provider, log);
  if (!manifest && !override) {
    // If neither the manifest nor the override include any information about
    // this provider, then we should throw.
    throw new ProviderNotFoundError(provider);
  }

  const merged = mergeConfig(provider, manifest, override);

  let moduleSpecifier = merged.npm;
  if (!moduleSpecifier) {
    // If no package specifier was given for this provider, then we have no
    // way of figuring out how to make requests to the model. We should bail.
    //
    // NOTE(tommoa): Maybe we could default to `@ai-sdk/openai-compatible`?
    throw new NoProviderNpmError(provider);
  }

  if (provider === 'google-vertex-anthropic') {
    // Google Vertex Anthropic is actually in a subpath within the
    // `@ai-sdk/google-vertex` package, which we need to fixup here.
    moduleSpecifier = `${moduleSpecifier}/anthropic`;
    log?.('info', `Using Anthropic subpath for ${provider}`);
  }

  // Load the module for this provider.
  //
  // NOTE: This will throw if something goes wrong. We do not wrap in a
  // try/catch here so that the error bubbles up.
  const mod = await loadModule(moduleSpecifier, log, allowInstall);

  // Extract out the `createXXX()` function that is used for making the model
  // object.
  // If the user has given us a valid package, but the package does not
  // conform to the `@ai-sdk` format, then we'll throw here.
  const createFunc = Object.keys(mod).find(key => key.startsWith('create'));
  if (!createFunc) {
    throw new ProviderPackageError(
      moduleSpecifier,
      'The module loaded, but does not conform to the @ai-sdk format',
    );
  }
  const providerFactory = mod[createFunc] as Factory;

  // Get the arguments that we need to pass to initialise the provider.
  const args = buildFactoryArgs(provider, merged, override);

  // Generate a lambda that will select the model (including the info) based
  // on the modelName.
  const modelFunc = (modelName: string): Model => ({
    model: providerFactory(args)(modelName),
    info: merged.models[modelName],
  });

  return modelFunc;
}

/**
 * @internal
 * Reset the models.dev cache. Only for use in tests.
 */
export function __resetCache(): void {
  cachedModelsDevIndex = undefined;
}

// ============================================================================
// Internal Implementation
// ============================================================================

const DefaultManifest: Record<string, Manifest> = {
  // Ollama isn't included in models.dev, so we need to set it here.
  ollama: {
    id: 'ollama',
    env: ['OLLAMA_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: 'http://localhost:11434/v1',
    name: 'Ollama',
    models: {},
  },
  // The `mock` provider is used for testing.
  mock: {
    id: 'mock',
    env: [],
    npm: 'ai-lsp-mock-provider',
    api: '',
    name: 'Mock Provider',
    models: {},
  },
};

let cachedModelsDevIndex: Record<string, Manifest> | null | undefined;

async function fetchModelsDevIndex(
  log?: Log,
): Promise<Record<string, Manifest> | null> {
  if (cachedModelsDevIndex !== undefined) return cachedModelsDevIndex;

  try {
    const res = await fetch('https://models.dev/api.json', {
      cache: 'no-store',
    });
    if (!res.ok) return (cachedModelsDevIndex = null);

    const json = (await res.json()) as Record<string, Manifest>;
    return (cachedModelsDevIndex = json);
  } catch (err) {
    log?.('debug', `models.dev fetch failed: ${String(err)}`);
    return (cachedModelsDevIndex = null);
  }
}

async function resolveManifest(
  provider: string,
  log?: Log,
): Promise<Manifest | undefined> {
  const index = await fetchModelsDevIndex(log);

  const manifest = {
    ...DefaultManifest[provider],
    ...index?.[provider],
  };

  if (!manifest.id) return undefined;

  return manifest as Manifest;
}

/**
 * Attempt to import or install a module from a module specification.
 *
 * Throws: ProviderPackageError if importing fails for any reason.
 */
async function loadModule(
  moduleSpecifier: string,
  log?: Log,
  allowInstall = true,
): Promise<Record<string, unknown>> {
  // Try to import the module first
  try {
    // NOTE: We need to await here for the try/catch to fire.
    return (await import(moduleSpecifier)) as Record<string, unknown>;
  } catch {
    // If import failed and installs are disabled, bail out
    if (!allowInstall) {
      throw new ProviderPackageError(
        moduleSpecifier,
        'Module not present and installs are disabled.',
      );
    }

    // Attempt to install the package
    log?.('info', `Installing package ${moduleSpecifier}...`);
    try {
      execSync(`bun install ${moduleSpecifier}@latest`, {
        stdio: 'inherit',
      });
    } catch (installErr) {
      throw new ProviderPackageError(
        moduleSpecifier,
        `Failed to install: ${String(installErr)}`,
      );
    }

    // Try importing again after installation. If this doesn't work, we'll get
    // the generic Bun import error.
    return import(moduleSpecifier) as Promise<Record<string, unknown>>;
  }
}

/**
 * Merge two configurations from a provider together, from a base to an
 * override.
 */
function mergeConfig(
  provider: string,
  manifest: Manifest | undefined,
  override: Config | undefined,
): Manifest {
  const mergedEnv = Array.from(
    new Set([...(override?.env ?? []), ...(manifest?.env ?? [])]),
  );

  return {
    ...manifest,
    id: provider,
    env: mergedEnv,
    ...(override?.npm && { npm: override.npm }),
    ...(override?.baseURL && { api: override.baseURL }),
    ...(override?.headers && { headers: override.headers }),
  } as Manifest;
}

/**
 * Get the required extra arguments for initialising the Google Vertex provider
 * (which also requires a project and location).
 */
function getVertexOptions(provider: string): Record<string, string> {
  if (!provider.includes('google-vertex')) return {};

  const findEnv = (candidates: string[]) =>
    candidates.map(name => process.env[name]).find(Boolean);

  // For some reason, not all of these potential env vars are in `models.dev`.
  // As of 2025-11-15 only the following are there (in order):
  //   project:
  //     GOOGLE_VERTEX_PROJECT
  //   location:
  //     GOOGLE_VERTEX_LOCATION
  //   credentials:
  //     GOOGLE_APPLICATION_CREDENTIALS
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

  const project = findEnv(projectCandidates);
  if (!project) return {};

  return {
    project,
    location: findEnv(locationCandidates) ?? 'global',
  };
}

/**
 * Generate the arguments required to initialise the provider.
 */
function buildFactoryArgs(
  provider: string,
  merged: Manifest,
  override?: Config,
): FactoryArgs {
  // `models.dev` includes a list of environment variables that may need to be
  // passed to the provider (such as the API key). We grab all the environment
  // variables, but if there is more than one, only the first is passed as the
  // API key.
  //
  // tommoa: Do we need to be a bit smarter about this? Are there any patterns
  // when there are multiple environment variables that we could use for other
  // multi-env providers?
  const envList = merged.env ?? [];
  const envMap: Record<string, string> = {};
  for (const name of envList) {
    const v = process.env[name];
    if (v) envMap[name] = v;
  }

  const apiKey = override?.apiKey ?? Object.values(envMap)[0] ?? '';
  const baseURL = merged.api; // baseURL is called `api` by `models.dev`.

  // Some providers (in this case only Google Vertex) need some extra handling
  // for the extra environment variables.
  //
  // TODO: Do this extra dance in a nice way for other multi-env providers (such
  // as Bedrock).
  const vertexOptions = getVertexOptions(provider);

  // The user may have given us some extra arguments to pass, so extract them
  // from the user config.
  const { npm: _npm, env: _env, ...additionalArgs } = override ?? {};

  return {
    apiKey,
    baseURL,
    env: envMap,
    ...vertexOptions,
    ...additionalArgs,
  };
}
