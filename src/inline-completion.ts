// TODO: Document this a little better and add some (maybe configurable)
// guard-rails.
import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, LanguageModel } from 'ai';
import { Log, time } from './util';

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

    const prompt: string =
      `language: ${document.languageId ?? 'text'}\n` +
      textBefore +
      '<cursor>' +
      textAfter;

    log?.('debug', prompt);

    try {
      const { text } = await generateText({
        model,
        system: INLINE_COMPLETION_PROMPT,
        prompt,
        maxOutputTokens: 1000,
      });

      if (!text) return null;

      // Scan the model output and extract the first balanced JSON array.
      // The scanner ignores brackets inside string literals to avoid
      // mismatches caused by text content or commentary around the JSON.
      const extractFirstBalancedArray = (s: string): string | null => {
        const start = s.indexOf('[');
        if (start === -1) return null;
        let depth = 0;
        let inString: string | null = null;
        let escape = false;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (inString) {
            if (escape) {
              escape = false;
            } else if (ch === '\\') {
              escape = true;
            } else if (ch === inString) {
              inString = null;
            }
          } else {
            if (ch === '"' || ch === "'") {
              inString = ch;
            } else if (ch === '[') {
              depth++;
            } else if (ch === ']') {
              depth--;
              if (depth === 0) return s.slice(start, i + 1);
            }
          }
        }
        return null;
      };

      const arrSlice = extractFirstBalancedArray(text);
      if (!arrSlice) {
        log?.('error', 'InlineCompletion: no JSON array found in model output');
        return null;
      }

      try {
        const parsed = JSON.parse(arrSlice) as unknown;
        if (!Array.isArray(parsed)) {
          log?.('error', 'InlineCompletion: extracted JSON is not an array');
          return null;
        }

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
        log?.(
          'error',
          'InlineCompletion: failed to parse extracted JSON array',
          { err: String(err) },
        );
        return null;
      }
    } catch (e) {
      console.error('Error generating inline completion:', e);
    }

    return null;
  }
}
