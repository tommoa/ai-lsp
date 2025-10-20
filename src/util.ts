// Utility functions.

export type Level = 'info' | 'warn' | 'error' | 'debug';
export type Log = (
  level: Level,
  message: string,
  extra?: Record<string, any>,
) => void;

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

export namespace Parser {
  /**
   * Parses a string returned by an LLM (that is expected to contain a valid
   * JSON object) into a JavaScript object.
   *
   * @param raw - the raw text returned by the LLM
   * @param log - the logger to print diagnostics and timing
   * @returns an array of objects
   * @throws when parsing fails
   */
  export function parseResponse(raw: string, log?: Log): any[] {
    using _ = time(log!,
      'info', 'parseResponse processing response', { rawLength: raw.length });
    let parsed: [];
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Try to find a JSON array substring in the output. This is a
      // best-effort recovery for model outputs that include explanatory text.
      try {
        const start = raw.indexOf('[');
        const end = raw.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('Invalid JSON');
        const sub = raw.slice(start, end + 1);
        parsed = JSON.parse(sub);
      } catch (err) {
        log?.('error', `parseLLMResponse JSON parse error`);
        throw err as Error;
      }
    }
    if (!Array.isArray(parsed)) {
      const err = new Error('LLM response is not an array');
      throw err;
    }
    return parsed;
  }
}
