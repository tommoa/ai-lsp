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
 * Benchmark-specific mock responses with deterministic data
 */
interface BenchmarkEdit extends BaseEdit {
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
}

/**
 * Deterministic edits for benchmark testing with consistent token counts
 */
const BENCHMARK_PREFIX_SUFFIX_EDITS: BenchmarkEdit[] = [
  {
    startLine: 0,
    endLine: 0,
    startChar: 10,
    endChar: 15,
    text: '42',
    reason: 'replace with constant',
  },
  {
    startLine: 1,
    endLine: 1,
    startChar: 5,
    endChar: 8,
    text: 'getName',
    reason: 'complete method call',
  },
];

const BENCHMARK_LINE_NUMBER_EDITS: BenchmarkEdit[] = [
  {
    startLine: 2,
    endLine: 2,
    startChar: 0,
    endChar: 5,
    text: 'const result = getValue();',
    reason: 'complete statement',
  },
];

const BENCHMARK_INLINE_COMPLETIONS: InlineCompletion[] = [
  {
    text: 'User | undefined',
    reason: 'type definition',
  },
  {
    text: 'id: number;',
    reason: 'property definition',
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

  /** Benchmark-specific prefix/suffix edits with deterministic data */
  benchmarkPrefixSuffix: () => JSON.stringify(BENCHMARK_PREFIX_SUFFIX_EDITS),

  /** Benchmark-specific line number edits with deterministic data */
  benchmarkLineNumber: () => JSON.stringify(BENCHMARK_LINE_NUMBER_EDITS),

  /** Benchmark-specific inline completions */
  benchmarkInline: () => JSON.stringify(BENCHMARK_INLINE_COMPLETIONS),

  /** Empty response for edge case testing */
  empty: () => JSON.stringify([]),

  /** Large dataset for performance testing */
  largeDataset: (count: number = 10) =>
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        text: `completion_${i}`,
        reason: `option ${i + 1}`,
      })),
    ),
};
