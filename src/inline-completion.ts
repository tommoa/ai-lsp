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

import { time } from './util';
import { Chat } from './inline-completion/chat';
import { FIM } from './inline-completion/fim';
import type {
  Result as _Result,
  Completion as _Completion,
} from './inline-completion/types';

export namespace InlineCompletion {
  export type Result = _Result;
  export type Completion = _Completion;

  /**
   * Options for the generate function.
   */
  export type Options = FIM.Options | Chat.Options;

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
  export async function generate(opts: Options): Promise<Result> {
    const { log, prompt = 'chat' } = opts;

    using _timer = time(log, 'info', 'InlineCompletion.generate');

    if (prompt === 'fim') {
      return FIM.generate(opts as FIM.Options);
    } else {
      return Chat.generate(opts as Chat.Options);
    }
  }
}
