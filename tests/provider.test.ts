// @ts-nocheck
import assert from 'node:assert/strict';
import { createProvider, clearProviderCache } from '../src/provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderCache();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('resolution fallback when models.dev unavailable', async () => {
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
  assert.equal(
    typeof sel,
    'function',
    'createProvider should return a selector function',
  );
  const out = sel('gemini-flash-latest');
  assert.ok(
    out !== null && out !== undefined,
    'Selector should return a non-null value',
  );
});

test('npm override allows using different package', async () => {
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        google: {
          id: 'google',
          npm: '@ai-sdk/google',
        },
      }),
    }) as any;

  const sel = await createProvider({
    provider: 'google',
    providers: {
      google: { npm: '@ai-sdk/openai' },
    },
    allowInstall: false,
  });

  assert.equal(typeof sel, 'function');
});
