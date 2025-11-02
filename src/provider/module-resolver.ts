/**
 * Module resolver and models.dev manifest helpers.
 *
 * This file centralizes two responsibilities:
 * - fetching the public `models.dev` index (used to lookup provider
 *   metadata such as npm package names and environment variables)
 * - dynamically importing provider npm packages, optionally
 *   installing them with `bun install` when missing
 */

import type { LanguageModel } from 'ai';
import { execSync } from 'child_process';

import type { Log } from '../util';

/**
 * ModelCost describes the pricing for a model in dollars per million tokens.
 * Includes input and output costs, with optional caching costs.
 */
export interface ModelCost {
  input: number; // dollars per million input tokens
  output: number; // dollars per million output tokens
  cache_read?: number; // dollars per million cache read tokens
  cache_write?: number; // dollars per million cache write tokens
}

/**
 * ModelInfo describes a model with its cost information.
 */
export interface ModelInfo {
  id: string;
  name?: string;
  cost?: ModelCost;
}

/**
 * ProviderManifest describes a provider entry as discovered from the
 * models.dev index. Fields are intentionally permissive because manifests
 * can vary between providers.
 */
export interface ProviderManifest {
  id: string;
  /** env var names the provider reads for credentials/keys */
  env?: string[];
  /** npm package specifier to import the provider factory from */
  npm?: string;
  /** optional base API URL */
  api?: string;
  /** human-friendly provider name */
  name?: string;
  /** model mapping: local name -> { id, name?, cost? } */
  models?: Record<string, ModelInfo>;
}

/**
 * FactoryModule represents the shape of an imported module that is
 * expected to export a provider factory function (either as default,
 * named `create*` function, or module itself being a function).
 */
export interface FactoryModule {
  [key: string]: unknown;
  default?: unknown;
}

/**
 * Provider factory runtime args passed when creating a provider client.
 */
export interface ProviderArgs {
  apiKey?: string;
  baseURL?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * A provider factory returns a function that maps a model name to a
 * `LanguageModel` instance (or equivalent runtime object).
 */
export type ProviderFactory = (
  args: ProviderArgs,
) => (modelName: string) => LanguageModel;

/**
 * A cached copy of the models.dev index. It is tri-state:
 * - `undefined`   => not yet fetched
 * - `null`        => fetch attempted but unavailable (error)
 * - object        => successful parsed index
 *
 * The cache prevents excessive network calls during a single process.
 */
let cachedModelsDevIndex: Record<string, ProviderManifest> | null | undefined;

/**
 * Fetch and cache the models.dev index. The index is used to resolve
 * provider metadata (npm package, env vars, etc.). Failures are
 * tolerated and return `null` so callers can fall back to overrides.
 */
async function fetchModelsDevIndex(log?: Log) {
  if (cachedModelsDevIndex !== undefined) return cachedModelsDevIndex;

  try {
    const res = await fetch('https://models.dev/api.json', {
      cache: 'no-store',
    });
    if (!res.ok) return (cachedModelsDevIndex = null);

    const json = (await res.json()) as Record<string, ProviderManifest>;
    return (cachedModelsDevIndex = json);
  } catch (err) {
    // Network failures are non-fatal; log for debugging and return `null`.
    log?.('debug', `models.dev fetch failed: ${String(err)}`);
    return (cachedModelsDevIndex = null);
  }
}

/**
 * ModuleResolver encapsulates logic for:
 * - resolving provider manifests from the public index
 * - dynamically importing provider npm packages (installing them
 *   automatically with `bun install` if missing and installs are allowed)
 *
 * This isolates side-effecting operations so callers can mock or stub it
 * during tests.
 */
export class ModuleResolver {
  /**
   * Resolve the provider manifest for `providerId` by consulting the
   * models.dev index. Returns `undefined` when no manifest is found or
   * the index is unavailable.
   */
  async resolveManifest(
    providerId: string,
    log?: Log,
  ): Promise<ProviderManifest | undefined> {
    const index = await fetchModelsDevIndex(log);
    if (!index) return undefined;
    if (!(providerId in index)) return undefined;
    return index[providerId] as ProviderManifest;
  }

  /**
   * Dynamically import a module identified by `moduleSpecifier`.
   * If the import fails and `allowInstall` is true the function will
   * attempt to install the package via `bun install <pkg>@latest` and
   * re-import. Returns the imported module or `null` on failure.
   */
  async loadModule(
    moduleSpecifier: string,
    log?: Log,
    allowInstall = true,
  ): Promise<FactoryModule | null> {
    if (!moduleSpecifier) {
      log?.('error', 'No module name provided to load');
      return null;
    }

    // First try a normal dynamic import. This will succeed when the
    // package is already installed or resolvable via node resolution.
    try {
      const mod = await import(moduleSpecifier);
      if (mod) return mod as FactoryModule;
    } catch (err) {
      // If installs are disabled, surface a warning and bail out.
      if (!allowInstall) {
        log?.(
          'warn',
          `Module ${moduleSpecifier} not present and installs are disabled`,
        );
        return null;
      }

      // Attempt to install the package and re-import. The install step
      // is performed with `bun install` which is the project's package
      // manager. Installation logs are streamed to the parent process.
      log?.('info', `Installing package ${moduleSpecifier}...`);
      try {
        execSync(`bun install ${moduleSpecifier}@latest`, {
          stdio: 'inherit',
        });
      } catch (installErr) {
        log?.(
          'error',
          `Failed to install ${moduleSpecifier}: ${String(installErr)}`,
        );
        return null;
      }

      // Try importing again after a successful install.
      const mod = await import(moduleSpecifier);
      if (mod) return mod as FactoryModule;
    }

    // If we reach here the import failed for reasons other than a
    // missing package (or the install didn't produce a usable module).
    log?.('error', `Failed to import module '${moduleSpecifier}'`);
    return null;
  }
}
