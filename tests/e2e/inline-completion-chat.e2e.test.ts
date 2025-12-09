import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { LSPTestClient } from './helpers/lsp-test-client';
import { createTestClient } from './helpers/lsp-test-client';
import { pos, setupTestDocument } from './helpers/test-utils';
import { mockResponses } from '../helpers/mock-responses';

describe('E2E: Inline Completion (Chat)', () => {
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

  it('should initialize server successfully', () => {
    expect(client.isRunning()).toBe(true);
  });

  it('should return completion items at cursor position', async () => {
    const uri = await setupTestDocument(client, 'const co');

    const completions = await client.requestCompletion(uri, pos(0, 8));

    expect(completions).toBeArray();
    expect(completions.length).toBeGreaterThan(0);

    // Verify completion content (includes partial word + completion)
    const firstCompletion = completions[0]!;
    expect(firstCompletion.label).toBeDefined();
    expect(firstCompletion.label).toContain('co');
    expect(firstCompletion.label).toContain('onstant');
  });

  it('should have valid completion item structure', async () => {
    const uri = await setupTestDocument(client, 'const ');

    const completions = await client.requestCompletion(uri, pos(0, 6));

    expect(completions.length).toBeGreaterThan(0);
    const item = completions[0]!;
    expect(item.label).toBeDefined();
    expect(typeof item.label).toBe('string');
    expect(item.label.length).toBeGreaterThan(0);

    // Verify it contains completion text
    expect(item.label).toContain('onstant');
  });

  it('should handle completion with textEdit range', async () => {
    const uri = await setupTestDocument(client, 'Math.fl');

    const completions = await client.requestCompletion(uri, pos(0, 7));

    expect(completions.length).toBeGreaterThan(0);
    const item = completions[0]!;
    expect(item.textEdit).toBeDefined();
    if (item.textEdit && 'range' in item.textEdit) {
      expect(item.textEdit.range).toBeDefined();
      expect(item.textEdit.range.start).toBeDefined();
      expect(item.textEdit.range.end).toBeDefined();
      expect(item.textEdit.newText).toBeDefined();
      expect(item.textEdit.newText.length).toBeGreaterThan(0);
    } else {
      throw new Error('textEdit does not have expected range structure');
    }
  });

  it('should resolve completion item with details', async () => {
    const uri = await setupTestDocument(client, 'cons');

    const completions = await client.requestCompletion(uri, pos(0, 4));

    expect(completions.length).toBeGreaterThan(0);
    const resolved = await client.resolveCompletion(completions[0]!);
    expect(resolved).toBeDefined();
    // The detail should be added by the resolve handler
    expect(resolved.detail).toBeDefined();
    expect(typeof resolved.detail).toBe('string');
    expect(resolved.detail!.length).toBeGreaterThan(0);

    // Verify detail contains model and reason
    expect(resolved.detail).toContain('test-model');
  });

  it('should handle document changes', async () => {
    const uri = await setupTestDocument(client, 'const x = 1;');

    // First completion request
    const completions1 = await client.requestCompletion(uri, pos(0, 6));
    expect(completions1).toBeArray();

    // Change document
    await client.changeDocument(uri, 'const x = 2;\nconst y');

    // Second completion request in changed document
    const completions2 = await client.requestCompletion(uri, pos(1, 7));
    expect(completions2).toBeArray();
  });

  it('should handle empty document', async () => {
    const uri = await setupTestDocument(client, '');

    const completions = await client.requestCompletion(uri, pos(0, 0));

    expect(completions).toBeArray();
    expect(completions.length).toBeGreaterThan(0);
  });

  it('should handle multiline document', async () => {
    const content = `function test() {
  const x = 
  return x;
}`;
    const uri = await setupTestDocument(client, content);

    // Request completion at line 1, after "const x = "
    const completions = await client.requestCompletion(uri, pos(1, 10));

    expect(completions).toBeArray();
    expect(completions.length).toBeGreaterThan(0);
  });

  it('should handle completion at end of file', async () => {
    const uri = await setupTestDocument(client, 'const value =');

    const completions = await client.requestCompletion(uri, pos(0, 13));

    expect(completions).toBeArray();
    expect(completions.length).toBeGreaterThan(0);
  });

  it('should close document without error', async () => {
    const uri = await setupTestDocument(client, 'test');

    // Should not throw
    await client.closeDocument(uri);

    // Document should be removed
    const doc = client.getDocument(uri);
    expect(doc).toBeUndefined();
  });

  it('should track message log in debug mode', async () => {
    const debugClient = createTestClient({
      debug: true,
    });

    await debugClient.start({
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

    const uri = await setupTestDocument(debugClient, 'test');
    await debugClient.requestCompletion(uri, pos(0, 4));

    const log = debugClient.getMessageLog();
    expect(log.length).toBeGreaterThan(0);

    // Should have both send and receive messages
    const sendMessages = log.filter(m => m.direction === 'send');
    expect(sendMessages.length).toBeGreaterThan(0);

    await debugClient.shutdown();
  });

  it('should reject requests for unopened documents', async () => {
    const uri = 'file:///test/nonexistent.ts';

    // Request completion for a document that was never opened
    // The server should throw an error because documents must be opened first
    // via textDocument/didOpen before requesting completions
    let errorThrown = false;
    try {
      await client.requestCompletion(uri, pos(0, 0));
    } catch (error) {
      errorThrown = true;
      expect(error).toBeDefined();
    }
    expect(errorThrown).toBe(true);
  });

  it('should handle invalid position gracefully', async () => {
    const uri = await setupTestDocument(client, 'test');

    // Request completion at invalid position (beyond document end)
    const completions = await client.requestCompletion(uri, pos(100, 100));

    expect(completions).toBeArray();
  });
});
