import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { LSPTestClient } from './helpers/lsp-test-client';
import { createTestClient } from './helpers/lsp-test-client';
import { pos, setupTestDocument } from './helpers/test-utils';
import { mockResponses } from './helpers/mock-responses';

describe('E2E: Next Edit (copilotInlineEdit)', () => {
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
          prompt: 'prefix_suffix',
        },
      },
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  it('should return edits array', async () => {
    const content = `function test() {
  // TODO: implement
}`;
    const uri = await setupTestDocument(client, content);

    const result = await client.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);
  });

  it('should return edits with proper structure', async () => {
    const uri = await setupTestDocument(
      client,
      'function test() {\n  // TODO: implement\n}',
    );

    const result = await client.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    const edit = result.edits[0]!;
    expect(edit.textDocument).toBeDefined();
    expect(edit.textDocument.uri).toBe(uri);
    expect(edit.range).toBeDefined();
    expect(edit.range.start).toBeDefined();
    expect(edit.range.end).toBeDefined();
    expect(edit.text).toBeDefined();
    expect(typeof edit.text).toBe('string');
    expect(edit.text.length).toBeGreaterThan(0);
  });

  it('should support prefix_suffix prompt mode', async () => {
    const prefixSuffixClient = createTestClient();

    await prefixSuffixClient.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.prefixSuffix(),
          },
        },
        model: 'mock/test-model',
        next_edit: {
          prompt: 'prefix_suffix',
        },
      },
    });

    const uri = await setupTestDocument(
      prefixSuffixClient,
      'function test() {\n  // TODO: implement\n}',
    );

    const result = await prefixSuffixClient.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    // Verify the edit has expected structure from prefix_suffix mode
    const edit = result.edits[0]!;
    expect(edit.text).toBeDefined();
    expect(edit.reason).toBeDefined();
    expect(edit.reason).toContain('implement');

    await prefixSuffixClient.shutdown();
  });

  it('should support line_number prompt mode', async () => {
    const lineNumberClient = createTestClient();

    await lineNumberClient.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.lineNumber(),
          },
        },
        model: 'mock/test-model',
        next_edit: {
          prompt: 'line_number',
        },
      },
    });

    const uri = await setupTestDocument(
      lineNumberClient,
      'function test() {\n  // TODO: implement\n}',
    );

    const result = await lineNumberClient.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    // Verify the edit has expected content from line_number mode
    const edit = result.edits[0]!;
    expect(edit.text).toBeDefined();
    expect(edit.reason).toBeDefined();
    expect(edit.text).toContain('return');

    await lineNumberClient.shutdown();
  });

  it('should handle empty document', async () => {
    const uri = await setupTestDocument(client, '');

    const result = await client.requestNextEdit(uri, pos(0, 0));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    // Empty documents should still return edits (mock always returns edits)
    // In production, this might be empty, but mock provider is deterministic
  });

  it('should handle multiline document', async () => {
    const content = `function test() {
  // TODO: implement
}

function multiply(a, b) {
  // TODO: implement multiplication
}`;

    const uri = await setupTestDocument(client, content);

    const result = await client.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);
  });

  it('should include optional command in edit if present', async () => {
    const uri = await setupTestDocument(
      client,
      'function test() {\n  // TODO: implement\n}',
    );

    const result = await client.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    const edit = result.edits[0]!;
    // Command is optional, so just verify it doesn't cause errors
    if (edit.command) {
      expect(typeof edit.command).toBe('object');
    }
  });

  it('should include optional uuid in edit if present', async () => {
    const uri = await setupTestDocument(
      client,
      'function test() {\n  // TODO: implement\n}',
    );

    const result = await client.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    const edit = result.edits[0]!;
    // UUID is optional, just verify it doesn't cause errors
    if (edit.uuid) {
      expect(typeof edit.uuid).toBe('string');
    }
  });

  it('should track document version in edit', async () => {
    const uri = await setupTestDocument(
      client,
      'function test() {\n  // TODO: implement\n}',
    );

    const result = await client.requestNextEdit(uri, pos(1, 2));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    const edit = result.edits[0]!;
    expect(edit.textDocument).toBeDefined();
    expect(typeof edit.textDocument.uri).toBe('string');
    expect(edit.textDocument.uri).toBe(uri);
    // version may be optional in some cases
    if (edit.textDocument.version !== undefined) {
      expect(typeof edit.textDocument.version).toBe('number');
    }
  });

  it('should return empty edits for unopened documents', async () => {
    const uri = 'file:///test/nonexistent.ts';

    // Request next-edit for a document that was never opened
    // The server gracefully returns empty edits instead of throwing
    const result = await client.requestNextEdit(uri, pos(0, 0));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBe(0);
  });

  it('should handle invalid position gracefully', async () => {
    const uri = await setupTestDocument(client, 'test');

    // Request next-edit at an invalid position (beyond document end)
    const result = await client.requestNextEdit(uri, pos(100, 100));

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
  });
});
