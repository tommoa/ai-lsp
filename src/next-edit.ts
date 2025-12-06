/**
 * next-edit: generate and convert LLM edit hints to LSP edits.
 *
 * This module provides a unified interface for requesting edit hints from a
 * language model and converting them to precise LSP-style text edits. It
 * supports multiple prompt strategies:
 *
 * - "prefix-suffix": Compact hints with prefix/suffix anchoring. Use when you
 *   want precise, localized edits with minimal context overhead.
 * - "line-number": Line-numbered file content. Use when you want the model to
 *   have better overall context or when prefix/suffix anchoring is unreliable.
 *
 * Public API
 * - generate({model,document,prompt,log,generateFn}): unified entry point
 * - PrefixSuffix, LineNumber: direct access to implementation modules
 *
 * Notes
 * - The module is model-agnostic: callers supply a prepared
 *   `ai.LanguageModel` instance and may inject a custom `generateFn` for
 *   testing or integration with different providers.
 * - Each implementation is intentionally conservative. Hints that cannot be
 *   mapped uniquely to a document location are skipped to avoid unsafe edits.
 */

import { time } from './util';
import { PrefixSuffix } from './next-edit/prefix-suffix';
import { LineNumber } from './next-edit/line-number';
import { LspEdit as _LspEdit, Result as _Result } from './next-edit/types';

export namespace NextEdit {
  export type LspEdit = _LspEdit;
  export type Result = _Result;

  export type Options = PrefixSuffix.Options | LineNumber.Options;

  /**
   * Unified generate function: request edit hints from a language model using
   * the specified prompt strategy and convert them to precise LSP edits.
   *
   * @param opts.model - prepared LanguageModel instance
   * @param opts.document - TextDocument to base hints on
   * @param opts.prompt - strategy: "prefix-suffix" (default) or "line-number"
   * @param opts.log - optional logger for diagnostics/timing
   * @returns object with edits and optional token usage
   */
  export async function generate(opts: Options): Promise<Result> {
    const { model, document, log } = opts;
    const prompt = opts.prompt ?? 'prefix-suffix';

    using _timer = log
      ? time(log, 'info', `next-edit.generate (${prompt})`)
      : undefined;

    if (prompt === 'line-number') {
      return LineNumber.generate({
        prompt: 'line-number',
        model,
        document,
        log,
      });
    } else {
      return PrefixSuffix.generate({
        prompt: 'prefix-suffix',
        model,
        document,
        log,
      });
    }
  }
}
