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
import { FIM } from './inline-completion/fim';
import { isUnsupportedPromptError } from './inline-completion/errors';
import { type FimTemplate } from './inline-completion/fim-formats';

export namespace InlineCompletion {
  /**
   * Enum for inline completion prompt types
   */
  export enum PromptType {
    Chat = 'chat',
    FIM = 'fim',
  }
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
    /**
     * Inline completion prompt strategy (default: 'chat').
     * - 'chat': Chat-based completion, works with any model
     * - 'fim': Fill-in-the-Middle, efficient for specialized models
     */
    prompt?: PromptType;
    /**
     * FIM template for prompt construction. Only used when prompt='fim'.
     */
    fimFormat?: FimTemplate;
    /**
     * Maximum tokens to generate (default: 256 for FIM, 1000 for chat).
     */
    maxTokens?: number;
  }

  /**
   * Unified generate function: request completions from a language model
   * at the cursor position.
   *
   * Routes to Chat or FIM implementation based on the 'prompt' option.
   * Falls back to Chat if FIM is requested but unsupported.
   *
   * @param opts.model - prepared LanguageModel instance
   * @param opts.document - TextDocument to get completions for
   * @param opts.position - cursor position for completion
   * @param opts.log - optional logger for diagnostics/timing
   * @param opts.prompt - completion strategy ('chat' or 'fim', default:
   *                      'chat')
   * @param opts.fimFormat - FIM template for prompt construction (required
   *                         if prompt='fim')
   * @param opts.maxTokens - max tokens to generate (default based on
   *                         prompt)
   * @returns object with completions and optional token usage
   * @throws UnsupportedPromptError if FIM is requested but model is
   *         incompatible and fallback is disabled
   */
  export async function generate(opts: GenerateOptions): Promise<Result> {
    const {
      model,
      document,
      position,
      log,
      prompt = 'chat',
      fimFormat,
      maxTokens,
    } = opts;

    using _timer = log
      ? time(log, 'info', 'InlineCompletion.generate')
      : undefined;

    if (prompt === 'fim') {
      // fimFormat is guaranteed to be defined when prompt='fim' because
      // it's resolved during initialization in index.ts
      return await FIM.generate({
        model,
        document,
        position,
        log,
        fimFormat: fimFormat!,
        maxTokens: maxTokens ?? 256,
      });
    }

    // Default to Chat (doesn't accept maxTokens, uses fixed limit)
    return await Chat.generate({
      model,
      document,
      position,
      log,
    });
  }
}
