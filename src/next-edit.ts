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
 * - generateEdit({model,document,prompt,log}): unified entry point
 */

import { time } from './util';
import {
  generate as generatePrefixSuffix,
  type Options as PrefixSuffixOptions,
} from './next-edit/prefix-suffix';
import {
  generate as generateLineNumber,
  type Options as LineNumberOptions,
} from './next-edit/line-number';
import type { LspEdit, Result } from './next-edit/types';

export type { LspEdit, Result };

export type Options = PrefixSuffixOptions | LineNumberOptions;

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
export async function generateEdit(opts: Options): Promise<Result> {
  const { model, document, log } = opts;
  const prompt = opts.prompt ?? 'prefix-suffix';

  using _timer = log
    ? time(log, 'info', `generateEdit (${prompt})`)
    : undefined;

  if (prompt === 'line-number') {
    return generateLineNumber({
      prompt: 'line-number',
      model,
      document,
      log,
    });
  } else {
    return generatePrefixSuffix({
      prompt: 'prefix-suffix',
      model,
      document,
      log,
    });
  }
}
