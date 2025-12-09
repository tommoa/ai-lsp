/**
 * Chat-based inline completion.
 *
 * Uses chat/instruction-following models with system prompts.
 * Universal approach that works with any LLM (Claude, GPT-4, Gemini, etc.)
 * but less token-efficient than FIM.
 */

import { generateText, type ModelMessage } from 'ai';
import { time, extractTokenUsage } from '../util';
import { parseResponse } from '../parser';
import { type Result, type Completion, type GenerateOptions } from './types';

import INLINE_COMPLETION_PROMPT from '../../prompt/inline-completion.txt';

interface RawCompletion {
  text?: unknown;
  reason?: unknown;
}

/**
 * Validate and normalize a completion object from LLM response
 */
function validateCompletion(item: unknown): Completion | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as RawCompletion;
  if (!raw.text || typeof raw.text !== 'string') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return { text: raw.text, reason };
}

export interface Options extends GenerateOptions {
  prompt: 'chat';
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
 * @returns Result with completions array (empty if generation fails)
 */
export async function generate(opts: Options): Promise<Result> {
  const { model, document, position, log } = opts;
  using _ = time(log, 'info', 'generateCompletion (chat)');

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

  log('debug', JSON.stringify(messages));

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
      return { completions: [], tokenUsage };
    }

    // Parse the JSON response from the model
    const parsed = parseResponse(text, log);
    const normalized: Completion[] = parsed
      .map(validateCompletion)
      .filter((c): c is Completion => c !== null);

    if (normalized.length === 0) {
      log(
        'warn',
        'generateCompletion (chat): parsed array contained no valid items',
      );
      return { completions: [], tokenUsage };
    }

    return { completions: normalized, tokenUsage };
  } catch (err) {
    log('error', 'generateCompletion (chat): text generation failed', {
      err: String(err),
    });
    return { completions: [] };
  }
}
