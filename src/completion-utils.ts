/**
 * Utilities for inline completion handling.
 */

import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver/node';

/**
 * Extract the partial identifier/word at the cursor position.
 * This is used for better completion filtering and text replacement.
 *
 * Examples:
 * - "Math.fl" at position 7 -> "Math.fl"
 * - "const myVar" at position 11 -> "myVar"
 * - "foo.bar.baz" at position 11 -> "foo.bar.baz"
 * - "x = 5" at position 5 (after space) -> "" (at the space)
 */
export function extractPartialWord(
  document: TextDocument,
  position: Position,
): {
  partial: string;
  startChar: number;
} {
  const lineStart = document.offsetAt({
    line: position.line,
    character: 0,
  });
  const cursorOffset = document.offsetAt(position);
  const lineText = document.getText().slice(lineStart, cursorOffset);

  // Match word characters, dots, and common identifier characters
  // This regex captures the last "word" which may include dots for method calls
  const match = lineText.match(/[\w.]*$/);
  const partial = match ? match[0] : '';
  const startChar = lineText.length - partial.length;

  return { partial, startChar };
}
