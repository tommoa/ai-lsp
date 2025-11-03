/**
 * Line-number based edit hints: generate and convert LLM edit hints using
 * line numbers.
 *
 * This implementation uses line-number prefixes (L1:, L2:, ...) instead of
 * prefix/suffix anchoring. The LLM returns line ranges instead of context
 * strings, which may be simpler and more robust for certain codebases.
 */

import { Log, time, Parser } from '../util';
import { type LanguageModel } from 'ai';
import { generateText, type ModelMessage } from 'ai';
import { type Range } from 'vscode-languageserver-types';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import PROMPT from '../../prompt/next-edit-linenum.txt';

export namespace LineNumber {
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

  /**
   * LSP-style edit produced by this module. `textDocument.uri` may be empty
   * when the underlying `TextDocument` implementation does not expose a URI.
   */
  export type LspEdit = {
    range: Range;
    textDocument: { uri: string };
    text: string;
    reason?: string;
  };

  /**
   * Normalize CRLF -> LF. The anchoring logic operates on a stable newline
   * format when extracting and comparing hint substrings.
   */
  function normalizeNewlines(s: string): string {
    return s.replace(/\r\n?/g, '\n');
  }

  /**
   * Clip a long string for safe logging. Returns the original string when its
   * length is <= `n`.
   */
  function clip(s: string, n = 200): string {
    if (s.length <= n) return s;
    return s.slice(0, n) + '...';
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
  export function parseLLMResponse(raw: string, log?: Log): LLMHint[] {
    using _timer = log
      ? time(log, 'info', 'next-edit.line-number.parseLLMResponse')
      : undefined;
    log?.('debug', `parseLLMResponse rawLen=${raw.length}`);

    const parsed = Parser.parseResponse(raw, log);

    const hints: LLMHint[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        const err = new Error('Invalid hint shape from LLM');
        log?.('error', `parseLLMResponse: ${String(err)}`);
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
        log?.(
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

    log?.('info', `parseLLMResponse parsed=${hints.length}`);
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
    log?: Log,
  ): LspEdit[] {
    const { document, hints } = opts;
    const rawDoc = document.getText();
    const uri = (document as { uri?: string }).uri ?? '';
    const doc = rawDoc;

    using _timer = log
      ? time(log, 'info', 'next-edit.line-number.convertLLMHintsToEdits', {
          hints: hints.length,
          uri,
        })
      : undefined;

    log?.('debug', `convertLLMHintsToEdits docLen=${doc.length}`);

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
        log?.('warn', msg);
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

      log?.(
        'debug',
        `Applied line-based hint lines=${startLine}-${endLine} uri=${uri}`,
      );
    }

    log?.('info', `convertLLMHintsToEdits produced=${edits.length}`);
    return edits;
  }

  /**
   * Type for generate function used to call the language model.
   */
  export type GenerateFn = (params: {
    model: LanguageModel;
    messages: ModelMessage[];
  }) => Promise<{ text?: string } | unknown>;

  /**
   * Request compact edit hints from a prepared `LanguageModel`.
   *
   * The prompt includes line-numbered file content and instructions to
   * return edits as line ranges. The document is normalized to LF newlines.
   *
   * @param opts.model - prepared LanguageModel instance
   * @param opts.document - TextDocument to base hints on
   * @param opts.log - optional logger
   * @param opts.generateFn - optional custom generate function
   * @returns normalized `LLMHint[]`
   */
  export async function requestLLMHints(opts: {
    model: LanguageModel;
    document: TextDocument;
    log?: Log;
    generateFn?: GenerateFn;
  }): Promise<LLMHint[]> {
    const { model, document, log, generateFn } = opts;
    const gen =
      generateFn ??
      (async (p: { model: LanguageModel; messages: ModelMessage[] }) =>
        await generateText(p));
    using _timer = log
      ? time(log, 'info', 'next-edit.line-number.requestLLMHints')
      : undefined;
    if (!model) throw new Error('No model provided');

    log?.('debug', `requestLLMHints language=${document.languageId}`);

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
    const res = await gen(params);
    const rawOutput = (res as { text?: string }).text ?? JSON.stringify(res);

    log?.(
      'debug',
      `requestLLMHints rawOutputLen=${String(rawOutput).length} ` +
        `preview=${clip(String(rawOutput))}`,
    );
    const hints = parseLLMResponse(String(rawOutput), log);
    return hints;
  }

  /**
   * Convenience helper: request LLM hints for `document` and convert them to
   * precise LSP edits.
   */
  export async function generate(opts: {
    model: LanguageModel;
    document: TextDocument;
    log?: Log;
    generateFn?: GenerateFn;
  }): Promise<LspEdit[]> {
    const { model, document, log, generateFn } = opts;
    const hints = await requestLLMHints({ model, document, log, generateFn });
    const edits = convertLLMHintsToEdits({ document, hints }, log);
    return edits;
  }
}
