/**
 * next-edit: generate and convert LLM edit hints to LSP edits.
 *
 * This module provides a unified interface for requesting edit hints from a
 * language model and converting them to precise LSP-style text edits. It
 * supports multiple prompt strategies:
 *
 * - "prefix_suffix": Compact hints with prefix/suffix anchoring. Use when you
 *   want precise, localized edits with minimal context overhead.
 * - "line_number": Line-numbered file content. Use when you want the model to
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

import { type LanguageModel } from 'ai';
import { Log, time } from './util';
import { PrefixSuffix } from './next-edit/prefix-suffix';
import { LineNumber } from './next-edit/line-number';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ModelMessage } from 'ai';

export namespace NextEdit {
  /**
   * Prompt type: which strategy to use for sending file content to the LLM.
   *
   * - "prefix_suffix": Sends compact hints requesting { prefix, existing,
   *   suffix, text, reason }. Suitable for models that work well with
   *   localized context.
   * - "line_number": Sends full file with line numbers (L1:, L2:, ...).
   *   Requests { startLine, endLine, text, reason }. Suitable for models
   *   that benefit from full context.
   */
  export type PromptType = 'prefix_suffix' | 'line_number';

  /**
   * Type for custom generate functions. Both implementations use this shape.
   */
  export type GenerateFn = (params: {
    model: LanguageModel;
    messages: ModelMessage[];
  }) => Promise<{ text?: string } | unknown>;

  /**
   * LSP-style edit. Both implementations produce this shape.
   */
  export type LspEdit = {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    textDocument: { uri: string };
    text: string;
    reason?: string;
  };

  /**
   * Unified generate function: request edit hints from a language model using
   * the specified prompt strategy and convert them to precise LSP edits.
   *
   * @param opts.model - prepared LanguageModel instance
   * @param opts.document - TextDocument to base hints on
   * @param opts.prompt - strategy: "prefix_suffix" (default) or "line_number"
   * @param opts.log - optional logger for diagnostics/timing
   * @param opts.generateFn - optional custom generate function
   * @returns array of LspEdit objects
   */
  export async function generate(opts: {
    model: LanguageModel;
    document: TextDocument;
    prompt?: PromptType;
    log?: Log;
    generateFn?: GenerateFn;
  }): Promise<LspEdit[]> {
    const { model, document, log, generateFn } = opts;
    const prompt = opts.prompt ?? 'prefix_suffix';

    using _timer = log
      ? time(log, 'info', `next-edit.generate (${prompt})`)
      : undefined;

    if (prompt === 'line_number') {
      return await LineNumber.generate({
        model,
        document,
        log,
        generateFn,
      });
    } else {
      return await PrefixSuffix.generate({
        model,
        document,
        log,
        generateFn,
      });
    }
  }
}
