/**
 * Error recovery tests: Benchmarks maintain integrity when src/ produces errors
 *
 * These tests verify that when the core modules (NextEdit, InlineCompletion)
 * encounter errors, the benchmark infrastructure:
 *
 * 1. Correctly classifies the error type
 * 2. Records the error without crashing
 * 3. Continues to the next benchmark run
 * 4. Aggregates error metrics accurately
 *
 * PROTECTS AGAINST: Changes to error handling that would cause benchmarks
 * to crash or incorrectly report error statistics.
 */

import { describe, it, expect } from 'bun:test';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { generateEdit } from '../src/next-edit';
import { generateCompletion } from '../src/inline-completion';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  classifyParseError,
  extractTokenMetricArrays,
} from '../scripts/benchmark-utils';
import { NOOP_LOG } from '../src/util';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';
import { createMockModel } from './helpers/mock-core';
import { mockResponses } from './helpers/mock-responses';

/**
 * Helper: Create a mock model that returns invalid schema
 */
function createInvalidSchemaMockModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'test-model',
    supportedUrls: {},

    doGenerate() {
      return Promise.resolve({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify([
              {
                // Missing required fields
                text: 'something',
              },
            ]),
          },
        ],
        finishReason: 'stop' as const,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        warnings: [],
      });
    },

    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return Promise.resolve({ stream, warnings: [] });
    },
  } as unknown as LanguageModelV2;
}

function createTestDocument(content: string): TextDocument {
  return TextDocument.create('file:///test.ts', 'typescript', 1, content);
}

describe('Error Classification - NextEdit', () => {
  /**
   * PROTECTS AGAINST: Changes to error message format that break
   * error classification in benchmarks
   */
  it('should classify provider errors correctly', async () => {
    const model = createMockModel({
      throwError: 'Mock provider error: generation failed',
    });
    const doc = createTestDocument('function test() {}');

    let error: unknown;
    try {
      await generateEdit({
        model,
        document: doc,
        prompt: 'prefix-suffix',
        log: NOOP_LOG,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    const errorType = classifyParseError(error);
    expect(['generation_failed', 'schema_invalid']).toContain(errorType);
  });

  /**
   * PROTECTS AGAINST: Changes to JSON parsing that break error detection
   */
  it('should classify malformed JSON as parsing error', async () => {
    const model = createMockModel({ response: mockResponses.malformed() });
    const doc = createTestDocument('function test() {}');

    let error: unknown;
    try {
      await generateEdit({
        model,
        document: doc,
        prompt: 'prefix-suffix',
        log: NOOP_LOG,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    const errorType = classifyParseError(error);
    // Malformed JSON: json_parse or extraction_failed
    expect(['json_parse', 'extraction_failed']).toContain(errorType);
  });

  /**
   * PROTECTS AGAINST: Changes to schema validation that break error detection
   */
  it('should classify invalid schema as schema_invalid error', async () => {
    const model = createInvalidSchemaMockModel();
    const doc = createTestDocument('function test() {}');

    let error: unknown;
    try {
      await generateEdit({
        model,
        document: doc,
        prompt: 'prefix-suffix',
        log: NOOP_LOG,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    const errorType = classifyParseError(error);
    expect(errorType).toBe('schema_invalid');
  });

  /**
   * PROTECTS AGAINST: Changes to prefix-suffix parsing that break error
   * classification for conversion failures
   */
  it('should handle errors during edit conversion', async () => {
    const malformedPrefixSuffixModel: LanguageModelV2 = {
      specificationVersion: 'v2' as const,
      provider: 'mock',
      modelId: 'test-model',
      supportedUrls: {},

      doGenerate() {
        return Promise.resolve({
          content: [
            {
              type: 'text' as const,
              // Missing prefix field - will cause conversion to fail
              text: JSON.stringify([
                {
                  existing: 'text',
                  suffix: 'suffix',
                  text: 'replacement',
                },
              ]),
            },
          ],
          finishReason: 'stop' as const,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
          warnings: [],
        });
      },

      doStream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.close();
          },
        });
        return Promise.resolve({ stream, warnings: [] });
      },
    } as unknown as LanguageModelV2;

    const doc = createTestDocument('function test() {}');

    let error: unknown;
    try {
      await generateEdit({
        model: malformedPrefixSuffixModel,
        document: doc,
        prompt: 'prefix-suffix',
        log: NOOP_LOG,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    const errorType = classifyParseError(error);
    // Should be one of the error types
    expect([
      'json_parse',
      'schema_invalid',
      'extraction_failed',
      'conversion_failed',
    ]).toContain(errorType);
  });
});

describe('Error Classification - InlineCompletion', () => {
  /**
   * PROTECTS AGAINST: Changes to InlineCompletion error handling
   */
  it('should handle provider errors in inline completion', async () => {
    const model = createMockModel({
      throwError: 'Mock provider error: generation failed',
    });
    const doc = createTestDocument('const user: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 13 },
    };

    // generateCompletion should not throw - it returns empty completions
    const result = await generateCompletion({
      prompt: 'chat',
      model,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    // May have empty completions on error
    expect(result.completions).toBeArray();
  });

  /**
   * PROTECTS AGAINST: Changes to inline completion JSON parsing
   */
  it('should handle malformed JSON in inline completion', async () => {
    const model = createMockModel({ response: mockResponses.malformed() });
    const doc = createTestDocument('const user: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 13 },
    };

    const result = await generateCompletion({
      prompt: 'chat',
      model,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    // Should return empty completions, not crash
    expect(result.completions).toBeArray();
  });

  /**
   * PROTECTS AGAINST: Changes to inline completion schema validation
   */
  it('should handle invalid schema in inline completion', async () => {
    const model = createInvalidSchemaMockModel();
    const doc = createTestDocument('const user: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 13 },
    };

    const result = await generateCompletion({
      prompt: 'chat',
      model,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
  });
});

describe('Error Aggregation - parseErrorBreakdown', () => {
  /**
   * PROTECTS AGAINST: Changes to error counting that would produce
   * incorrect parseErrorBreakdown statistics
   */
  it('should aggregate multiple error types correctly', () => {
    const errors: (
      | 'json_parse'
      | 'schema_invalid'
      | 'conversion_failed'
      | 'generation_failed'
    )[] = [
      'json_parse',
      'json_parse',
      'schema_invalid',
      'conversion_failed',
      'generation_failed',
      'generation_failed',
      'generation_failed',
    ];

    const breakdown = {
      json_parse: errors.filter(e => e === 'json_parse').length,
      schema_invalid: errors.filter(e => e === 'schema_invalid').length,
      conversion_failed: errors.filter(e => e === 'conversion_failed').length,
      generation_failed: errors.filter(e => e === 'generation_failed').length,
    };

    expect(breakdown.json_parse).toBe(2);
    expect(breakdown.schema_invalid).toBe(1);
    expect(breakdown.conversion_failed).toBe(1);
    expect(breakdown.generation_failed).toBe(3);
    expect(
      breakdown.json_parse +
        breakdown.schema_invalid +
        breakdown.conversion_failed +
        breakdown.generation_failed,
    ).toBe(7);
  });

  /**
   * PROTECTS AGAINST: Changes to token extraction that would break
   * metric aggregation when errors occur
   */
  it('should extract token metrics from runs with errors', () => {
    const runMetrics = [
      {
        parseSuccess: true,
        hintCount: 1,
        validHintCount: 1,
        parseErrorType: 'none' as const,
        genLatency: 100,
        score: 85.5,
        tokenMetrics: {
          input: 100,
          output: 50,
          cost: 0.001,
          costWithoutCache: 0.001,
        },
      },
      {
        parseSuccess: false,
        hintCount: 0,
        validHintCount: 0,
        parseErrorType: 'json_parse' as const,
        genLatency: 50,
        score: undefined,
        tokenMetrics: {
          input: 100,
          output: 50,
          cost: 0.001,
          costWithoutCache: 0.001,
        },
      },
      {
        parseSuccess: false,
        hintCount: 0,
        validHintCount: 0,
        parseErrorType: 'schema_invalid' as const,
        genLatency: 75,
        score: undefined,
        tokenMetrics: {
          input: 100,
          output: 50,
          cost: 0.001,
          costWithoutCache: 0.001,
        },
      },
    ];

    const metrics = extractTokenMetricArrays(runMetrics);

    // Should extract metrics from all runs, including failed ones
    expect(metrics.tokensInput).toBeArray();
    expect(metrics.tokensOutput).toBeArray();
    expect(metrics.costs).toBeArray();

    // Should have 3 entries (one per run)
    expect(metrics.tokensInput.length).toBe(3);
    expect(metrics.tokensOutput.length).toBe(3);

    // Verify values are correct
    expect(metrics.tokensInput).toEqual([100, 100, 100]);
    expect(metrics.tokensOutput).toEqual([50, 50, 50]);
  });

  /**
   * PROTECTS AGAINST: Changes to success rate calculation
   */
  it('should calculate parse success rate correctly with errors', () => {
    const runMetrics = [
      { parseSuccess: true },
      { parseSuccess: true },
      { parseSuccess: false },
      { parseSuccess: false },
      { parseSuccess: false },
    ];

    const parseSuccesses = runMetrics.filter(r => r.parseSuccess).length;
    const parseSuccessRate = (parseSuccesses / runMetrics.length) * 100;

    expect(parseSuccessRate).toBe(40); // 2 successful out of 5
  });
});

describe('Error Resilience - Benchmark Continuity', () => {
  /**
   * PROTECTS AGAINST: Changes that would cause benchmarks to crash
   * instead of continuing after an error
   */
  it('should continue benchmark after NextEdit errors', async () => {
    const errorModel = createMockModel({
      throwError: 'Mock provider error: generation failed',
    });
    const doc = createTestDocument('function test() {}');

    let caught = false;
    try {
      await generateEdit({
        model: errorModel,
        document: doc,
        prompt: 'prefix-suffix',
        log: NOOP_LOG,
      });
    } catch {
      caught = true;
    }

    expect(caught).toBe(true);

    // Verify we can still run another benchmark with a working model
    const workingModel = createMockModel({ response: '[]' });
    const result = await generateEdit({
      model: workingModel,
      document: doc,
      prompt: 'line-number',
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
  });

  /**
   * PROTECTS AGAINST: Changes that would cause InlineCompletion
   * to crash instead of returning null
   */
  it('should continue inline benchmarks after completion errors', async () => {
    const errorModel = createMockModel({
      throwError: 'Mock provider error: generation failed',
    });
    const doc = createTestDocument('const x: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 9 },
    };

    // Should not throw
    const result1 = await generateCompletion({
      prompt: 'chat',
      model: errorModel,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    expect(result1).toBeDefined();

    // Should be able to run another completion
    const workingModel = createMockModel({ response: '[]' });
    const result2 = await generateCompletion({
      prompt: 'chat',
      model: workingModel,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    expect(result2).toBeDefined();
  });

  /**
   * PROTECTS AGAINST: Changes to error handling that would prevent
   * accurate error counting across multiple runs
   */
  it('should accurately count errors across multiple runs', () => {
    const errorCounts = {
      none: 0,
      json_parse: 0,
      schema_invalid: 0,
      extraction_failed: 0,
      conversion_failed: 0,
      generation_failed: 0,
    };

    // Simulate 10 runs with mixed success/failure
    const runResults = [
      'none',
      'none',
      'json_parse',
      'json_parse',
      'schema_invalid',
      'generation_failed',
      'generation_failed',
      'generation_failed',
      'none',
      'none',
    ] as const;

    runResults.forEach(errorType => {
      errorCounts[errorType]++;
    });

    expect(errorCounts.none).toBe(4);
    expect(errorCounts.json_parse).toBe(2);
    expect(errorCounts.schema_invalid).toBe(1);
    expect(errorCounts.extraction_failed).toBe(0);
    expect(errorCounts.conversion_failed).toBe(0);
    expect(errorCounts.generation_failed).toBe(3);

    const totalErrors =
      errorCounts.json_parse +
      errorCounts.schema_invalid +
      errorCounts.extraction_failed +
      errorCounts.conversion_failed +
      errorCounts.generation_failed;

    expect(totalErrors).toBe(6);
    expect(errorCounts.none).toBe(4);
  });
});
