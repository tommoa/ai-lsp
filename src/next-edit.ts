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
import { Log, time, type TokenUsage } from './util';
import { PrefixSuffix } from './next-edit/prefix-suffix';
import { LineNumber } from './next-edit/line-number';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ModelMessage } from 'ai';

export namespace NextEdit {
  /**
   * Enum for next-edit prompt types
   */
  export enum PromptType {
    PrefixSuffix = 'prefix_suffix',
    LineNumber = 'line_number',
  }

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
   * Result type that includes edits and optional token usage.
   */
  export type Result = {
    edits: LspEdit[];
    tokenUsage?: TokenUsage;
  };

  /**
   * Unified generate function: request edit hints from a language model using
   * the specified prompt strategy and convert them to precise LSP edits.
   *
   * @param opts.model - prepared LanguageModel instance
   * @param opts.document - TextDocument to base hints on
   * @param opts.prompt - strategy: "prefix_suffix" (default) or "line_number"
   * @param opts.log - optional logger for diagnostics/timing
   * @returns object with edits and optional token usage
   */
  export async function generate(opts: {
    model: LanguageModel;
    document: TextDocument;
    prompt?: PromptType;
    log?: Log;
  }): Promise<Result> {
    const { model, document, log } = opts;
    const prompt = opts.prompt ?? 'prefix_suffix';

    using _timer = log
      ? time(log, 'info', `next-edit.generate (${prompt})`)
      : undefined;

    if (prompt === 'line_number') {
      return await LineNumber.generate({
        model,
        document,
        log,
      });
    } else {
      return await PrefixSuffix.generate({
        model,
        document,
        log,
      });
    }
  }
}
