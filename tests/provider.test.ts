// @ts-nocheck
import assert from 'node:assert/strict';
import { createProvider } from '../provider';

// 1) Local module path (mock) -> should return mock selector
test('local mock provider', async () => {
  const messages: string[] = [];
  const notify = (level: string, msg: string) =>
    messages.push(`${level}:${msg}`);
  const sel = await createProvider({
    provider: 'google/gemini-flash-latest',
    npm: './tests/mock-mod.ts',
    notify: notify as any,
    allowInstall: false,
  });
  const out = sel('gemini-flash-latest');
  assert.equal(out, 'mock:gemini-flash-latest');
});

// 2) Missing package with installs disabled -> should return a selector that
//    yields a string
test('missing package without install', async () => {
  const messages: string[] = [];
  const notify = (level: string, msg: string) =>
    messages.push(`${level}:${msg}`);
  await assert.rejects(
    createProvider({
      provider: 'google/gemini-flash-latest',
      npm: 'non-existent-package-hopefully-not-real',
      notify: notify as any,
      allowInstall: false,
    }),
    Error,
    'createProvider should throw when module missing and installs disabled',
  );
});

// 3) Model-based resolution with installs disabled -> should return a selector
//   (string fallback)
test('model-based resolution fallback', async () => {
  const messages: string[] = [];
  const notify = (level: string, msg: string) =>
    messages.push(`${level}:${msg}`);
  const sel = await createProvider({
    provider: 'google/gemini-flash-latest',
    notify: notify as any,
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
test('google model maps to provider wrapper via models.dev', async () => {
  const originalFetch = globalThis.fetch;

  // Mock models.dev index response containing an entry under `google.models`
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        google: {
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
      provider: 'google/gemini-flash-latest',
    });
    const out = sel('google/gemini-flash-latest');

    // Expect a provider wrapper object so the `ai` frontend can route properly
    assert.ok(out && (out as any).modelId === 'google/gemini-flash-latest');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 5) createProvider should support being called without explicit providers in
//    server init
// Simulate server initialization that omits `providers` but includes a plain
// `model`.
test('prepopulation from models.dev when providers omitted', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        google: {
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
      provider: 'google/gemini-flash-latest',
    });
    const out = sel('google/gemini-flash-latest');

    // Expect a provider wrapper object so the `ai` frontend can route
    // properly
    assert.ok(out && (out as any).modelId === 'google/gemini-flash-latest');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
