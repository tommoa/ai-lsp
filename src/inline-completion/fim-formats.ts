/**
 * FIM (Fill-in-the-Middle) token formats for different model families.
 *
 * Different models use different special tokens to delimit the prefix,
 * suffix, and middle (gap to fill) sections. This module provides:
 * - Token format definitions for common model families
 * - Auto-detection of format from model name
 * - Helpers to build FIM prompts and stop sequences
 */

/**
 * Enum for FIM format types
 */
export enum FimFormat {
  OpenAI = 'openai',
  CodeLlama = 'codellama',
  Qwen = 'qwen',
  StarCoder = 'starcoder',
}

/**
 * Token markers for a specific FIM format
 */
export interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
}

/**
 * Token definitions for each FIM format.
 * Models are typically trained with one of these token schemes.
 */
export const FIM_FORMATS: Record<FimFormat, FimTokens> = {
  // OpenAI/DeepSeek/most models use this format
  openai: {
    prefix: '<fim_prefix>',
    suffix: '<fim_suffix>',
    middle: '<fim_middle>',
  },

  // CodeLlama models use this format
  codellama: {
    prefix: '<PRE>',
    suffix: '<SUF>',
    middle: '<MID>',
  },

  // Qwen models use this format
  qwen: {
    prefix: '<|fim_prefix|>',
    suffix: '<|fim_suffix|>',
    middle: '<|fim_middle|>',
  },

  // StarCoder models use same as openai
  starcoder: {
    prefix: '<fim_prefix>',
    suffix: '<fim_suffix>',
    middle: '<fim_middle>',
  },
};

/**
 * Detect FIM format from model name using heuristic-based detection.
 * Falls back to 'openai' format (most common) if no match found.
 *
 * @param modelName - Model name to detect format for
 * @returns Detected FIM format
 */
export function detectFimFormat(modelName: string): FimFormat {
  const lower = modelName.toLowerCase();

  if (lower.includes('codellama')) return FimFormat.CodeLlama;
  if (lower.includes('qwen')) return FimFormat.Qwen;
  if (lower.includes('starcoder')) return FimFormat.StarCoder;

  // Default to openai format (used by DeepSeek, most others)
  return FimFormat.OpenAI;
}

/**
 * Build a FIM prompt from prefix and suffix text.
 *
 * The prompt combines prefix, suffix, and middle tokens in the format
 * expected by the model, creating a fill-in-the-middle prompt where
 * the model generates the middle section.
 *
 * @param prefix - Text before the gap
 * @param suffix - Text after the gap
 * @param format - FIM token format to use (default: openai)
 * @returns Complete FIM prompt string
 */
export function buildFimPrompt(
  prefix: string,
  suffix: string,
  format: FimFormat = FimFormat.OpenAI,
): string {
  const tokens = FIM_FORMATS[format];
  return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;
}

/**
 * Build stop sequences for FIM completion.
 *
 * Stop sequences tell the model when to stop generating. For FIM, we use:
 * - The suffix token (model shouldn't generate into the suffix)
 * - The prefix token (safety measure)
 * - Double newline (natural code boundary)
 * - Optionally, a hint from the actual suffix (prevents generating past it)
 *
 * @param format - FIM token format (default: openai)
 * @param suffixHint - First few chars of actual suffix for smart stopping
 * @returns Array of stop sequences
 */
export function buildFimStopSequences(
  format: FimFormat = FimFormat.OpenAI,
  suffixHint?: string,
): string[] {
  const tokens = FIM_FORMATS[format];
  const stop = [tokens.suffix, tokens.prefix, '\n\n'];

  // Add suffix hint as stop sequence if provided
  // This helps the model avoid generating past the natural code boundary
  if (suffixHint && suffixHint.trim().length > 0) {
    const hint = suffixHint.trim().slice(0, 20);
    if (hint.length > 3) {
      stop.push(hint);
    }
  }

  return stop;
}
