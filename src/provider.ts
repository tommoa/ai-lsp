// TODO: Simplify the interface here.
// From the perspective of all of the other functions, we only care about
// pulling a provider LanguageModel creation function out of a given package,
// when given the following inputs:
// -- @param provider: string (The provider identifier)
// -- @param providers: Record<string, ProviderInitOptions> (the user-configured
//              providers)
//
// We can also see the environment variables, which may contain the API keys for
// a given provider.
import { type LanguageModel } from 'ai';
import { execSync } from 'child_process';

import { Log, time } from './util';

export type ModelSelector = (modelName: string) => LanguageModel;

export interface ProviderInitOptions {
  npm?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

interface ProviderOptions {
  provider: string;
  log?: Log;
  allowInstall?: boolean;
  providers?: Record<string, ProviderInitOptions>;
}

interface Model {
  id: string;
  name: string;
}

interface Provider {
  id: string;
  env: string[];
  npm: string;
  api: string;
  name?: string;
  models?: Record<string, Model>;
}

// Cache the models.dev index so we don't repeatedly fetch it.
let cachedModelsDevIndex: Record<string, Provider> | null | undefined;

// Install and import a given module name.
async function installAndImport(
  moduleName: string,
  log?: Log,
  allowInstall = true,
): Promise<any> {
  if (!moduleName) {
    log?.('error', 'No module name provided to installAndImport');
    return null;
  }

  // 1) Try the specifier as provided. If the dynamic import fails we
  //    either return null (when installs disallowed) or attempt an
  //    install and re-import.
  try {
    const mod = await import(moduleName);
    if (mod) return mod;
  } catch (err) {
    // If installs aren't allowed, return null so callers can decide.
    if (!allowInstall) {
      log?.(
        'warn',
        `Module ${moduleName} not present and installs are disabled`,
      );
      return null;
    }

    // Otherwise attempt to install and re-import below.
    log?.('info', `Installing package ${moduleName}...`);
    try {
      execSync(`bun install ${moduleName}@latest`, { stdio: 'inherit' });
    } catch (installErr) {
      log?.('error', `Failed to install ${moduleName}: ${String(installErr)}`);
      return null;
    }

    // Try importing again after install. Let any error bubble up so the
    // caller sees a deterministic failure instead of a null module.
    const mod = await import(moduleName);
    if (mod) return mod;
  }

  // If we reach here, importing failed (unexpectedly).
  log?.('error', `Failed to import module '${moduleName}'`);
  return null;
}

async function fetchModelsDevIndex(): Promise<Record<string, Provider> | null> {
  if (cachedModelsDevIndex !== undefined) return cachedModelsDevIndex;

  try {
    const res = await fetch('https://models.dev/api.json', {
      cache: 'no-store',
    });
    if (!res.ok) return (cachedModelsDevIndex = null);
    const json = (await res.json()) as Record<string, Provider>;
    return (cachedModelsDevIndex = json);
  } catch {
    return (cachedModelsDevIndex = null);
  }
}

async function resolveProvider(
  provider: string,
): Promise<Provider | undefined> {
  const index = await fetchModelsDevIndex();
  if (!index) return undefined;
  if (!(provider in index)) return undefined;
  return index[provider];
}

function findFactory(mod: any): Function | undefined {
  if (!mod) return undefined;
  // If module default-exports a function or module itself is a function.
  if (typeof mod === 'function') return mod;
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value === 'function' && key.toLowerCase().startsWith('create'))
      return value as Function;
  }
  return undefined;
}

function createSelectorFromFactory(
  factory: Function | undefined,
  opts?: ProviderInitOptions,
  provider?: Provider,
  log?: Log,
): ModelSelector {
  using _ = time(log!, 'info', 'selector');
  let envKey = provider?.env
    .map(env => process.env[env])
    .filter(Boolean)
    .at(0);
  const apiKey = opts?.apiKey ?? envKey ?? '';
  const baseURL = opts?.baseURL ?? provider?.api;
  // If factory is not a function this will throw and we fall back below.
  // Some provider modules export different shapes; fall back to returning
  // the model name when creation fails.
  const client = (factory as Function)({ apiKey, baseURL });
  return (modelName: string) => client(modelName);
}

const providerCache: Map<string, ModelSelector> = new Map();

export async function createProvider(
  opts: ProviderOptions,
): Promise<ModelSelector> {
  const provider = opts.provider;
  const providerOptions = opts.providers?.[provider];

  const modelProvider: Provider | undefined = await resolveProvider(provider);
  if (!modelProvider) {
    // TODO: Allow arbitrary providers that are not in models.dev.
    opts.log?.(
      'warn',
      `No provider entry found for '${provider}' in models.dev`,
    );
    const fallback = ((modelName: string) => modelName as any) as ModelSelector;
    return fallback;
  }

  const npmModule = providerOptions?.npm ?? modelProvider.npm;
  // Use a stable cache key including whether installs are allowed.
  const cacheKey = `${npmModule ?? provider ?? 'default'}:install=${Boolean(
    opts.allowInstall,
  )}`;

  if (providerCache.has(cacheKey)) {
    opts.log?.('info', `Using cached provider for key ${cacheKey}`);
    return providerCache.get(cacheKey)!;
  }

  if (!npmModule) {
    const msg =
      `Provider '${provider}' does not specify an npm package. ` +
      `Set \'providerModule\' in options or update the models.dev index.`;
    opts.log?.('error', msg);
    throw new Error(msg);
  }

  const mod = await installAndImport(
    npmModule as string,
    opts.log,
    opts.allowInstall ?? true,
  );

  const factory = findFactory(mod);
  if (!factory) {
    const msg = `No factory function found in module '${npmModule}'`;
    opts.log?.('error', msg);
    throw new Error(msg);
  }

  let selector: ModelSelector;
  try {
    selector = createSelectorFromFactory(
      factory,
      providerOptions!,
      modelProvider,
      opts.log,
    );
  } catch (err) {
    const msg = `Error creating provider from '${npmModule}': ${String(err)}`;
    opts.log?.('error', msg);
    throw new Error(msg);
  }

  providerCache.set(cacheKey, selector);
  return selector;
}
