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

import { generateText } from 'ai';
import { time, extractTokenUsage, cleanFimResponse } from '../util';
import {
  buildFimPrompt,
  type FimTemplate,
  type FimContext,
} from './fim-formats';
import { UnsupportedPromptError } from './errors';
import { type Completion, type Result, type GenerateOptions } from './types';

export interface Options extends GenerateOptions {
  prompt: 'fim';
  /**
   * FIM template to use for prompt construction (required).
   */
  fimFormat: FimTemplate;
  /**
   * Maximum tokens to generate (default: 256).
   * FIM completions are typically shorter than chat (50-256 tokens).
   */
  maxTokens?: number;
  /**
   * Workspace root URI for extracting repository context (optional).
   */
  workspaceRootUri?: string | null;
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
 * @returns Result with completions array (empty if generation fails)
 * @throws UnsupportedPromptError if the model doesn't support FIM
 */
export async function generate(opts: Options): Promise<Result> {
  const {
    model,
    document,
    position,
    log,
    fimFormat,
    maxTokens = 256,
    workspaceRootUri,
  } = opts;

  using _ = time(log, 'info', 'generateCompletion (fim)');

  // Extract prefix and suffix from document
  const docText = document.getText();
  const offset = document.offsetAt(position.position);
  const textBefore = docText.slice(0, offset);
  const textAfter = docText.slice(offset);

  // Extract file path from document URI
  const documentUri = position.textDocument.uri;
  const filePath = documentUri.startsWith('file://')
    ? decodeURIComponent(documentUri.slice(7))
    : documentUri;

  // Extract repo name from workspace root
  let repoName = 'unknown';
  if (workspaceRootUri) {
    const rootPath = workspaceRootUri.startsWith('file://')
      ? decodeURIComponent(workspaceRootUri.slice(7))
      : workspaceRootUri;
    const segments = rootPath.split('/').filter(Boolean);
    repoName = segments[segments.length - 1] ?? 'unknown';
  }

  log('debug', `FIM format: ${fimFormat.name ?? 'custom'}`);

  // Build FIM prompt with template and typed context
  const context: FimContext = {
    prefix: textBefore,
    suffix: textAfter,
    repo_name: repoName,
    file_path: filePath,
  };
  const prompt = buildFimPrompt(fimFormat, context);
  const stopSequences = fimFormat.stop;

  log('debug', `FIM prompt length: ${prompt.length}`);
  log('debug', `FIM stop sequences: ${JSON.stringify(stopSequences)}`);

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
      log('info', 'generateCompletion (fim): empty completion');
      return { completions: [], tokenUsage };
    }

    // FIM returns raw text, wrap in completion object
    const completions: Completion[] = [
      {
        text: completionText,
        reason: 'fim', // Simple reason since FIM doesn't provide explanations
      },
    ];

    log(
      'info',
      `generateCompletion (fim): generated ${completionText.length} chars`,
    );
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
    log('error', 'generateCompletion (fim): text generation failed', {
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
