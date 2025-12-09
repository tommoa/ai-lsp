/**
 * Integration tests: src/ modules with benchmark infrastructure
 *
 * These tests verify that breaking changes in src/ will be caught by the
 * benchmark test suite. They validate the critical paths:
 *
 * 1. generateEdit() → edits → createEditDiff() → rateChange()
 * 2. generateCompletion() → completions → cost calculation
 * 3. Full benchmark script execution with mock providers
 *
 * These tests are the PRIMARY DEFENSE against breaking changes in src/
 * that would silently break benchmarks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { generateEdit } from '../src/next-edit';
import { generateCompletion } from '../src/inline-completion';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  createEditDiff,
  calculateCost,
  classifyParseError,
  extractTokenMetricArrays,
} from '../scripts/benchmark-utils';
import { NOOP_LOG, type TokenUsage } from '../src/util';
import { mockResponses } from './helpers/mock-responses';
import { createMockModel } from './helpers/mock-core';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';

/**
 * Edit structure returned by generateEdit
 */
interface Edit {
  range: { start: unknown; end: unknown };
  text: string;
  textDocument: unknown;
}

/**
 * Helper: Create a TextDocument for testing
 */
function createTestDocument(
  content: string,
  languageId = 'typescript',
): TextDocument {
  return TextDocument.create('file:///test/file.ts', languageId, 1, content);
}

/**
 * Helper: Verify standard edit structure
 */
function verifyEditStructure(edit: Edit) {
  expect(edit).toHaveProperty('range');
  expect(edit).toHaveProperty('range.start');
  expect(edit).toHaveProperty('range.end');
  expect(edit).toHaveProperty('text');
  expect(edit).toHaveProperty('textDocument');
  expect(typeof edit.text).toBe('string');
}

/**
 * Helper: Verify token usage and cost calculation
 */
function verifyTokenUsageAndCost(tokenUsage: TokenUsage) {
  expect(tokenUsage).toBeDefined();
  expect(tokenUsage).toHaveProperty('input');
  expect(tokenUsage).toHaveProperty('output');

  const modelCost = { input: 3, output: 15 };
  const cost = calculateCost(tokenUsage, modelCost);
  expect(cost).not.toBeNull();
  expect(typeof cost?.cost).toBe('number');
  expect(cost!.cost).toBeGreaterThanOrEqual(0);
}

describe('NextEdit Integration - Benchmark Compatibility', () => {
  /**
   * PROTECTS AGAINST: Changes to generateEdit() that break edit format,
   * token usage extraction, or benchmark cost calculations
   */
  it('should generate valid edits with token usage', async () => {
    // Test prefix-suffix approach
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: '// TODO: implement',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'implement simple return',
      },
    ]);
    const model1 = createMockModel({ response: prefixSuffixResponse });
    const doc = createTestDocument(`function test() {
  // TODO: implement
}`);

    const result1 = await generateEdit({
      model: model1,
      document: doc,
      prompt: 'prefix-suffix',
      log: NOOP_LOG,
    });

    expect(result1.edits).toBeArray();
    expect(result1.edits.length).toBeGreaterThan(0);
    verifyEditStructure(result1.edits[0]!);
    if (result1.tokenUsage) {
      verifyTokenUsageAndCost(result1.tokenUsage);
    }

    // Test line-number approach
    const lineNumberResponse = JSON.stringify([
      {
        startLine: 1,
        endLine: 1,
        text: 'return 42;',
        reason: 'implement function body',
      },
    ]);
    const model2 = createMockModel({ response: lineNumberResponse });

    const result2 = await generateEdit({
      model: model2,
      document: doc,
      prompt: 'line-number',
      log: NOOP_LOG,
    });

    expect(result2.edits).toBeArray();
    expect(result2.edits.length).toBeGreaterThan(0);
    expect(result2.edits[0]!.range).toBeDefined();
    expect(result2.edits[0]!.text).toBeDefined();
  });

  /**
   * PROTECTS AGAINST: Changes to edit structure that would break
   * createEditDiff() or error handling in benchmarks
   */
  it('should produce edits compatible with createEditDiff', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'const x = ',
        existing: '1',
        suffix: ';',
        text: '42',
        reason: 'update value',
      },
    ]);
    const model = createMockModel({ response: prefixSuffixResponse });
    const originalContent = 'const x = 1;';
    const doc = createTestDocument(originalContent);

    const result = await generateEdit({
      model,
      document: doc,
      prompt: 'prefix-suffix',
      log: NOOP_LOG,
    });

    // Verify createEditDiff doesn't throw with these edits
    expect(() => {
      createEditDiff(originalContent, result.edits);
    }).not.toThrow();

    const diff = createEditDiff(originalContent, result.edits);
    expect(typeof diff).toBe('string');

    // Test error handling with malformed responses
    const malformedModel = createMockModel({
      response: mockResponses.malformed(),
    });

    let error: unknown;
    try {
      await generateEdit({
        model: malformedModel,
        document: doc,
        prompt: 'prefix-suffix',
        log: NOOP_LOG,
      });
    } catch (e) {
      error = e;
    }

    // Verify error is classifiable
    if (error) {
      const errorType = classifyParseError(error);
      expect(errorType).toBeTruthy();
      expect(['json_parse', 'schema_invalid', 'extraction_failed']).toContain(
        errorType,
      );
    }
  });

  /**
   * PROTECTS AGAINST: Critical path breaking (generate → diff → cost)
   */
  it('should complete critical path: generate → diff → cost', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: '// TODO',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'implement function',
      },
    ]);
    const model = createMockModel({ response: prefixSuffixResponse });
    const originalContent = 'function test() {\n  // TODO\n}';
    const doc = createTestDocument(originalContent);

    // Step 1: Generate
    const result = await generateEdit({
      model,
      document: doc,
      prompt: 'prefix-suffix',
      log: NOOP_LOG,
    });
    expect(result.edits).toBeArray();

    // Step 2: Create diff
    const diff = createEditDiff(originalContent, result.edits);
    expect(typeof diff).toBe('string');

    // Step 3: Calculate cost
    if (result.tokenUsage) {
      const cost = calculateCost(result.tokenUsage, {
        input: 3,
        output: 15,
      });
      expect(cost).not.toBeNull();
      expect(typeof cost?.cost).toBe('number');
    }
  });
});

describe('InlineCompletion Integration - Benchmark Compatibility', () => {
  /**
   * PROTECTS AGAINST: Changes to generateCompletion() that break
   * completion format, token usage, or error handling
   */
  it('should generate valid completions with token usage', async () => {
    const inlineResponse = JSON.stringify([
      {
        text: 'User | undefined',
        reason: 'type definition',
      },
      {
        text: 'id: number;',
        reason: 'property definition',
      },
    ]);
    const model = createMockModel({ response: inlineResponse });
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
    expect(result.completions).toBeArray();
    if (result.completions) {
      expect(result.completions.length).toBeGreaterThan(0);
      const completion = result.completions[0]!;
      expect(typeof completion.text).toBe('string');
    }

    // Verify token usage is extractable and cost calculation works
    if (result.tokenUsage) {
      verifyTokenUsageAndCost(result.tokenUsage);
    }
  });

  /**
   * PROTECTS AGAINST: Changes that break error handling in inline benchmarks
   */
  it('should handle parse errors gracefully', async () => {
    const malformedResponse = 'this is not valid JSON {[}';
    const model = createMockModel({ response: malformedResponse });
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

    // Should return empty completions, not throw
    expect(result).toBeDefined();
  });
});

describe('Benchmark Utility Functions Integration', () => {
  /**
   * PROTECTS AGAINST: Changes to extractTokenMetricArrays and calculateCost
   * that break summary computation
   */
  it('should extract metrics and calculate costs from results', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: 'return;',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'fix return',
      },
    ]);
    const model = createMockModel({ response: prefixSuffixResponse });
    const doc = createTestDocument('function test() {}');

    const result = await generateEdit({
      model,
      document: doc,
      prompt: 'prefix-suffix',
      log: NOOP_LOG,
    });

    // Simulate multiple runs
    const runMetrics = [
      {
        parseSuccess: true,
        hintCount: 1,
        validHintCount: 1,
        parseErrorType: 'none' as const,
        genLatency: 100,
        score: 85.5,
        tokenMetrics: result.tokenUsage
          ? { ...result.tokenUsage, cost: 0.001, costWithoutCache: 0.001 }
          : undefined,
      },
    ];

    const metrics = extractTokenMetricArrays(runMetrics);
    expect(metrics).toBeDefined();
    if (result.tokenUsage) {
      expect(metrics.tokensInput).toBeArray();
      expect(metrics.tokensOutput).toBeArray();

      // Verify cost calculation with cache support
      const modelCost = { input: 3, output: 15, cache_read: 0.3 };
      const cost = calculateCost(result.tokenUsage, modelCost);

      expect(cost).not.toBeNull();
      expect(cost!.cost).toBeGreaterThanOrEqual(0);
      expect(cost!.costWithoutCache).toBeGreaterThanOrEqual(cost!.cost);
    }
  });
});

describe('Benchmark Script Smoke Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    const randomId = Math.random().toString(36).substring(7);
    tempDir = `/tmp/benchmark-smoke-${Date.now()}-${randomId}`;
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch {
      // May already exist
    }
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * PROTECTS AGAINST: Breaking changes that cause benchmark.ts to crash
   * Tests the full script execution path with mock provider
   */
  it('should run benchmark.ts script without crashing', async () => {
    const smallTestPath = path.join(
      import.meta.dir,
      'fixtures/small/simple-refactor.ts',
    );
    if (!fs.existsSync(smallTestPath)) {
      console.log('Skipping: simple-refactor.ts fixture not found');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('bun', [
        'run',
        'scripts/benchmark.ts',
        '--file',
        smallTestPath,
        '--models',
        'mock/test-model',
        '--runs',
        '1',
      ]);

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', code => {
        if (code === 0) {
          // Verify some expected output
          expect(stdout).toContain('prefix-suffix');
          resolve();
        } else {
          reject(
            new Error(
              `benchmark.ts exited with code ${code}\nstderr: ${stderr}`,
            ),
          );
        }
      });

      proc.on('error', err => {
        reject(err);
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        proc.kill();
        reject(new Error('benchmark.ts timed out'));
      }, 30000);
    });
  });

  /**
   * PROTECTS AGAINST: Breaking changes that cause inline-benchmark.ts to crash
   */
  it('should run inline-benchmark.ts script without crashing', async () => {
    const testCasesPath = path.join(
      import.meta.dir,
      'fixtures/benchmark/benchmark-test-cases.json',
    );
    if (!fs.existsSync(testCasesPath)) {
      console.log('Skipping: benchmark-test-cases.json fixture not found');
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('bun', [
        'run',
        'scripts/inline-benchmark.ts',
        '--test-cases',
        testCasesPath,
        '--models',
        'mock/test-model',
        '--runs',
        '1',
      ]);

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', code => {
        if (code === 0) {
          // Verify script produced expected output
          expect(stdout).toContain('COMPARISON TABLE');
          resolve();
        } else {
          reject(
            new Error(
              `inline-benchmark.ts exited with code ${code}\nstderr: ${stderr}`,
            ),
          );
        }
      });

      proc.on('error', err => {
        reject(err);
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        proc.kill();
        reject(new Error('inline-benchmark.ts timed out'));
      }, 30000);
    });
  });
});
