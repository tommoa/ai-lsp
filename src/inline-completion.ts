// TODO: Document this a little better and add some (maybe configurable)
// guard-rails.
import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, type LanguageModel } from 'ai';
import type { ModelMessage } from 'ai';
import { Log, time, Parser } from './util';

import INLINE_COMPLETION_PROMPT from '../prompt/inline-completion.txt';

/**
 * Validate and normalize a completion object from LLM response
 */
function validateCompletion(item: any): InlineCompletion.Completion | null {
  if (!item?.text || typeof item.text !== 'string') return null;
  return { text: item.text, reason: item.reason ?? '' };
}

export namespace InlineCompletion {
  export type Completion = { text: string; reason?: string };

  /**
   * Type for custom generate functions. Allows for injection of custom
   * generation logic for testing or token tracking.
   */
  export type GenerateFn = (params: {
    model: LanguageModel;
    messages: ModelMessage[];
  }) => Promise<{ text?: string }>;

  /**
   * Options for the generate function.
   */
  export interface GenerateOptions {
    model: LanguageModel;
    document: TextDocument;
    position: TextDocumentPositionParams;
    log?: Log;
    generateFn?: GenerateFn;
  }

  export async function generate(
    opts: GenerateOptions,
  ): Promise<Completion[] | null> {
    const { model, document, position, log, generateFn } = opts;
    using _ = log ? time(log, 'info', 'InlineCompletion.generate') : undefined;

    const docText = document.getText();
    const offset = document.offsetAt(position.position);
    const textBefore = docText.slice(0, offset);
    const textAfter = docText.slice(offset);

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
      const res = await (generateFn
        ? generateFn({ model, messages })
        : generateText({
            model,
            messages,
            maxOutputTokens: 1000,
          }));
      const { text } = res as { text?: string };

      if (!text) return null;

      const parsed = Parser.parseResponse(text, log);
      const normalized: Completion[] = (parsed as any[])
        .map(validateCompletion)
        .filter((c): c is Completion => c !== null);

      if (normalized.length === 0) {
        log?.(
          'warn',
          'InlineCompletion: parsed array contained no valid items',
        );
        return null;
      }

      return normalized;
    } catch (err) {
      log?.('error', 'InlineCompletion: text generation failed', {
        err: String(err),
      });
      return null;
    }
  }
}
