import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import {
  createProvider,
  clearProviderCache,
  parseModelString,
} from '../src/provider/provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderCache();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('parseModelString', () => {
  it('should parse provider/model format', () => {
    const result = parseModelString('anthropic/claude-3-5-sonnet');
    expect(result.providerId).toBe('anthropic');
    expect(result.modelName).toBe('claude-3-5-sonnet');
  });

  it('should handle model names with slashes', () => {
    const result = parseModelString('openai/gpt-4/turbo');
    expect(result.providerId).toBe('openai');
    expect(result.modelName).toBe('gpt-4/turbo');
  });

  it('should handle single part as provider', () => {
    const result = parseModelString('google');
    expect(result.providerId).toBe('google');
    expect(result.modelName).toBe('');
  });

  it('should handle empty string', () => {
    const result = parseModelString('');
    expect(result.providerId).toBe('');
    expect(result.modelName).toBe('');
  });

  it('should handle multiple slashes', () => {
    const result = parseModelString('provider/model/variant/version');
    expect(result.providerId).toBe('provider');
    expect(result.modelName).toBe('model/variant/version');
  });
});

describe('createProvider', () => {
  it('should return selector function when models.dev available', async () => {
    (globalThis as any).fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          google: {
            id: 'google',
            npm: '@ai-sdk/google',
            env: ['GOOGLE_API_KEY'],
          },
        }),
      }) as any;

    const sel = await createProvider({
      provider: 'google',
      allowInstall: false,
    });

    expect(typeof sel).toBe('function');
    expect(sel('gemini-flash-latest')).toBeDefined();
  });

  it('should fallback when models.dev unavailable', async () => {
    const messages: string[] = [];
    const notify = (level: string, msg: string) =>
      messages.push(`${level}:${msg}`);

    (globalThis as any).fetch = async () =>
      ({
        ok: false,
        status: 500,
      }) as any;

    const sel = await createProvider({
      provider: 'google',
      log: notify as any,
      allowInstall: false,
    });

    expect(typeof sel).toBe('function');
    expect(sel('gemini-flash-latest')).toBeDefined();
  });

  it('should support provider config overrides (npm, apiKey, baseURL)', async () => {
    // Test npm override
    const sel1 = await createProvider({
      provider: 'google',
      providers: {
        google: { npm: '@ai-sdk/openai' },
      },
      allowInstall: false,
    });
    expect(typeof sel1).toBe('function');

    // Test apiKey override
    const sel2 = await createProvider({
      provider: 'anthropic',
      providers: {
        anthropic: {
          npm: '@ai-sdk/anthropic',
          apiKey: 'test-key-123',
        },
      },
      allowInstall: false,
    });
    expect(typeof sel2).toBe('function');

    // Test baseURL override
    const sel3 = await createProvider({
      provider: 'openai',
      providers: {
        openai: {
          npm: '@ai-sdk/openai',
          baseURL: 'https://custom-endpoint.com',
        },
      },
      allowInstall: false,
    });
    expect(typeof sel3).toBe('function');
  });

  it('should cache provider selectors', async () => {
    const sel1 = await createProvider({
      provider: 'google',
      providers: {
        google: { npm: '@ai-sdk/google' },
      },
      allowInstall: false,
    });

    const sel2 = await createProvider({
      provider: 'google',
      providers: {
        google: { npm: '@ai-sdk/google' },
      },
      allowInstall: false,
    });

    // Should return same cached selector
    expect(sel1).toBe(sel2);
  });

  it('should handle network errors gracefully', async () => {
    (globalThis as any).fetch = async () => {
      throw new Error('Network error');
    };

    const sel = await createProvider({
      provider: 'google',
      allowInstall: false,
    });

    // Should still return a function (fallback)
    expect(typeof sel).toBe('function');
  });
});

describe('clearProviderCache', () => {
  it('should clear cached providers', async () => {
    const sel1 = await createProvider({
      provider: 'google',
      providers: {
        google: { npm: '@ai-sdk/google' },
      },
      allowInstall: false,
    });

    clearProviderCache();

    const sel2 = await createProvider({
      provider: 'google',
      providers: {
        google: { npm: '@ai-sdk/google' },
      },
      allowInstall: false,
    });

    // After cache clear, should create new selector instance
    expect(sel1).not.toBe(sel2);
  });
});
