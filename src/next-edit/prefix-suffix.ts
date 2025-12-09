/**
 * Prefix-suffix based edit hints: generate and convert LLM edit hints to
 * LSP edits using prefix/suffix anchoring.
 *
 * This implementation uses compact context around edits for anchoring. The LLM
 * returns hints as { prefix, existing, suffix, text, reason? } objects that
 * describe local replacements using immediate surrounding context.
 */

import {
  type Log,
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
import type { LspEdit, Result } from './types';
import type { Options as BaseOptions } from './types';
import PROMPT from '../../prompt/next-edit.txt';

/**
 * A compact hint describing a small local replacement produced by an LLM.
 *
 * - `prefix`: text immediately before the region to change
 * - `existing`: text to be replaced (may be empty for insertions)
 * - `suffix`: text immediately after the region to change
 * - `text`: replacement text
 * - `reason`: optional human-readable rationale
 */
export interface LLMHint {
  prefix: string;
  existing: string;
  suffix: string;
  text: string;
  reason?: string;
}

export interface Options extends BaseOptions {
  prompt: 'prefix-suffix';
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
export function parseLLMResponse(raw: string, log: Log): LLMHint[] {
  using _timer = time(
    log,
    'info',
    'generateEdit (prefix-suffix): parseLLMResponse',
  );
  log('debug', `parseLLMResponse rawLen=${raw.length}`);

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
      typeof it.prefix !== 'string' ||
      typeof it.existing !== 'string' ||
      typeof it.suffix !== 'string' ||
      typeof it.text !== 'string'
    ) {
      const err = new Error('Invalid hint shape from LLM');
      log(
        'error',
        `parseLLMResponse: ${String(err)} - item=${clip(JSON.stringify(item))}`,
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

  log('info', `parseLLMResponse parsed=${hints.length}`);
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
  log: Log,
): LspEdit[] {
  const { document, hints } = opts;
  const rawDoc = document.getText();
  // Prefer a typed access to uri when present on the document impl.
  const uri = (document as { uri?: string }).uri ?? '';
  const doc = rawDoc; // operate directly on the document text

  using _timer = time(
    log,
    'info',
    'generateEdit (prefix-suffix): convertLLMHintsToEdits',
    {
      hints: hints.length,
      uri,
    },
  );

  log('debug', `convertLLMHintsToEdits docLen=${doc.length}`);

  const edits: LspEdit[] = [];

  for (const hint of hints) {
    // Try to find the the original prefix + existing + suffix position in the
    // document.
    const joined = hint.prefix + hint.existing + hint.suffix;
    const exactIndex = doc.indexOf(joined);

    if (exactIndex === -1) {
      // We didn't find what the AI has returned to us. We should log that it
      // didn't give us the correct format, and return an empty hint.
      log(
        'warn',
        `Skipping unresolved hint uri=${uri} hint=${clip(
          JSON.stringify(hint),
        )}`,
      );
      continue;
    }
    // Exact anchor matched.
    const startIndex = exactIndex + hint.prefix.length;
    const endIndex = startIndex + hint.existing.length;

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
  }

  log('info', `convertLLMHintsToEdits produced=${edits.length}`);
  return edits;
}

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
    'generateEdit (prefix-suffix): requestLLMHints',
  );
  if (!model) throw new Error('No model provided');

  log('debug', `requestLLMHints language=${document.languageId}`);

  // Build messages array containing system instructions, language hint,
  // and full document text. We normalize newlines for prompt stability.
  const docText = normalizeNewlines(document.getText());
  const messages: ModelMessage[] = [
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

  // Call generateText to generate the response.
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
