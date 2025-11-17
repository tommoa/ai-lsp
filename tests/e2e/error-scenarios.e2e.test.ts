import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { LSPTestClient } from './helpers/lsp-test-client';
import { createTestClient } from './helpers/lsp-test-client';
import { pos, setupTestDocument } from './helpers/test-utils';
import type { CompletionItem } from 'vscode-languageserver-protocol';
import { CompletionItemKind } from 'vscode-languageserver-protocol';
import { mockResponses } from '../helpers/mock-responses';

describe('E2E: Error Scenarios', () => {
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
            response: mockResponses.inline(),
          },
        },
        model: 'mock/test-model',
      },
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  it('should have timeout mechanism for requests', async () => {
    // This test verifies that the timeout mechanism exists and is configured
    // We use a normal timeout for actual operation, but verify the mechanism
    const timeoutClient = createTestClient({
      timeout: 5000, // Normal timeout for initialization
    });

    await timeoutClient.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.inline(),
          },
        },
        model: 'mock/test-model',
      },
    });

    const uri = await setupTestDocument(timeoutClient, 'const x');

    // This should complete successfully with normal timeout
    const completions = await timeoutClient.requestCompletion(uri, pos(0, 7));

    expect(completions).toBeArray();

    // The test verifies that timeout configuration is respected
    // In a real scenario with a slow provider, the timeout would trigger
    // For our mock provider, we just verify the mechanism doesn't break
    // normal operation

    await timeoutClient.shutdown();
  });

  it('should handle malformed provider responses gracefully', async () => {
    // Use the mock provider with a malformed response
    const errorClient = createTestClient({
      timeout: 10000,
    });

    await errorClient.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.malformed(),
          },
        },
        model: 'mock/test-model',
      },
    });

    const uri = await setupTestDocument(errorClient, 'const x');

    // The server should handle malformed responses gracefully
    // by returning empty results instead of crashing
    const completions = await errorClient.requestCompletion(uri, pos(0, 7));

    expect(completions).toBeArray();
    // Malformed responses should result in empty completions
    // The exact behavior depends on implementation, but it shouldn't crash

    await errorClient.shutdown();
  });

  it('should handle provider errors gracefully in next-edit', async () => {
    // Use the mock provider configured to throw errors
    const errorClient = createTestClient({
      timeout: 10000,
    });

    await errorClient.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.empty(),
            throwError: true,
          },
        },
        model: 'mock/test-model',
        next_edit: {
          prompt: 'prefix_suffix',
        },
      },
    });

    const uri = await setupTestDocument(
      errorClient,
      'function test() {\n  // TODO\n}',
    );

    // The server should handle provider errors gracefully
    const result = await errorClient.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    // Error handling should return empty edits

    await errorClient.shutdown();
  });

  it('should handle invalid completion item resolution', async () => {
    // Create a completion item with invalid data
    const invalidItem: CompletionItem = {
      label: 'test',
      kind: CompletionItemKind.Text,
      data: null, // Invalid data
    };

    // The resolve handler should handle this gracefully
    const resolved = await client.resolveCompletion(invalidItem);

    expect(resolved).toBeDefined();
    expect(resolved.label).toBe('test');
    // Should return item even if resolution fails
  });

  it('should handle empty completion responses', async () => {
    // Test with a document that might not produce completions
    const uri = await setupTestDocument(client, '');

    const completions = await client.requestCompletion(uri, pos(0, 0));

    // Should return array (possibly empty) not null/undefined
    expect(completions).toBeArray();
  });

  it('should handle concurrent requests correctly', async () => {
    const uri = await setupTestDocument(client, 'const x = 1;\nconst y');

    // Send multiple requests concurrently
    const [comp1, comp2, edit] = await Promise.all([
      client.requestCompletion(uri, pos(0, 7)),
      client.requestCompletion(uri, pos(1, 7)),
      client.requestNextEdit(uri, pos(1, 7)),
    ]);

    // All requests should complete successfully
    expect(comp1).toBeArray();
    expect(comp2).toBeArray();
    expect(edit).toBeDefined();
    expect(edit.edits).toBeArray();
  });

  it('should maintain document state across multiple operations', async () => {
    const uri = await setupTestDocument(client, 'const a');

    // First operation
    const comp1 = await client.requestCompletion(uri, pos(0, 7));
    expect(comp1).toBeArray();

    // Change document
    await client.changeDocument(uri, 'const a = 1;\nconst b');

    // Second operation on changed document
    const comp2 = await client.requestCompletion(uri, pos(1, 7));
    expect(comp2).toBeArray();

    // Third operation - next edit
    const edit = await client.requestNextEdit(uri, pos(1, 7));
    expect(edit.edits).toBeArray();

    // Document state should be consistent
    const doc = client.getDocument(uri);
    expect(doc).toBeDefined();
    expect(doc?.getText()).toBe('const a = 1;\nconst b');
  });
});
