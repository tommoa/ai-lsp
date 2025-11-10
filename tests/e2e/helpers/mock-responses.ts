/**
 * Mock response helpers for testing.
 * These provide standard response formats for different test scenarios.
 */

/**
 * Base interface for mock edit items
 */
interface BaseEdit {
  text: string;
  reason: string;
}

/**
 * Inline completion item
 */
interface InlineCompletion extends BaseEdit {}

/**
 * Prefix/suffix edit item
 */
interface PrefixSuffixEdit extends BaseEdit {
  prefix: string;
  existing: string;
  suffix: string;
}

/**
 * Line number edit item
 */
interface LineNumberEdit extends BaseEdit {
  startLine: number;
  endLine: number;
}

/**
 * Default mock completions for inline completion
 */
const DEFAULT_INLINE_COMPLETIONS: InlineCompletion[] = [
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
 * Default mock edits for next-edit with prefix/suffix format
 */
const DEFAULT_PREFIX_SUFFIX_EDITS: PrefixSuffixEdit[] = [
  {
    prefix: 'function test() {\n  ',
    existing: '// TODO: implement',
    suffix: '\n}',
    text: 'return 42;',
    reason: 'implement simple return statement',
  },
];

/**
 * Default mock edits for next-edit with line number format
 */
const DEFAULT_LINE_NUMBER_EDITS: LineNumberEdit[] = [
  {
    startLine: 2,
    endLine: 2,
    text: '  return 42;',
    reason: 'implement function body',
  },
];

/**
 * Helper functions to generate response strings for common test cases.
 * Tests should use these to provide responses to the mock provider.
 */
export const mockResponses = {
  /** Default inline completion response */
  inline: () => JSON.stringify(DEFAULT_INLINE_COMPLETIONS),

  /** Default prefix/suffix edit response */
  prefixSuffix: () => JSON.stringify(DEFAULT_PREFIX_SUFFIX_EDITS),

  /** Default line number edit response */
  lineNumber: () => JSON.stringify(DEFAULT_LINE_NUMBER_EDITS),

  /** Malformed JSON for error testing */
  malformed: () => 'this is not valid JSON {[}',

  /** Custom data serialized to JSON */
  custom: (data: unknown) => JSON.stringify(data),
};
