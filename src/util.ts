// Utility functions.

export type Level = 'info' | 'warn' | 'error' | 'debug';
export type Log = (
  level: Level,
  message: string,
  extra?: Record<string, any>,
) => void;

/**
 * No-op logger that does nothing. Use this when logging is not needed.
 */
export const NOOP_LOG: Log = (_level, _message, _extra) => {};

/**
 * Times a function for how long it takes.
 *
 * @param log - The logging function to use.
 * @param level - The level to log at.
 * @param message - The message to log.
 * @param extra - Any extra information to include.
 */
export function time(
  log: Log,
  level: Level,
  message: string,
  extra?: Record<string, any>,
) {
  const now = Date.now();
  log(level, message, { status: 'started', ...extra });
  function stop() {
    log(level, message, {
      status: 'completed',
      duration: Date.now() - now,
      ...extra,
    });
  }
  return {
    stop,
    [Symbol.dispose]() {
      stop();
    },
  };
}

export type TokenUsage = {
  input: number;
  output: number;
  reasoning?: number;
  cachedInput?: number;
};

/**
 * Extract token usage from AI SDK generateText response.
 *
 * @param res - response from generateText
 * @returns token usage or null if not available
 */
/**
 * Normalize CRLF -> LF. Used for stable newline handling across operations.
 */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * Clip a long string for safe logging. Returns the original string when its
 * length is <= `n`.
 */
export function clip(s: string, n = 200): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '...';
}

/**
 * Clean FIM completion response by removing markdown fences and echoed
 * prompt context.
 *
 * Some chat models (like Google Gemini) respond to FIM prompts by:
 * 1. Wrapping the response in markdown code fences
 * 2. Including the prefix context before the actual completion
 *
 * This function strips both to extract just the new completion text.
 *
 * @param text - The raw completion text from the model
 * @param prefix - The prefix context sent in the FIM prompt
 * @returns Cleaned completion text
 */
export function cleanFimResponse(text: string, prefix: string): string {
  const trimmed = text.trim();

  // Strip markdown fences: handles both complete (```lang\ncode\n```)
  // and incomplete (```lang\ncode) fences
  const fence = trimmed.match(/^```\S*\n([\s\S]*?)(?:\n```)?$/);
  let cleaned = fence?.[1] ?? text;

  // If the response starts with the prefix, remove it to get just the
  // completion
  if (prefix && cleaned.startsWith(prefix)) {
    cleaned = cleaned.slice(prefix.length);
  }

  return cleaned;
}

export function extractTokenUsage(res: any): TokenUsage | null {
  if (!res || typeof res !== 'object') return null;

  const usage =
    res.usage ?? res.result?.usage ?? res.token_usage ?? res.meta?.usage;
  if (!usage) return null;

  const {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens,
    cachedInputTokens,
  } = usage;

  if (typeof input !== 'number' || typeof output !== 'number') return null;

  const result: TokenUsage = { input, output };

  if (typeof reasoningTokens === 'number' && reasoningTokens > 0) {
    result.reasoning = reasoningTokens;
  }
  if (typeof cachedInputTokens === 'number' && cachedInputTokens > 0) {
    result.cachedInput = cachedInputTokens;
  }

  return result;
}
