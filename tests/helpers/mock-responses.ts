/**
 * Mock response helpers for testing.
 * These provide standard response formats for different test scenarios.
 *
 * Usage:
 * - Import the default responses for simple cases
 * - Import the types to create custom test data with JSON.stringify
 *
 * @example
 * ```typescript
 * // Use defaults:
 * const response = mockResponses.inline();
 *
 * // Create custom data:
 * import { DEFAULT_INLINE_COMPLETIONS } from './helpers/mock-responses';
 * const custom = JSON.stringify([
 *   ...DEFAULT_INLINE_COMPLETIONS,
 *   { text: 'extra' },
 * ]);
 *
 * // Or create fully custom:
 * const custom = JSON.stringify([{ text: 'my text', reason: 'my reason' }]);
 * ```
 */

/**
 * Base interface for mock edit items
 */
interface BaseEdit {
  text: string;
  reason?: string;
}

/**
 * Inline completion item
 */
export interface InlineCompletion extends BaseEdit {}

/**
 * Prefix/suffix edit item
 */
export interface PrefixSuffixEdit extends BaseEdit {
  prefix: string;
  existing: string;
  suffix: string;
}

/**
 * Line number edit item
 */
export interface LineNumberEdit extends BaseEdit {
  startLine: number;
  endLine: number;
}

/**
 * Default mock completions for inline completion.
 * Export for reuse in tests that need to extend or modify them.
 */
export const DEFAULT_INLINE_COMPLETIONS: InlineCompletion[] = [
  {
    text: 'onstant myVar = 1;',
    reason: 'complete declaration',
  },
  {
    text: 'lass MyClass {}',
    reason: 'complete class definition',
  },
];

/**
 * Default mock edits for next-edit with prefix/suffix format.
 * Export for reuse in tests that need to extend or modify them.
 */
export const DEFAULT_PREFIX_SUFFIX_EDITS: PrefixSuffixEdit[] = [
  {
    prefix: 'function test() {\n  ',
    existing: '// TODO: implement',
    suffix: '\n}',
    text: 'return 42;',
    reason: 'implement simple return statement',
  },
];

/**
 * Default mock edits for next-edit with line number format.
 * Export for reuse in tests that need to extend or modify them.
 */
export const DEFAULT_LINE_NUMBER_EDITS: LineNumberEdit[] = [
  {
    startLine: 2,
    endLine: 2,
    text: '  return 42;',
    reason: 'implement function body',
  },
];

/**
 * Default FIM (Fill-In-the-Middle) completion text.
 * Export for reuse in tests.
 */
export const DEFAULT_FIM_COMPLETION = ' complete_text';

/**
 * Helper functions to generate response strings for common test cases.
 * Tests should use these to provide responses to the mock provider.
 *
 * For custom responses, use JSON.stringify directly with your own data.
 */
export const mockResponses = {
  /** Default inline completion response */
  inline: () => JSON.stringify(DEFAULT_INLINE_COMPLETIONS),

  /** Default prefix/suffix edit response */
  prefixSuffix: () => JSON.stringify(DEFAULT_PREFIX_SUFFIX_EDITS),

  /** Default line number edit response */
  lineNumber: () => JSON.stringify(DEFAULT_LINE_NUMBER_EDITS),

  /** Default FIM (Fill-In-the-Middle) raw text completion */
  fim: () => DEFAULT_FIM_COMPLETION,

  /** Malformed JSON for error testing */
  malformed: () => 'this is not valid JSON {[}',

  /** Empty response */
  empty: () => '',
};
