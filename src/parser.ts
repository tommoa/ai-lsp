import type { Log } from './util';
import { time } from './util';

/**
 * Attempts to extract and parse JSON from a string by finding
 * the first and last occurrence of the given delimiters.
 *
 * @param raw - the raw text to search
 * @param openDelim - opening delimiter (e.g. '{' or '[')
 * @param closeDelim - closing delimiter (e.g. '}' or ']')
 * @returns the parsed JSON object/array, or null if extraction/parsing fails
 */
function extractJSON<T>(
  raw: string,
  openDelim: string,
  closeDelim: string,
): T | null {
  const start = raw.indexOf(openDelim);
  const end = raw.lastIndexOf(closeDelim);
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * Parses a string returned by an LLM (that is expected to contain a valid
 * JSON object) into a JavaScript object. Includes a fallback to extract
 * the first JSON object if the entire response is not valid JSON.
 *
 * @param raw - the raw text returned by the LLM
 * @returns the parsed JSON object, or null if parsing fails
 */
export function parseJSONObject(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Try to find a JSON object substring in the output. This is a
    // best-effort recovery for model outputs that include explanatory text.
    return extractJSON<Record<string, unknown>>(raw, '{', '}');
  }
}

/**
 * Parses a string returned by an LLM (that is expected to contain a valid
 * JSON array) into a JavaScript array.
 *
 * @param raw - the raw text returned by the LLM
 * @param log - the logger to print diagnostics and timing
 * @returns an array of objects
 * @throws when parsing fails
 */
export function parseResponse(raw: string, log?: Log): unknown[] {
  using _ = log
    ? time(log, 'info', 'parseResponse processing response', {
        rawLength: raw.length,
      })
    : undefined;
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      throw new Error('LLM response is not an array');
    }
    return parsed;
  } catch {
    // Try to find a JSON array substring in the output. This is a
    // best-effort recovery for model outputs that include explanatory text.
    const parsed = extractJSON<unknown[]>(raw, '[', ']');
    if (!Array.isArray(parsed)) {
      log?.('error', `parseLLMResponse JSON parse error`);
      throw new Error('LLM response is not an array');
    }
    return parsed;
  }
}
