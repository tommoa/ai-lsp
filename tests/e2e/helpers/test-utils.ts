import type { Position } from 'vscode-languageserver-protocol';
import type { LSPTestClient } from './lsp-test-client';

/**
 * Helper to calculate position from line/column in a document
 */
export function pos(line: number, character: number): Position {
  return { line, character };
}

/**
 * Create a test URI for a file
 */
export function testUri(filename: string): string {
  return `file:///test/${filename}`;
}

/**
 * Setup helper for common test scenarios
 */
export async function setupTestDocument(
  client: LSPTestClient,
  content: string,
  languageId = 'typescript',
): Promise<string> {
  const uri = testUri(`test-${Date.now()}.${languageId}`);
  await client.openDocument(uri, content, languageId);
  return uri;
}
