/**
 * FIM (Fill-in-the-Middle) based inline completion.
 *
 * Uses native code infilling models with special FIM tokens.
 * More efficient than chat-based approach but limited to FIM-capable models
 * (DeepSeek Coder, StarCoder, CodeLlama, Qwen, etc.).
 *
 * The FIM approach:
 * 1. Takes text before cursor (prefix) and after cursor (suffix)
 * 2. Builds prompt with FIM special tokens: <prefix>...<suffix>...<middle>
 * 3. Model generates the middle section (the gap to fill)
 * 4. Returns raw completion text (no JSON parsing needed)
 */

import { type TextDocumentPositionParams } from 'vscode-languageserver/node';
import { type TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, type LanguageModel } from 'ai';
import {
  Log,
  time,
  type TokenUsage,
  extractTokenUsage,
  cleanFimResponse,
} from '../util';
import { buildFimPrompt, type FimTemplate } from './fim-formats';
import { UnsupportedPromptError } from './errors';

export namespace FIM {
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
    /**
     * FIM template to use for prompt construction (required).
     */
    fimFormat: FimTemplate;
    /**
     * Maximum tokens to generate (default: 256).
     * FIM completions are typically shorter than chat (50-256 tokens).
     */
    maxTokens?: number;
  }

  /**
   * Generate inline completions using FIM (Fill-in-the-Middle).
   *
   * Constructs a FIM prompt with:
   * - Prefix tokens + text before cursor
   * - Suffix tokens + text after cursor
   * - Middle token (where model generates)
   *
   * The model returns raw completion text which is wrapped in a result object.
   *
   * @param opts - Generation options
   * @returns Result with completions or null if generation fails
   * @throws UnsupportedPromptError if the model doesn't support FIM
   */
  export async function generate(opts: GenerateOptions): Promise<Result> {
    const { model, document, position, log, fimFormat, maxTokens = 256 } = opts;

    using _ = log
      ? time(log, 'info', 'InlineCompletion.FIM.generate')
      : undefined;

    // Extract prefix and suffix from document
    const docText = document.getText();
    const offset = document.offsetAt(position.position);
    const textBefore = docText.slice(0, offset);
    const textAfter = docText.slice(offset);

    log?.('debug', `FIM format: ${fimFormat.name || 'custom'}`);

    // Build FIM prompt with template
    const prompt = buildFimPrompt(fimFormat, {
      prefix: textBefore,
      suffix: textAfter,
    });
    const stopSequences = fimFormat.stop;

    log?.('debug', `FIM prompt length: ${prompt.length}`);
    log?.('debug', `FIM stop sequences: ${JSON.stringify(stopSequences)}`);

    try {
      const res = await generateText({
        model,
        prompt, // String prompt, not messages array!
        maxOutputTokens: maxTokens,
        temperature: 0.2, // Lower temp for consistent code completion
        stopSequences,
      });

      let completionText = (res as { text?: string }).text ?? '';
      const tokenUsage = extractTokenUsage(res) ?? undefined;

      // Clean FIM response: strip markdown fences and remove echoed prefix
      // (some chat models like Gemini wrap responses and echo the prompt)
      completionText = cleanFimResponse(completionText, textBefore);

      if (!completionText || completionText.trim().length === 0) {
        log?.('info', 'FIM: empty completion');
        return { completions: null, tokenUsage };
      }

      // FIM returns raw text, wrap in completion object
      const completions: Completion[] = [
        {
          text: completionText,
          reason: 'fim', // Simple reason since FIM doesn't provide explanations
        },
      ];

      log?.('info', `FIM: generated ${completionText.length} chars`);
      return { completions, tokenUsage };
    } catch (err) {
      const errMsg = String(err);

      // Detect if error is due to FIM not being supported
      if (isFimNotSupportedError(errMsg)) {
        throw new UnsupportedPromptError(
          'fim',
          'Model does not support completion endpoint or FIM tokens',
        );
      }

      // Re-throw other errors as-is
      log?.('error', 'FIM: text generation failed', {
        err: errMsg,
      });
      throw err;
    }
  }

  /**
   * Detect if error indicates FIM is not supported by the model/provider.
   *
   * Looks for common error patterns that indicate the completion endpoint
   * or FIM tokens are not supported.
   *
   * @param errorMsg - Error message to check
   * @returns true if error indicates FIM is unsupported
   */
  function isFimNotSupportedError(errorMsg: string): boolean {
    const patterns = [
      'completion endpoint',
      'not implemented',
      'unsupported',
      'invalid request',
      'method not allowed',
      'endpoint not found',
      '404',
      'does not support',
    ];

    const lower = errorMsg.toLowerCase();
    return patterns.some(pattern => lower.includes(pattern));
  }
}
