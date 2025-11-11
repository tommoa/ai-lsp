/**
 * Chat-based inline completion.
 *
 * Uses chat/instruction-following models with system prompts.
 * Universal approach that works with any LLM (Claude, GPT-4, Gemini, etc.)
 * but less token-efficient than FIM.
 */

import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, type LanguageModel } from 'ai';
import type { ModelMessage } from 'ai';
import { Log, time, Parser, type TokenUsage, extractTokenUsage } from '../util';

import INLINE_COMPLETION_PROMPT from '../../prompt/inline-completion.txt';

/**
 * Validate and normalize a completion object from LLM response
 */
function validateCompletion(item: any): Chat.Completion | null {
  if (!item?.text || typeof item.text !== 'string') return null;
  return { text: item.text, reason: item.reason ?? '' };
}

export namespace Chat {
  export type Completion = {
    text: string;
    reason?: string;
  };

  export type Result = {
    completions: Completion[] | null;
    tokenUsage?: TokenUsage;
  };

  export interface GenerateOptions {
    model: LanguageModel;
    document: TextDocument;
    position: TextDocumentPositionParams;
    log?: Log;
  }

  /**
   * Generate inline completions using a chat-based LLM.
   *
   * Constructs a message array with:
   * - System prompt that instructs the model to provide code completions
   * - Language context (file language identifier)
   * - Code context (text before and after cursor position)
   *
   * The model returns JSON-formatted completions which are parsed and
   * validated before returning to the caller.
   *
   * @param opts - Generation options including model, document, and position
   * @returns Result with completions array or null if generation fails
   */
  export async function generate(opts: GenerateOptions): Promise<Result> {
    const { model, document, position, log } = opts;
    using _ = log
      ? time(log, 'info', 'InlineCompletion.Chat.generate')
      : undefined;

    const docText = document.getText();
    const offset = document.offsetAt(position.position);
    const textBefore = docText.slice(0, offset);
    const textAfter = docText.slice(offset);

    // Construct messages with full context:
    // language, before, after, and instruction
    const messages: ModelMessage[] = [
      { role: 'system', content: INLINE_COMPLETION_PROMPT },
      { role: 'user', content: `Language: ${document.languageId ?? 'text'}` },
      { role: 'user', content: `Content before cursor:\n${textBefore}` },
      { role: 'user', content: `Content after cursor:\n${textAfter}` },
      {
        role: 'user',
        content: 'Provide completion suggestions for the cursor position.',
      },
    ];

    log?.('debug', JSON.stringify(messages));

    try {
      const res = await generateText({
        model,
        messages,
        maxOutputTokens: 1000,
      });
      const { text } = res as { text?: string };

      // Extract token usage from response
      const tokenUsage = extractTokenUsage(res) ?? undefined;

      if (!text) {
        return { completions: null, tokenUsage };
      }

      // Parse the JSON response from the model
      const parsed = Parser.parseResponse(text, log);
      const normalized: Completion[] = (parsed as any[])
        .map(validateCompletion)
        .filter((c): c is Completion => c !== null);

      if (normalized.length === 0) {
        log?.(
          'warn',
          'InlineCompletion.Chat: parsed array contained no valid items',
        );
        return { completions: null, tokenUsage };
      }

      return { completions: normalized, tokenUsage };
    } catch (err) {
      log?.('error', 'InlineCompletion.Chat: text generation failed', {
        err: String(err),
      });
      return { completions: null };
    }
  }
}
