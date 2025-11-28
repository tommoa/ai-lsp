import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { LSPTestClient } from './helpers/lsp-test-client';
import { createTestClient } from './helpers/lsp-test-client';
import { pos, setupTestDocument } from './helpers/test-utils';
import { mockResponses } from '../helpers/mock-responses';

describe('E2E: Configuration Changes', () => {
  let client: LSPTestClient;

  beforeEach(async () => {
    client = createTestClient({
      debug: false,
      timeout: 10000,
    });

    await client.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.prefixSuffix(),
          },
        },
        model: 'mock/test-model',
        next_edit: {
          prompt: 'prefix-suffix',
        },
      },
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  it('should handle configuration change for next_edit mode', async () => {
    // First, verify prefix-suffix mode works
    const uri1 = await setupTestDocument(
      client,
      'function test() {\n  // TODO: implement\n}',
    );

    const result1 = await client.requestNextEdit(uri1, pos(1, 2));
    expect(result1.edits).toBeArray();
    expect(result1.edits.length).toBeGreaterThan(0);

    // Change configuration to line-number mode
    await client.changeConfiguration({
      providers: {
        mock: {
          npm: 'ai-lsp-mock-provider',
          response: mockResponses.lineNumber(),
        },
      },
      model: 'mock/test-model',
      next_edit: {
        prompt: 'line-number',
      },
    });

    // Wait a bit for config to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify line-number mode now works
    const uri2 = await setupTestDocument(
      client,
      'function test() {\n  // TODO: implement\n}',
    );

    const result2 = await client.requestNextEdit(uri2, pos(1, 2));
    expect(result2.edits).toBeArray();
    expect(result2.edits.length).toBeGreaterThan(0);
  });

  it('should continue working after config change', async () => {
    const uri = await setupTestDocument(client, 'const x');

    // Get initial completions
    const completions1 = await client.requestCompletion(uri, pos(0, 7));
    expect(completions1).toBeArray();
    expect(completions1.length).toBeGreaterThan(0);

    // Change configuration (same model, just verify it doesn't break)
    await client.changeConfiguration({
      providers: {
        mock: {
          npm: 'ai-lsp-mock-provider',
          response: mockResponses.inline(),
        },
      },
      model: 'mock/test-model',
    });

    // Wait a bit for config to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get completions again - should still work
    const completions2 = await client.requestCompletion(uri, pos(0, 7));
    expect(completions2).toBeArray();
    expect(completions2.length).toBeGreaterThan(0);
  });
});
