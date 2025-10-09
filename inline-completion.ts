// TODO: Document this a little better and add some (maybe configurable)
// guard-rails.
import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, LanguageModel } from 'ai';
import { Log, time } from './util';

import INLINE_COMPLETION_PROMPT from './prompt/inline-completion.txt';

export namespace InlineCompletion {
  export async function generate(
    model: LanguageModel,
    document: TextDocument,
    position: TextDocumentPositionParams,
    completions?: number,
    log?: Log,
  ): Promise<string[] | null> {
    using _ = time(log!, 'info', 'InlineCompletion.generate');
    let docText = document.getText();
    let textBefore: string | undefined;
    let textAfter: string | undefined;
    if (docText) {
      const offset = document.offsetAt(position.position);
      textBefore = docText.slice(0, offset);
      textAfter = docText.slice(offset);
    }

    let prompt: string =
      `language: ${document.languageId ?? 'text'}\n` +
      `completions: ${completions ?? 5}\n\n` +
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

      if (text) {
        return text
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);
      }
    } catch (e) {
      console.error('Error generating inline completion:', e);
    }

    return null;
  }
}
