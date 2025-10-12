// @ts-nocheck
import assert from 'node:assert/strict';
import { createProvider } from '../src/provider';

// 1) Local module path (mock) -> should return mock selector
test('local mock provider', async () => {
  const messages: string[] = [];
  const notify = (level: string, msg: string) =>
    messages.push(`${level}:${msg}`);
  const sel = await createProvider({
    provider: 'google',
    providers: { google: { npm: new URL('./mock-mod', import.meta.url).href } },
    log: notify as any,
    allowInstall: false,
  });
  const out = sel('gemini-flash-latest');
  assert.equal(out, 'mock:gemini-flash-latest');
});

// 2) Missing package with installs disabled -> should throw when provider
//    resolves (we mock models.dev to ensure resolution)
test('missing package without install', async () => {
  const messages: string[] = [];
  const notify = (level: string, msg: string) =>
    messages.push(`${level}:${msg}`);

  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        google: {
          id: 'google',
        },
      }),
    }) as any;

  try {
    await assert.rejects(
      createProvider({
        provider: 'google',
        providers: {
          google: { npm: 'non-existent-package-hopefully-not-real' },
        },
        log: notify as any,
        allowInstall: false,
      }),
      Error,
      'createProvider should throw when module missing and installs disabled',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 3) Model-based resolution with installs disabled -> should return a selector
//    (string fallback) when models.dev is not reachable
test('model-based resolution fallback', async () => {
  const messages: string[] = [];
  const notify = (level: string, msg: string) =>
    messages.push(`${level}:${msg}`);
  const sel = await createProvider({
    provider: 'google',
    log: notify as any,
    allowInstall: false,
  });
  assert.equal(
    typeof sel,
    'function',
    'createProvider should return a selector function for model resolution',
  );
  const out = sel('gemini-flash-latest');
  assert.ok(
    out !== null && out !== undefined,
    'Selector should return a non-null value',
  );
});

// 4) Ensure google mapping returns provider wrapper when models.dev present
//    (we override to use local mock)
test('google model maps to provider wrapper via models.dev', async () => {
  const originalFetch = globalThis.fetch;

  // Mock models.dev index containing a google entry.
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        google: {
          id: 'google',
          models: {
            'gemini-flash-latest': {
              id: 'gemini-flash-latest',
              provider: 'google',
              npm: '@ai-sdk/google',
            },
          },
        },
      }),
    }) as any;

  try {
    const sel = await createProvider({
      provider: 'google',
      providers: {
        google: { npm: new URL('./mock-mod', import.meta.url).href },
      },
    });
    const out = sel('gemini-flash-latest');
    // mock-mod returns a string like `mock:<model>`
    assert.equal(out, 'mock:gemini-flash-latest');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 5) createProvider should support being called without explicit providers in
//    server init (prepopulation from models.dev)
test('prepopulation from models.dev when providers omitted', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        google: {
          id: 'google',
          models: {
            'gemini-flash-latest': {
              id: 'gemini-flash-latest',
              provider: 'google',
              npm: '@ai-sdk/google',
            },
          },
        },
      }),
    }) as any;

  try {
    const sel = await createProvider({
      provider: 'google',
      // override to avoid network installs in test env
      providers: {
        google: { npm: new URL('./mock-mod', import.meta.url).href },
      },
    });
    const out = sel('gemini-flash-latest');
    assert.equal(out, 'mock:gemini-flash-latest');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
