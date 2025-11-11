/**
 * Inline completion: generate code completions at cursor position.
 *
 * Supports multiple prompt strategies for different use cases.
 * Each implementation produces the same output shape.
 *
 * Public API
 * - generate({model,document,position,log}): unified entry point
 * - Chat: direct access to chat implementation
 */

import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { type LanguageModel } from 'ai';
import { Log, time, type TokenUsage } from './util';
import { Chat } from './inline-completion/chat';

export namespace InlineCompletion {
  export type Completion = {
    text: string;
    reason?: string;
  };

  /**
   * Result type that includes completions and optional token usage.
   */
  export type Result = {
    completions: Completion[] | null;
    tokenUsage?: TokenUsage;
  };

  /**
   * Options for the generate function.
   */
  export interface GenerateOptions {
    model: LanguageModel;
    document: TextDocument;
    position: TextDocumentPositionParams;
    log?: Log;
  }

  /**
   * Unified generate function: request completions from a language model
   * at the cursor position.
   *
   * @param opts.model - prepared LanguageModel instance
   * @param opts.document - TextDocument to get completions for
   * @param opts.position - cursor position for completion
   * @param opts.log - optional logger for diagnostics/timing
   * @returns object with completions and optional token usage
   */
  export async function generate(opts: GenerateOptions): Promise<Result> {
    const { model, document, position, log } = opts;

    using _timer = log
      ? time(log, 'info', 'InlineCompletion.generate')
      : undefined;

    return await Chat.generate({
      model,
      document,
      position,
      log,
    });
  }
}
