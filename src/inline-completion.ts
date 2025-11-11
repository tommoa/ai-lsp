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
import {
  UnsupportedPromptError,
  isUnsupportedPromptError,
} from './inline-completion/errors';
import { type FimFormat } from './inline-completion/fim-formats';

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
    * Type of inline completion prompt to use.
    * - 'chat': Use chat-based completion (default, supports all models)
    * - 'fim': Use Fill-in-the-Middle (efficient for code-specific models)
    */
   export type PromptType = 'chat' | 'fim';

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
      * Model name for FIM format auto-detection.
      * Required when prompt='fim' for automatic format detection.
      */
     modelName?: string;
     /**
      * Explicit FIM format (optional). If specified, skips auto-detection.
      */
     fimFormat?: FimFormat;
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
    * @param opts.prompt - completion strategy ('chat' or 'fim', default: 'chat')
    * @param opts.modelName - model name for FIM format detection
    * @param opts.fimFormat - explicit FIM format (skips auto-detection)
    * @param opts.maxTokens - max tokens to generate (default based on prompt)
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
       modelName,
       fimFormat,
       maxTokens,
     } = opts;

     using _timer = log
       ? time(log, 'info', 'InlineCompletion.generate')
       : undefined;

     // Route to appropriate implementation
     if (prompt === 'fim') {
       try {
         return await FIM.generate({
           model,
           document,
           position,
           log,
           format: fimFormat,
           modelName,
           maxTokens: maxTokens ?? 256, // FIM default: 256 tokens
         });
       } catch (err) {
         // If FIM throws UnsupportedPromptError, log and re-throw
         if (isUnsupportedPromptError(err)) {
           log?.('warn', 'FIM not supported, re-throwing error', {
             reason: err.reason,
             modelName: err.modelName,
           });
           throw err;
         }
         // Re-throw other errors as-is
         throw err;
       }
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
