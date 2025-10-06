// TODO: Make APIs other than Google's work, and see if we can simplify the
// interfaces here.
import { LanguageModel } from 'ai';
import { execSync } from 'child_process';

export type ModelSelector = (modelName: string) => LanguageModel;

export interface ProviderOptions {
  provider: string;
  notify?: (level: 'info' | 'warn' | 'error', message: string) => void;
  allowInstall?: boolean;
  providers?: Record<string, ProviderInitOptions>;
}

export interface ProviderInitOptions {
  npm?: string;
  apiKey?: string;
  baseUrl?: string;
}

interface Model {
  id: string;
  name: string;
}

interface Provider {
  id: string;
  env: Array<string>;
  npm?: string;
  api?: string;
  name?: string;
  models?: Record<string, Model>;
}

// Cache the models.dev index so we don't repeatedly fetch it.
let cachedModelsDevIndex: Record<string, Provider> | null | undefined;

async function installAndImport(
  moduleName: string,
  notify?: (level: 'info' | 'warn' | 'error', message: string) => void,
  allowInstall = true,
): Promise<any | null> {
  if (!moduleName) {
    notify?.('error', 'No module name provided to installAndImport');
    return null;
  }

  try {
    return await import(moduleName);
  } catch (err) {
    if (!allowInstall) {
      notify?.(
        'warn',
        `Module ${moduleName} not present and installs are disabled`,
      );
      return null;
    }

    notify?.('info', `Installing package ${moduleName}...`);
    try {
      execSync(`bun install ${moduleName}`, { stdio: 'inherit' });
    } catch (installErr) {
      notify?.(
        'error',
        `Failed to install ${moduleName}: ${String(installErr)}`,
      );
      return null;
    }

    try {
      return await import(moduleName);
    } catch (importErr) {
      notify?.(
        'error',
        `Failed to import ${moduleName} after install: ${String(importErr)}`,
      );
      return null;
    }
  }
}

export async function fetchModelsDevIndex(): Promise<Record<
  string,
  Provider
> | null> {
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

/**
 * Return the models.dev entry for a given model id (or undefined).
 * This supports common shapes where the index is organized by provider
 * with a `models` map, but will also attempt a general graph search.
 */
export async function resolveModelEntryFromModelsDev(
  modelId: string,
): Promise<Model | undefined> {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const parts = modelId.split('/', 2).filter(Boolean);
  if (parts.length < 2) return undefined;

  const providerId = parts[0] as string;
  const modelKey = parts[1] as string;

  const index = await resolveProvider(providerId);
  if (!index) return undefined;

  const modelsMap = index.models;
  if (!modelsMap || typeof modelsMap !== 'object') return undefined;

  const entry = modelsMap[modelKey];
  if (!entry || typeof entry !== 'object') return undefined;
  return entry;
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
  if (!mod || typeof mod !== 'object') return undefined;

  const preferred = [
    'createOpenAI',
    'createAnthropic',
    'createClient',
    'createProvider',
    'create',
    'default',
  ];

  for (const name of preferred) {
    if (typeof mod[name] === 'function') return mod[name] as Function;
  }

  // Look for any exported function whose key or name starts with "create"
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value === 'function' && key.toLowerCase().startsWith('create'))
      return value as Function;
    const fnName = (value as any)?.name;
    if (typeof fnName === 'string' && /^create/i.test(fnName))
      return value as Function;
  }

  return undefined;
}

function createSelectorFromFactory(
  factory: Function | undefined,
  opts?: ProviderInitOptions,
  provider?: Provider,
  notify?: (level: 'info' | 'warn' | 'error', message: string) => void,
): ModelSelector {
  try {
    const apiKey = opts?.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    const baseURL = opts?.baseUrl ?? provider?.api;
    // If factory is not a function this will throw and we fall back below.
    // Some provider modules export different shapes; fall back to returning
    // the model name when creation fails.
    const client = (factory as Function)({ apiKey, baseURL });
    return (modelName: string) => client(modelName);
  } catch (err) {
    // Fallback selector: return the model name string so callers can still
    // use the selector even when the provider factory isn't available.
    notify?.('warn', `Provider factory failed: ${String(err)}`);
    return (modelName: string) => modelName as any;
  }
}

const providerCache: Map<string, ModelSelector> = new Map();

export async function createProvider(
  opts: ProviderOptions,
): Promise<ModelSelector> {
  const provider = opts.provider;
  const providerOptions = opts.providers?.[provider];

  const modelProvider = await resolveProvider(provider);
  if (!modelProvider) {
    // TODO: Allow arbitrary providers that are not in models.dev.
    opts.notify?.(
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
    opts.notify?.('info', `Using cached provider for key ${cacheKey}`);
    return providerCache.get(cacheKey)!;
  }

  if (!npmModule) {
    const msg =
      `Provider '${provider}' does not specify an npm package. ` +
      `Set \'providerModule\' in options or update the models.dev index.`;
    opts.notify?.('error', msg);
    throw new Error(msg);
  }

  const mod = await installAndImport(
    npmModule as string,
    opts.notify,
    opts.allowInstall ?? true,
  );

  if (!mod) {
    const msg = `Failed to load module '${npmModule}' for provider \
'${provider}'`;
    opts.notify?.('error', msg);
    throw new Error(msg);
  }

  const factory = findFactory(mod);
  if (!factory) {
    const msg = `No factory function found in module '${npmModule}'`;
    opts.notify?.('error', msg);
    throw new Error(msg);
  }

  let selector: ModelSelector;
  try {
    selector = createSelectorFromFactory(
      factory,
      providerOptions!,
      modelProvider,
      opts.notify,
    );
  } catch (err) {
    const msg = `Error creating provider from '${npmModule}': ${String(err)}`;
    opts.notify?.('error', msg);
    throw new Error(msg);
  }

  providerCache.set(cacheKey, selector);
  return selector;
}
