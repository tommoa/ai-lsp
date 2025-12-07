/**
 * Inline completion: generate code completions at cursor position.
 *
 * Supports multiple prompt strategies for different use cases.
 * Each implementation produces the same output shape.
 *
 * Public API
 * - generateCompletion({model,document,position,log}): unified entry point
 */

import { time } from './util';
import {
  generate as generateChat,
  type Options as ChatOptions,
} from './inline-completion/chat';
import {
  generate as generateFim,
  type Options as FimOptions,
} from './inline-completion/fim';
import type { Result, Completion } from './inline-completion/types';

export type { Result, Completion };

/**
 * Options for the generateCompletion function.
 */
export type Options = FimOptions | ChatOptions;

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
export async function generateCompletion(opts: Options): Promise<Result> {
  const { log, prompt = 'chat' } = opts;

  using _timer = time(log, 'info', 'generateCompletion');

  if (prompt === 'fim') {
    return generateFim(opts as FimOptions);
  } else {
    return generateChat(opts as ChatOptions);
  }
}
