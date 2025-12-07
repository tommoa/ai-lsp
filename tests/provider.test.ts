import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import {
  parseModelString,
  create as createProvider,
  __resetCache,
} from '../src/provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetCache();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('parseModelString', () => {
  it('should parse provider/model format', () => {
    const result = parseModelString('anthropic/claude-3-5-sonnet');
    expect(result.provider).toBe('anthropic');
    expect(result.modelName).toBe('claude-3-5-sonnet');
  });

  it('should handle model names with slashes', () => {
    const result = parseModelString('openai/gpt-4/turbo');
    expect(result.provider).toBe('openai');
    expect(result.modelName).toBe('gpt-4/turbo');
  });

  it('should handle single part as provider', () => {
    const result = parseModelString('google');
    expect(result.provider).toBe('google');
    expect(result.modelName).toBe('');
  });

  it('should handle empty string', () => {
    const result = parseModelString('');
    expect(result.provider).toBe('');
    expect(result.modelName).toBe('');
  });

  it('should handle multiple slashes', () => {
    const result = parseModelString('provider/model/variant/version');
    expect(result.provider).toBe('provider');
    expect(result.modelName).toBe('model/variant/version');
  });
});

describe('createProvider', () => {
  it('should load provider using models.dev manifest', async () => {
    // Mock models.dev to return manifest for mock provider
    (globalThis as any).fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          mock: {
            id: 'mock',
            npm: 'ai-lsp-mock-provider',
            env: ['MOCK_API_KEY'],
          },
        }),
      }) as any;

    // Should successfully load using only models.dev data + defaults
    const sel = await createProvider({
      provider: 'mock',
      allowInstall: false,
    });

    expect(typeof sel).toBe('function');
    expect(sel('test-model')).toBeDefined();
  });

  it('should fallback when models.dev unavailable', async () => {
    const messages: string[] = [];
    const notify = (level: any, msg: string) =>
      messages.push(`${level}:${msg}`);

    (globalThis as any).fetch = async () =>
      ({
        ok: false,
        status: 500,
      }) as any;

    const sel = await createProvider({
      provider: 'mock',
      providers: {
        mock: { response: 'test response' },
      },
      log: notify as any,
      allowInstall: false,
    });

    expect(typeof sel).toBe('function');
    expect(sel('test-model')).toBeDefined();
  });

  it('should use a subpath for google-vertex-anthropic', async () => {
    const messages: string[] = [];
    const notify = (level: string, msg: string) =>
      messages.push(`${level}:${msg}`);

    try {
      // If the package is installed, this should succeed and use the subpath
      const sel1 = await createProvider({
        provider: 'google-vertex-anthropic',
        log: notify as any,
        allowInstall: false,
      });
      expect(typeof sel1).toBe('function');
    } catch (err) {
      // If the package is not installed, we should get a ProviderPackageError
      // This is acceptable behavior when the package isn't available
      const { ProviderPackageError } = await import('../src/provider');
      expect(err).toBeInstanceOf(ProviderPackageError);
      expect((err as Error).message).toContain(
        '@ai-sdk/google-vertex/anthropic',
      );
      expect((err as Error).message).toContain(
        'Module not present and installs are disabled',
      );
    }

    // Ensure the log message about using the subpath was emitted regardless
    expect(messages).toContainEqual(
      'info:Using Anthropic subpath for google-vertex-anthropic',
    );
  });

  it('should support provider config overrides', async () => {
    // Test npm override - use mock provider for all
    const sel1 = await createProvider({
      provider: 'test1',
      providers: {
        test1: { npm: 'ai-lsp-mock-provider', response: 'test1 response' },
      },
      allowInstall: false,
    });
    expect(typeof sel1).toBe('function');

    // Test apiKey override
    const sel2 = await createProvider({
      provider: 'test2',
      providers: {
        test2: {
          npm: 'ai-lsp-mock-provider',
          apiKey: 'test-key-123',
          response: 'test2 response',
        },
      },
      allowInstall: false,
    });
    expect(typeof sel2).toBe('function');

    // Test baseURL override
    const sel3 = await createProvider({
      provider: 'test3',
      providers: {
        test3: {
          npm: 'ai-lsp-mock-provider',
          baseURL: 'https://custom-endpoint.com',
          response: 'test3 response',
        },
      },
      allowInstall: false,
    });
    expect(typeof sel3).toBe('function');
  });

  it('should handle network errors gracefully', async () => {
    (globalThis as any).fetch = async () => {
      throw new Error('Network error');
    };

    const sel = await createProvider({
      provider: 'mock',
      providers: {
        mock: { response: 'test response' },
      },
      log: (level: any, message: string) => console.log(level, message),
      allowInstall: false,
    });

    // Should still return a function (fallback)
    expect(typeof sel).toBe('function');
  });

  it('should throw if the provider is ill-defined', async () => {
    // Provider with no definitions.
    expect(
      createProvider({
        provider: 'fake',
        allowInstall: false,
      }),
    ).rejects.toThrow('Provider not found: fake');
    // Provider with a definition but no npm package.
    expect(
      createProvider({
        provider: 'fake',
        providers: {
          fake: {},
        },
        allowInstall: false,
      }),
    ).rejects.toThrow('No npm package found for provider: fake');
    // Provider with a definition and npm package, but the package can't be
    // installed.
    expect(
      createProvider({
        provider: 'fake',
        providers: {
          fake: {
            npm: '@ai-sdk/fake',
          },
        },
        allowInstall: false,
      }),
    ).rejects.toThrow('Module not present and installs are disabled.');
    // Provider with a definition and npm package, but the package doesn't
    // exist.
    expect(
      createProvider({
        provider: 'fake',
        providers: {
          fake: {
            npm: '@ai-sdk/fake',
          },
        },
        allowInstall: true,
      }),
    ).rejects.toThrow('Command failed: bun install @ai-sdk/fake@latest');
  });

  it('should throw when provider package has no @ai-sdk api', async () => {
    // Provider package exists but doesn't export a createXXX function
    expect(
      createProvider({
        provider: 'bad',
        providers: {
          bad: {
            npm: 'ai-lsp-bad-mock-provider',
          },
        },
        allowInstall: false,
      }),
    ).rejects.toThrow('does not conform to the @ai-sdk format');
  });
});
