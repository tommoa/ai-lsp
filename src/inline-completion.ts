// TODO: Document this a little better and add some (maybe configurable)
// guard-rails.
import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, type LanguageModel } from 'ai';
import type { ModelMessage } from 'ai';
import { Log, time, Parser } from './util';

import INLINE_COMPLETION_PROMPT from '../prompt/inline-completion.txt';

export namespace InlineCompletion {
  export type Completion = { text: string; reason?: string };

  export async function generate(
    model: LanguageModel,
    document: TextDocument,
    position: TextDocumentPositionParams,
    log?: Log,
  ): Promise<Completion[] | null> {
    using _ = time(log!, 'info', 'InlineCompletion.generate');
    let docText = document.getText();
    let textBefore: string | undefined;
    let textAfter: string | undefined;
    if (docText) {
      const offset = document.offsetAt(position.position);
      textBefore = docText.slice(0, offset);
      textAfter = docText.slice(offset);
    }

    const messages: ModelMessage[] = [
      { role: 'system', content: INLINE_COMPLETION_PROMPT },
      {
        role: 'user',
        content: `Language: ${document.languageId ?? 'text'}`,
      },
      {
        role: 'user',
        content: `Content before cursor:\n${textBefore}`,
      },
      {
        role: 'user',
        content: `Content after cursor:\n${textAfter}`,
      },
      {
        role: 'user',
        content: 'Provide completion suggestions for the cursor position.',
      },
    ];

    log?.('debug', JSON.stringify(messages));

    try {
      const { text } = await generateText({
        model,
        messages,
        maxOutputTokens: 1000,
      });

      if (!text) return null;

      const parsed = Parser.parseResponse(text, log);
      const normalized: Completion[] = (parsed as any[])
        .map((item: any) => {
          if (!item || typeof item !== 'object') return null;
          const t = typeof item.text === 'string' ? item.text : null;
          const r = typeof item.reason === 'string' ? item.reason : '';
          if (t === null) return null;
          return { text: t, reason: r } as Completion;
        })
        .filter(Boolean) as Completion[];

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
