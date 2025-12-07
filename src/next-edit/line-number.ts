/**
 * Line-number based edit hints: generate and convert LLM edit hints using
 * line numbers.
 *
 * This implementation uses line-number prefixes (L1:, L2:, ...) instead of
 * prefix/suffix anchoring. The LLM returns line ranges instead of context
 * strings, which may be simpler and more robust for certain codebases.
 */

import {
  Log,
  time,
  type TokenUsage,
  extractTokenUsage,
  normalizeNewlines,
  clip,
} from '../util';
import { parseResponse } from '../parser';
import { type LanguageModel } from 'ai';
import { generateText, type ModelMessage } from 'ai';
import { type Range } from 'vscode-languageserver-types';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { type LspEdit, type Result } from './types';
import type { Options as BaseOptions } from './types';
import PROMPT from '../../prompt/next-edit-linenum.txt';

/**
 * A hint describing an edit using line number ranges.
 *
 * - `startLine`: 1-based line number where edit begins
 * - `endLine`: 1-based line number where edit ends (inclusive)
 * - `text`: replacement text (may span multiple lines)
 * - `reason`: optional human-readable rationale
 */
export type LLMHint = {
  startLine: number;
  endLine: number;
  text: string;
  reason?: string;
};

export interface Options extends BaseOptions {
  prompt: 'line-number';
}

/**
 * Add line number prefixes to file content.
 * Example: "line 1\nline 2" -> "L1: line 1\nL2: line 2"
 */
function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  return lines.map((line, idx) => `L${idx + 1}: ${line}`).join('\n');
}

/**
 * Parse raw LLM output into an array of normalized `LLMHint` objects.
 *
 * The function attempts to parse `raw` as JSON first. If that fails it
 * extracts a substring from the first `[` to the last `]` and tries again.
 * This tolerates model outputs that wrap JSON in prose. The parsed items
 * are validated and normalized.
 *
 * @param raw - raw text returned by the LLM
 * @param log - optional logger used for diagnostics/timing
 * @returns normalized `LLMHint[]`
 * @throws when parsing fails or an item does not match the expected shape
 */
export function parseLLMResponse(raw: string, log: Log): LLMHint[] {
  using _timer = time(
    log,
    'info',
    'generateEdit (line-number): parseLLMResponse',
  );
  log?.('debug', `parseLLMResponse rawLen=${raw.length}`);

  const parsed = parseResponse(raw, log);

  const hints: LLMHint[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      const err = new Error('Invalid hint shape from LLM');
      log('error', `parseLLMResponse: ${String(err)}`);
      throw err;
    }

    const it = item as Record<string, unknown>;
    if (
      typeof it.startLine !== 'number' ||
      typeof it.endLine !== 'number' ||
      typeof it.text !== 'string'
    ) {
      const err = new Error('Invalid hint shape from LLM');
      const itemStr = JSON.stringify(item);
      log(
        'error',
        `parseLLMResponse: ${String(err)} - ` + `item=${clip(itemStr)}`,
      );
      throw err;
    }

    hints.push({
      startLine: it.startLine,
      endLine: it.endLine,
      text: normalizeNewlines(it.text),
      reason: typeof it.reason === 'string' ? it.reason : undefined,
    });
  }

  log('info', `parseLLMResponse parsed=${hints.length}`);
  return hints;
}

/**
 * Convert normalized `LLMHint[]` into precise `LspEdit[]` for a document.
 *
 * Line numbers are 1-based. Hints with invalid line ranges are skipped.
 *
 * @param opts.document - the `TextDocument` to apply hints against
 * @param opts.hints - array of normalized `LLMHint`s
 * @param log - optional logger for diagnostics/timing
 * @returns array of `LspEdit` objects
 */
export function convertLLMHintsToEdits(
  opts: { document: TextDocument; hints: LLMHint[] },
  log: Log,
): LspEdit[] {
  const { document, hints } = opts;
  const rawDoc = document.getText();
  const uri = (document as { uri?: string }).uri ?? '';
  const doc = rawDoc;

  using _timer = time(
    log,
    'info',
    'generateEdit (line-number): convertLLMHintsToEdits',
    {
      hints: hints.length,
      uri,
    },
  );

  log('debug', `convertLLMHintsToEdits docLen=${doc.length}`);

  const lines = doc.split('\n');
  const lineCount = lines.length;
  const edits: LspEdit[] = [];

  for (const hint of hints) {
    const { startLine, endLine, text, reason } = hint;

    // Validate line numbers (1-based)
    if (
      startLine < 1 ||
      endLine < 1 ||
      startLine > lineCount ||
      endLine > lineCount ||
      startLine > endLine
    ) {
      const msg =
        `Skipping invalid line range: startLine=${startLine} ` +
        `endLine=${endLine} totalLines=${lineCount} uri=${uri}`;
      log('warn', msg);
      continue;
    }

    // Convert 1-based line numbers to 0-based indices
    const startLineIdx = startLine - 1;
    const endLineIdx = endLine - 1;

    // Calculate character offsets
    let startCharPos = 0;
    for (let i = 0; i < startLineIdx; i++) {
      startCharPos += lines[i]!.length + 1; // +1 for newline
    }

    // For end position, include the entire end line
    let endCharPos = startCharPos;
    for (let i = startLineIdx; i <= endLineIdx; i++) {
      endCharPos += lines[i]!.length + 1; // +1 for newline
    }
    // Adjust if we're at the last line (no trailing newline)
    if (endLineIdx === lineCount - 1) {
      endCharPos -= 1;
    }

    // Use document.positionAt for consistency
    const range: Range = {
      start: document.positionAt(startCharPos),
      end: document.positionAt(Math.min(endCharPos, doc.length)),
    };

    edits.push({
      range,
      textDocument: { uri },
      text,
      reason,
    });

    log(
      'debug',
      `Applied line-based hint lines=${startLine}-${endLine} uri=${uri}`,
    );
  }

  log('info', `convertLLMHintsToEdits produced=${edits.length}`);
  return edits;
}

/**
 * Request compact edit hints from a prepared `LanguageModel`.
 *
 * The prompt includes line-numbered file content and instructions to
 * return edits as line ranges. The document is normalized to LF newlines.
 *
 * @param opts.model - prepared LanguageModel instance
 * @param opts.document - TextDocument to base hints on
 * @param opts.log - optional logger
 * @returns object with normalized `LLMHint[]` and optional token usage
 */
export async function requestLLMHints(opts: {
  model: LanguageModel;
  document: TextDocument;
  log: Log;
}): Promise<{ hints: LLMHint[]; tokenUsage?: TokenUsage }> {
  const { model, document, log } = opts;
  using _timer = time(
    log,
    'info',
    'generateEdit (line-number): requestLLMHints',
  );
  if (!model) throw new Error('No model provided');

  log('debug', `requestLLMHints language=${document.languageId}`);

  // Build messages array with line-numbered content.
  const docText = normalizeNewlines(document.getText());
  const numberedContent = addLineNumbers(docText);

  const messages: ModelMessage[] = [
    { role: 'system', content: PROMPT },
    {
      role: 'user',
      content: `Language: ${document.languageId || 'text'}`,
    },
    {
      role: 'user',
      content: `File content (with line numbers):\n${numberedContent}`,
    },
    {
      role: 'user',
      content: 'Suggest the next edits for this file.',
    },
  ];

  const params = { model, messages };
  const res = await generateText(params);
  const rawOutput = (res as { text?: string }).text ?? JSON.stringify(res);

  // Extract token usage from response
  const tokenUsage = extractTokenUsage(res) ?? undefined;

  log(
    'debug',
    `requestLLMHints rawOutputLen=${String(rawOutput).length} ` +
      `preview=${clip(String(rawOutput))}`,
  );
  const hints = parseLLMResponse(String(rawOutput), log);
  return { hints, tokenUsage };
}

/**
 * Convenience helper: request LLM hints for `document` and convert them to
 * precise LSP edits.
 */
export async function generate(opts: Options): Promise<Result> {
  const { model, document, log } = opts;
  const { hints, tokenUsage } = await requestLLMHints({
    model,
    document,
    log,
  });
  const edits = convertLLMHintsToEdits({ document, hints }, log);
  return { edits, tokenUsage };
}
