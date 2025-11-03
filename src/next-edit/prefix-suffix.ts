/**
 * Prefix-suffix based edit hints: generate and convert LLM edit hints to
 * LSP edits using prefix/suffix anchoring.
 *
 * This implementation uses compact context around edits for anchoring. The LLM
 * returns hints as { prefix, existing, suffix, text, reason? } objects that
 * describe local replacements using immediate surrounding context.
 */

import { Log, time, Parser } from '../util';
import { type LanguageModel } from 'ai';
import { generateText, type CoreMessage } from 'ai';
import { type Range } from 'vscode-languageserver-types';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import PROMPT from '../../prompt/next-edit.txt';

export namespace PrefixSuffix {
  /**
   * A compact hint describing a small local replacement produced by an LLM.
   *
   * - `prefix`: text immediately before the region to change
   * - `existing`: text to be replaced (may be empty for insertions)
   * - `suffix`: text immediately after the region to change
   * - `text`: replacement text
   * - `reason`: optional human-readable rationale
   */
  export type LLMHint = {
    prefix: string;
    existing: string;
    suffix: string;
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
   * Find all (possibly overlapping) occurrences of `needle` in `hay`.
   *
   * Returns start indices for each match. Overlapping matches are allowed
   * (e.g. "ana" in "banana" yields [1, 3]). Empty `needle` returns [] to
   * avoid ambiguous behavior.
   */
  function findAllOccurrences(hay: string, needle: string): number[] {
    const res: number[] = [];
    if (needle.length === 0) return res;
    let idx = 0;
    while (true) {
      const found = hay.indexOf(needle, idx);
      if (found === -1) break;
      res.push(found);
      idx = found + 1; // allow overlapping occurrences
    }
    return res;
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
   * Parse raw LLM output into an array of normalized `LLMHint` objects.
   *
   * The function attempts to parse `raw` as JSON first. If that fails it
   * extracts a substring from the first `[` to the last `]` and tries again.
   * This tolerates model outputs that wrap JSON in prose. The parsed items
   * are validated and normalized (newlines -> LF).
   *
   * @param raw - raw text returned by the LLM
   * @param log - optional logger used for diagnostics/timing
   * @returns normalized `LLMHint[]`
   * @throws when parsing fails or an item does not match the expected shape
   */
  export function parseLLMResponse(raw: string, log?: Log): LLMHint[] {
    using _timer = log
      ? time(log, 'info', 'next-edit.prefix-suffix.parseLLMResponse')
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
        typeof it.prefix !== 'string' ||
        typeof it.existing !== 'string' ||
        typeof it.suffix !== 'string' ||
        typeof it.text !== 'string'
      ) {
        const err = new Error('Invalid hint shape from LLM');
        log?.(
          'error',
          `parseLLMResponse: ${String(err)} - item=${clip(
            JSON.stringify(item),
          )}`,
        );
        throw err;
      }

      hints.push({
        prefix: normalizeNewlines(it.prefix),
        existing: normalizeNewlines(it.existing),
        suffix: normalizeNewlines(it.suffix),
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
   * The conversion uses conservative anchoring heuristics in this order:
   * 1) Exact anchor: find prefix+existing+suffix and replace only existing.
   * 2) Unique prefix: prefix occurs once and existing follows it.
   * 3) Insertion: existing is empty and prefix exists -> insert after prefix.
   * 4) Unique existing: existing occurs exactly once in the doc.
   *
   * Hints that cannot be uniquely resolved are skipped. The function uses the
   * document's `positionAt` to create LSP positions so results match the
   * provided `TextDocument` implementation.
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
    // Prefer a typed access to uri when present on the document impl.
    const uri = (document as { uri?: string }).uri ?? '';
    const doc = rawDoc; // operate directly on the document text

    using _timer = log
      ? time(log, 'info', 'next-edit.prefix-suffix.convertLLMHintsToEdits', {
          hints: hints.length,
          uri,
        })
      : undefined;

    log?.('debug', `convertLLMHintsToEdits docLen=${doc.length}`);

    // Detect original newline sequence so we can map normalized hints back.
    const docNewline = rawDoc.includes('\r\n') ? '\r\n' : '\n';

    const edits: LspEdit[] = [];

    for (const hint of hints) {
      // Reintroduce the document's newline style into the hint parts so
      // string matching aligns with the document's offsets.
      const hPrefix = hint.prefix.replace(/\n/g, docNewline);
      const hExisting = hint.existing.replace(/\n/g, docNewline);
      const hSuffix = hint.suffix.replace(/\n/g, docNewline);

      const joined = hPrefix + hExisting + hSuffix;
      const exactIndex = doc.indexOf(joined);

      let startIndex: number | null = null;
      let endIndex: number | null = null;
      let matchedBy: string | null = null;

      if (exactIndex !== -1) {
        // Exact anchor matched.
        startIndex = exactIndex + hPrefix.length;
        endIndex = startIndex + hExisting.length;
        matchedBy = 'exact';
      } else {
        // Try prefix-based heuristics and fallbacks.
        const prefixOcc = findAllOccurrences(doc, hPrefix);
        if (prefixOcc.length === 1) {
          const p = prefixOcc[0] as number;
          const possibleStart = p + hPrefix.length;
          const possibleExisting = doc.slice(
            possibleStart,
            possibleStart + hExisting.length,
          );
          if (possibleExisting === hExisting) {
            startIndex = possibleStart;
            endIndex = startIndex + hExisting.length;
            matchedBy = 'uniquePrefix';
          }
        } else if (hExisting.length === 0 && prefixOcc.length > 0) {
          // Insertion: place at first prefix occurrence.
          const p = prefixOcc[0] as number;
          startIndex = p + hPrefix.length;
          endIndex = startIndex;
          matchedBy = 'insertion';
        } else if (hExisting.length > 0) {
          // Use unique `existing` as a last resort.
          const existingOcc = findAllOccurrences(doc, hExisting);
          if (existingOcc.length === 1) {
            startIndex = existingOcc[0] as number;
            endIndex = startIndex + hExisting.length;
            matchedBy = 'uniqueExisting';
          }
        }
      }

      if (startIndex === null || endIndex === null) {
        // Conservative: skip unresolved or ambiguous hints.
        log?.(
          'warn',
          `Skipping unresolved hint uri=${uri} hint=${clip(
            JSON.stringify(hint),
          )}`,
        );
        continue;
      }

      // Use document.positionAt so positions are consistent with the doc.
      const range: Range = {
        start: document.positionAt(startIndex),
        end: document.positionAt(endIndex),
      };

      edits.push({
        range,
        textDocument: { uri },
        text: hint.text,
        reason: hint.reason,
      });

      log?.('debug', `Applied hint via=${matchedBy} uri=${uri}`);
    }

    log?.('info', `convertLLMHintsToEdits produced=${edits.length}`);
    return edits;
  }

  /**
   * Type for generate function used to call the language model. The function
   * should accept an object containing the `model` and `messages` array and
   * return a promise that resolves to an object with a `.text` property
   * (or any other shape parseable by `parseLLMResponse`).
   */
  export type GenerateFn = (params: {
    model: LanguageModel;
    messages: CoreMessage[];
  }) => Promise<{ text?: string } | unknown>;

  /**
   * Request compact edit hints from a prepared `LanguageModel`.
   *
   * The prompt provided to the model includes a short language hint and the
   * full document text (with normalized LF newlines). If a bundled `PROMPT`
   * file is present it is forwarded as the `system` prompt.
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
    // optional generate function (defaults to ai.generateText)
    generateFn?: GenerateFn;
  }): Promise<LLMHint[]> {
    const { model, document, log, generateFn } = opts;
    const gen =
      generateFn ??
      (async (p: { model: LanguageModel; messages: CoreMessage[] }) =>
        await generateText(p));
    using _timer = log
      ? time(log, 'info', 'next-edit.prefix-suffix.requestLLMHints')
      : undefined;
    if (!model) throw new Error('No model provided');

    log?.('debug', `requestLLMHints language=${document.languageId}`);

    // Build messages array containing system instructions, language hint,
    // and full document text. We normalize newlines for prompt stability.
    const docText = normalizeNewlines(document.getText());
    const messages: CoreMessage[] = [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: `Language: ${document.languageId || 'text'}`,
      },
      {
        role: 'user',
        content: `File content:\n${docText}`,
      },
      {
        role: 'user',
        content: 'Suggest the next edits for this file.',
      },
    ];

    const params = { model, messages };

    // Call the injected generate function (defaults to ai.generateText).
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
    // optional generate function forwarded to requestLLMHints
    generateFn?: GenerateFn;
  }): Promise<LspEdit[]> {
    const { model, document, log, generateFn } = opts;
    const hints = await requestLLMHints({ model, document, log, generateFn });
    const edits = convertLLMHintsToEdits({ document, hints }, log);
    return edits;
  }
}
