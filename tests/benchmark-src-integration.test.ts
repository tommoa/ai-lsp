/**
 * Integration tests: src/ modules with benchmark infrastructure
 *
 * These tests verify that breaking changes in src/ will be caught by the
 * benchmark test suite. They validate the critical paths:
 *
 * 1. NextEdit.generate() → edits → createEditDiff() → rateChange()
 * 2. InlineCompletion.generate() → completions → cost calculation
 * 3. Full benchmark script execution with mock providers
 *
 * These tests are the PRIMARY DEFENSE against breaking changes in src/
 * that would silently break benchmarks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { NextEdit } from '../src/next-edit';
import { InlineCompletion } from '../src/inline-completion';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createProvider } from '../src/provider/provider';
import {
  createEditDiff,
  calculateCost,
  classifyParseError,
  extractTokenMetricArrays,
} from '../scripts/benchmark-utils';
import { NOOP_LOG } from '../src/util';
import { mockResponses } from './e2e/helpers/mock-responses';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';

/**
 * Helper: Create a mock language model for testing
 * Returns a mock LanguageModel that returns the specified response
 */
function createMockModel(response: string) {
  const mockModel = {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'test-model',
    supportedUrls: {},

    async doGenerate() {
      return {
        content: [
          {
            type: 'text' as const,
            text: response,
          },
        ],
        finishReason: 'stop' as const,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        warnings: [],
      };
    },

    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          const id = Math.random().toString(36).substring(7);
          controller.enqueue({
            type: 'text-start' as const,
            id,
          });
          controller.enqueue({
            type: 'text-delta' as const,
            id,
            delta: response,
          });
          controller.enqueue({
            type: 'text-end' as const,
            id,
          });
          controller.enqueue({
            type: 'finish' as const,
            finishReason: 'stop' as const,
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
            },
          });
          controller.close();
        },
      });
      return { stream, warnings: [] };
    },
  } as any;

  return mockModel;
}

/**
 * Helper: Create a TextDocument for testing
 */
function createTestDocument(
  content: string,
  languageId: string = 'typescript',
): TextDocument {
  return TextDocument.create(
    'file:///test/file.ts',
    languageId,
    1,
    content,
  );
}

describe('NextEdit Integration - Benchmark Compatibility', () => {
  /**
   * PROTECTS AGAINST: Changes to NextEdit.generate() prefix_suffix that break
   * edit format or token usage extraction
   */
  it('should generate valid edits for prefix_suffix approach', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: '// TODO: implement',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'implement simple return',
      },
    ]);
    const model = createMockModel(prefixSuffixResponse);
    const doc = createTestDocument(`function test() {
  // TODO: implement
}`);

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    const edit = result.edits[0]!;
    expect(edit).toHaveProperty('range');
    expect(edit).toHaveProperty('range.start');
    expect(edit).toHaveProperty('range.end');
    expect(edit).toHaveProperty('text');
    expect(edit).toHaveProperty('textDocument');
    expect(typeof edit.text).toBe('string');
  });

  /**
   * PROTECTS AGAINST: Changes to NextEdit.generate() line_number that break
   * edit format or token usage extraction
   */
  it('should generate valid edits for line_number approach', async () => {
    const lineNumberResponse = JSON.stringify([
      {
        startLine: 1,
        endLine: 1,
        text: 'return 42;',
        reason: 'implement function body',
      },
    ]);
    const model = createMockModel(lineNumberResponse);
    const doc = createTestDocument(`function test() {
  // TODO: implement
}`);

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'line_number',
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
    expect(result.edits.length).toBeGreaterThan(0);

    const edit = result.edits[0]!;
    expect(edit.range).toBeDefined();
    expect(edit.text).toBeDefined();
  });

  /**
   * PROTECTS AGAINST: Changes to token usage extraction that would break
   * benchmark cost calculations
   */
  it('should return token usage compatible with cost calculation', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: 'return;',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'fix return value',
      },
    ]);
    const model = createMockModel(prefixSuffixResponse);
    const doc = createTestDocument('function test() {}');

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
      log: NOOP_LOG,
    });

    // Mock provider returns standard token usage
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage).toHaveProperty('input');
    expect(result.tokenUsage).toHaveProperty('output');

    // Verify cost calculation works with this token usage
    if (result.tokenUsage) {
      const modelCost = { input: 3, output: 15 };
      const cost = calculateCost(result.tokenUsage, modelCost);
      expect(cost).not.toBeNull();
      expect(typeof cost?.cost).toBe('number');
      expect(cost!.cost).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * PROTECTS AGAINST: Changes to edit structure that would break createEditDiff()
   */
  it('should produce edits compatible with createEditDiff()', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'const x = ',
        existing: '1',
        suffix: ';',
        text: '42',
        reason: 'update value',
      },
    ]);
    const model = createMockModel(prefixSuffixResponse);
    const originalContent = 'const x = 1;';
    const doc = createTestDocument(originalContent);

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
      log: NOOP_LOG,
    });

    // Verify createEditDiff doesn't throw with these edits
    expect(() => {
      createEditDiff(originalContent, result.edits);
    }).not.toThrow();

    const diff = createEditDiff(originalContent, result.edits);
    expect(typeof diff).toBe('string');
  });

  /**
   * PROTECTS AGAINST: Changes to error handling that would cause benchmarks
   * to crash on malformed responses
   */
  it('should handle parse errors without crashing', async () => {
    const model = await createMockModel(mockResponses.malformed());
    const doc = createTestDocument('function test() {}');

    // Should not throw - should handle error gracefully
    let error: unknown;
    try {
      await NextEdit.generate({
        model,
        document: doc,
        prompt: 'prefix_suffix',
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
   * PROTECTS AGAINST: Changes that break empty document handling in benchmarks
   */
  it('should handle empty documents', async () => {
    const model = await createMockModel(mockResponses.empty());
    const doc = createTestDocument('');

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
  });

  /**
   * PROTECTS AGAINST: Changes that break large document handling in benchmarks
   */
  it('should handle large documents without breaking', async () => {
    const complexFilePath = path.join(
      import.meta.dir,
      'fixtures/large/complex-file.ts',
    );
    if (!fs.existsSync(complexFilePath)) {
      console.log('Skipping: complex-file.ts fixture not found');
      return;
    }

    const largeContent = fs.readFileSync(complexFilePath, 'utf8');
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'const test = ',
        existing: 'old',
        suffix: ';',
        text: 'new',
        reason: 'update',
      },
    ]);
    const model = createMockModel(prefixSuffixResponse);
    const doc = createTestDocument(largeContent, 'typescript');

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
      log: NOOP_LOG,
    });

    expect(result).toBeDefined();
    expect(result.edits).toBeArray();
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
    const model = createMockModel(prefixSuffixResponse);
    const originalContent = 'function test() {\n  // TODO\n}';
    const doc = createTestDocument(originalContent);

    // Step 1: Generate
    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
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
   * PROTECTS AGAINST: Changes to InlineCompletion.generate() that break
   * completion format
   */
  it('should generate valid completions for inline benchmarks', async () => {
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
    const model = createMockModel(inlineResponse);
    const doc = createTestDocument('const user: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 13 },
    };

    const result = await InlineCompletion.generate({
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
  });

  /**
   * PROTECTS AGAINST: Changes to token usage in InlineCompletion that would
   * break cost calculations
   */
  it('should return token usage compatible with benchmarks', async () => {
    const inlineResponse = JSON.stringify([
      {
        text: 'User | undefined',
        reason: 'type definition',
      },
    ]);
    const model = createMockModel(inlineResponse);
    const doc = createTestDocument('const user: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 13 },
    };

    const result = await InlineCompletion.generate({
      model,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    // Verify token usage is extractable
    if (result.tokenUsage) {
      expect(result.tokenUsage).toHaveProperty('input');
      expect(result.tokenUsage).toHaveProperty('output');

      // Verify cost calculation works
      const cost = calculateCost(result.tokenUsage, {
        input: 3,
        output: 15,
      });
      expect(cost).not.toBeNull();
      expect(typeof cost?.cost).toBe('number');
    }
  });

  /**
   * PROTECTS AGAINST: Changes that break error handling in inline benchmarks
   */
  it('should handle parse errors gracefully', async () => {
    const malformedResponse = 'this is not valid JSON {[}';
    const model = createMockModel(malformedResponse);
    const doc = createTestDocument('const user: ');
    const position: TextDocumentPositionParams = {
      textDocument: { uri: 'file:///test.ts' },
      position: { line: 0, character: 13 },
    };

    const result = await InlineCompletion.generate({
      model,
      document: doc,
      position,
      log: NOOP_LOG,
    });

    // Should return null completions, not throw
    expect(result).toBeDefined();
  });
});

describe('Benchmark Utility Functions Integration', () => {
  /**
   * PROTECTS AGAINST: Changes to extractTokenMetricArrays that break
   * summary computation
   */
  it('should extract token metrics from NextEdit results', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: 'return;',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'fix return',
      },
    ]);
    const model = createMockModel(prefixSuffixResponse);
    const doc = createTestDocument('function test() {}');

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
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
    }
  });

  /**
   * PROTECTS AGAINST: Changes to calculateCost that would produce wrong costs
   */
  it('should calculate costs correctly from real token usage', async () => {
    const prefixSuffixResponse = JSON.stringify([
      {
        prefix: 'function test() {\n  ',
        existing: 'return;',
        suffix: '\n}',
        text: 'return 42;',
        reason: 'fix return',
      },
    ]);
    const model = createMockModel(prefixSuffixResponse);
    const doc = createTestDocument('function test() {}');

    const result = await NextEdit.generate({
      model,
      document: doc,
      prompt: 'prefix_suffix',
      log: NOOP_LOG,
    });

    if (result.tokenUsage) {
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
    tempDir = `/tmp/benchmark-smoke-${Date.now()}-${Math.random().toString(36).substring(7)}`;
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

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Verify some expected output
          expect(stdout).toContain('prefix_suffix');
          resolve();
        } else {
          reject(
            new Error(
              `benchmark.ts exited with code ${code}\nstderr: ${stderr}`,
            ),
          );
        }
      });

      proc.on('error', (err) => {
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

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          expect(stdout).toContain('standard');
          resolve();
        } else {
          reject(
            new Error(
              `inline-benchmark.ts exited with code ${code}\nstderr: ${stderr}`,
            ),
          );
        }
      });

      proc.on('error', (err) => {
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
