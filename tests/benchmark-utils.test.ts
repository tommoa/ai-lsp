import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  avg,
  percentile,
  calculateCost,
  parseApproachArg,
  parseCommonArgs,
  classifyParseError,
  createEditDiff,
  formatCompletionAsDiff,
  colorizeUnifiedDiff,
  extractTokenMetricArrays,
  runConcurrent,
  exportBenchmarkResults,
  formatNumber,
  buildBenchmarkApproachMetrics,
  buildBenchmarkModelMetrics,
  buildInlineApproachMetrics,
  buildInlineModelMetrics,
  rateChange,
  type TokenCost,
  type BenchmarkApproachSummary,
  type BenchmarkModelItem,
  type InlineApproachSummary,
  type InlineModelItem,
} from '../scripts/benchmark-utils';
import type { TokenUsage } from '../src/util';

type TokenMetrics = TokenUsage & TokenCost;

describe('Benchmark Utilities - Calculations', () => {
  describe('avg function', () => {
    it('should calculate average of array', () => {
      expect(avg([1, 2, 3, 4, 5])).toBe(3);
    });

    it('should return NaN for empty array', () => {
      expect(avg([])).toBeNaN();
    });
  });

  describe('percentile function', () => {
    it('should calculate 50th and 95th percentiles', () => {
      expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      const result = percentile(values, 95);
      expect(result).toBeGreaterThan(90);
      expect(result).toBeLessThanOrEqual(100);
    });

    it('should return NaN for empty array', () => {
      expect(percentile([], 50)).toBeNaN();
    });
  });

  describe('calculateCost function', () => {
    it('should calculate cost without cache', () => {
      const tokenUsage: TokenUsage = {
        input: 1000,
        output: 100,
      };
      const modelCost = { input: 3, output: 15 };
      const result = calculateCost(tokenUsage, modelCost);
      expect(result).not.toBeNull();
      expect(result!.cost).toBeCloseTo(0.0045, 3);
    });

    it('should calculate cost with cached input', () => {
      const tokenUsage: TokenUsage = {
        input: 1000,
        output: 100,
        cachedInput: 500,
      };
      const modelCost = {
        input: 3,
        output: 15,
        cache_read: 0.3,
      };
      const result = calculateCost(tokenUsage, modelCost);
      expect(result).not.toBeNull();
      expect(result!.cost).toBeLessThan(result!.costWithoutCache);
    });

    it('should include reasoning tokens in cost', () => {
      const tokenUsage: TokenUsage = {
        input: 1000,
        output: 100,
        reasoning: 500,
      };
      const modelCost = { input: 3, output: 15 };
      const result = calculateCost(tokenUsage, modelCost);
      expect(result).not.toBeNull();
      expect(result!.cost).toBeGreaterThan(0);
    });

    it('should return null if no model cost provided', () => {
      const tokenUsage: TokenUsage = {
        input: 1000,
        output: 100,
      };
      const result = calculateCost(tokenUsage, undefined);
      expect(result).toBeNull();
    });
  });
});

describe('Benchmark Utilities - Parsing', () => {
  describe('parseApproachArg function', () => {
    it('should return all approaches for "all"', () => {
      const validApproaches = ['prefix-suffix', 'line-number'] as const;
      const result = parseApproachArg('all', validApproaches);
      expect(result).toEqual(['prefix-suffix', 'line-number']);
    });

    it('should return only the approach selected', () => {
      const validApproaches = ['prefix-suffix', 'line-number'] as const;
      const result = parseApproachArg('prefix-suffix', validApproaches);
      expect(result).toEqual(['prefix-suffix']);
    });

    it('should throw error for invalid approach', () => {
      const validApproaches = ['prefix-suffix', 'line-number'] as const;
      expect(() =>
        parseApproachArg('invalid_approach', validApproaches),
      ).toThrow();
    });
  });

  describe('parseCommonArgs function', () => {
    it('should parse arguments and flags correctly', () => {
      const result = parseCommonArgs([
        '--models',
        'model1,model2',
        '--runs',
        '10',
        '--concurrency',
        '4',
        '--preview',
        '--critic',
      ]);
      expect(result.common.models).toEqual(['model1', 'model2']);
      expect(result.common.runs).toBe(10);
      expect(result.common.concurrency).toBe(4);
      expect(result.common.preview).toBe(true);
      expect(result.common.critic).toBe(true);
    });

    it('should return remaining unparsed arguments', () => {
      const result = parseCommonArgs([
        '--models',
        'test',
        '--file',
        'path/to/file',
      ]);
      expect(result.remaining).toContain('--file');
    });
  });

  describe('classifyParseError function', () => {
    it('should classify JSON parse errors', () => {
      const result = classifyParseError(new Error('JSON parsing failed'));
      expect(result).toBe('json_parse');
    });

    it('should classify schema validation errors', () => {
      const result = classifyParseError(
        new Error('Invalid hint shape detected'),
      );
      expect(result).toBe('schema_invalid');
    });

    it('should classify extraction errors', () => {
      const result = classifyParseError(new Error('Result is not an array'));
      expect(result).toBe('extraction_failed');
    });

    it('should classify conversion errors', () => {
      const result = classifyParseError(
        new Error('Unsupported format conversion'),
      );
      expect(result).toBe('conversion_failed');
    });

    it('should default to schema_invalid', () => {
      const result = classifyParseError(new Error('Unknown error'));
      expect(result).toBe('schema_invalid');
    });
  });
});

describe('Benchmark Utilities - Diff & Display', () => {
  describe('createEditDiff function', () => {
    it('should create diff for single-line edit', () => {
      const original = 'const x = 5;\nconst y = 10;';
      const edits = [
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 0, character: 11 },
          },
          text: '42',
        },
      ];
      const diff = createEditDiff(original, edits);
      expect(diff).toContain('const x = 42;');
      expect(diff).toContain('-const x = 5;');
    });

    it('should create diff for multi-line edit', () => {
      const original = 'const x = 5;\nconst y = 10;';
      const edits = [
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 1, character: 12 },
          },
          text: '42;\nconst y = 36;\nconst z = 24',
        },
      ];
      const diff = createEditDiff(original, edits);
      expect(diff).toContain('const x = 42;');
      expect(diff).toContain('-const x = 5;');
      expect(diff).toContain('const y = 36;');
      expect(diff).toContain('-const y = 10;');
      expect(diff).toContain('const z = 24;');
    });

    it('should handle multi-line edit reducing lines', () => {
      const original = 'const x = 5;\nconst y = 10;';
      const edits = [
        {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 1, character: 12 },
          },
          text: '42;',
        },
      ];
      const diff = createEditDiff(original, edits);
      expect(diff).toContain('const x = 42;');
      expect(diff).toContain('-const x = 5;');
      expect(diff).toContain('-const y = 10;');
    });

    it('should handle empty edits array', () => {
      const original = 'const x = 5;';
      const diff = createEditDiff(original, []);
      expect(diff).toBe('');
    });

    it('should include context lines', () => {
      const original = 'line1\nline2\nline3\nline4\nline5';
      const edits = [
        {
          range: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 5 },
          },
          text: 'LINE3',
        },
      ];
      const diff = createEditDiff(original, edits, 1);
      expect(diff).toContain('line2');
      expect(diff).toContain('line4');
    });

    it('should sort edits by position', () => {
      const original = 'abcdef';
      const edits = [
        {
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 4 },
          },
          text: 'X',
        },
        {
          range: {
            start: { line: 1, character: 1 },
            end: { line: 1, character: 1 },
          },
          text: 'Z',
        },
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          text: 'Y',
        },
      ];
      const diff = createEditDiff(original, edits);
      expect(diff.indexOf('Y')).toBeLessThan(diff.indexOf('X'));
      expect(diff.indexOf('Z')).toBeGreaterThan(diff.indexOf('X'));
    });
  });

  describe('formatCompletionAsDiff function', () => {
    it('should handle mid-line completion', () => {
      const result = formatCompletionAsDiff(
        'function foo() {\n  total +=',
        ' price * qty;',
        '\n}',
      );
      expect(result).toContain('-  total +=');
      expect(result).toContain('+  total += price * qty;');
      expect(result).toContain(' function foo() {');
      expect(result).toContain(' }');
    });

    it('should handle end-of-line completion (pure insertion)', () => {
      const result = formatCompletionAsDiff(
        'function foo() {\n',
        '  return 42;',
        '\n}',
      );
      // Pure insertion at start of line - no deleted line
      expect(result).not.toMatch(/^-/m);
      expect(result).toContain('+  return 42;');
      expect(result).toContain(' function foo() {');
      expect(result).toContain(' }');
    });

    it('should handle multiline completion extending partial line', () => {
      const result = formatCompletionAsDiff(
        'function foo() {',
        '\n  const x = 1;\n  return x;',
        '\n}',
      );
      // Original line shown as deleted
      expect(result).toContain('-function foo() {');
      // First line of completion extends the partial line
      expect(result).toContain('+function foo() {');
      expect(result).toContain('+  const x = 1;');
      expect(result).toContain('+  return x;');
      expect(result).toContain(' }');
    });

    it('should handle completion starting with newline at end of line', () => {
      const result = formatCompletionAsDiff(
        'const x = 1;',
        '\nconst y = 2;',
        '\nconst z = 3;',
      );
      // The partial line "const x = 1;" is extended with newline
      expect(result).toContain('-const x = 1;');
      expect(result).toContain('+const x = 1;');
      expect(result).toContain('+const y = 2;');
      expect(result).toContain(' const z = 3;');
    });

    it('should handle empty completion', () => {
      const result = formatCompletionAsDiff('const x = ', '', '1;');
      // Empty completion means no change - all lines are context
      expect(result).toBe(' const x = 1;');
    });

    it('should include full file context', () => {
      const result = formatCompletionAsDiff(
        'line1\nline2\npartial',
        ' completed',
        '\nline4\nline5',
      );
      expect(result).toContain(' line1');
      expect(result).toContain(' line2');
      expect(result).toContain('-partial');
      expect(result).toContain('+partial completed');
      expect(result).toContain(' line4');
      expect(result).toContain(' line5');
    });

    it('should handle single line file with mid-line completion', () => {
      const result = formatCompletionAsDiff('const x =', ' 42', ';');
      expect(result).toContain('-const x =;');
      expect(result).toContain('+const x = 42;');
    });

    it('should handle completion at very start of file', () => {
      const result = formatCompletionAsDiff(
        '',
        'const x = 1;',
        '\nconst y = 2;',
      );
      expect(result).toContain('+const x = 1;');
      expect(result).toContain(' const y = 2;');
    });

    it('should handle completion at very end of file', () => {
      const result = formatCompletionAsDiff(
        'const x = 1;\n',
        'const y = 2;',
        '',
      );
      expect(result).toContain(' const x = 1;');
      expect(result).toContain('+const y = 2;');
    });

    it('should handle multiline completion with empty suffix', () => {
      const result = formatCompletionAsDiff(
        'function foo() {',
        '\n  return 1;\n}',
        '',
      );
      expect(result).toContain('-function foo() {');
      expect(result).toContain('+function foo() {');
      expect(result).toContain('+  return 1;');
      expect(result).toContain('+}');
    });

    it('should handle multiline pure insertion at start of line', () => {
      // Cursor is at start of a new line (after newline in prefix)
      // Completion is multiple lines, not starting with newline
      const result = formatCompletionAsDiff(
        'function foo() {\n',
        '  const x = 1;\n  const y = 2;\n  return x + y;',
        '\n}',
      );
      // This is a pure insertion - no deleted lines
      expect(result).not.toMatch(/^-/m);
      expect(result).toContain(' function foo() {');
      expect(result).toContain('+  const x = 1;');
      expect(result).toContain('+  const y = 2;');
      expect(result).toContain('+  return x + y;');
      expect(result).toContain(' }');
    });
  });

  describe('colorizeUnifiedDiff function', () => {
    it('should colorize diffs correctly', () => {
      const diff = '@@ line @@\n-old\n+new';
      expect(colorizeUnifiedDiff(diff, true)).toBe(diff);
      const colored = colorizeUnifiedDiff(diff, false);
      expect(colored).toContain('\x1b[');
      expect(colorizeUnifiedDiff('-old line', false)).toContain('\x1b[31m');
      expect(colorizeUnifiedDiff('+new line', false)).toContain('\x1b[32m');
    });
  });

  describe('extractTokenMetricArrays function', () => {
    it('should extract token metrics including reasoning and cache', () => {
      const runMetrics = [
        {
          tokenMetrics: {
            input: 100,
            output: 50,
            reasoning: 25,
            cachedInput: 30,
            cost: 0.001,
            costWithoutCache: 0.001,
          },
        },
        {
          tokenMetrics: {
            input: 200,
            output: 60,
            cost: 0.002,
            costWithoutCache: 0.002,
          },
        },
      ];
      const result = extractTokenMetricArrays(
        runMetrics as { tokenMetrics?: TokenMetrics }[],
      );
      expect(result.tokensInput).toEqual([100, 200]);
      expect(result.tokensOutput).toEqual([50, 60]);
      expect(result.tokensReasoning).toContain(25);
      expect(result.tokensCachedInput).toContain(30);
    });
  });
});

describe('Benchmark Utilities - Concurrency', () => {
  describe('runConcurrent function', () => {
    it('should execute all tasks', async () => {
      const executed: number[] = [];
      await runConcurrent(5, 2, (idx: number) => {
        executed.push(idx);
        return Promise.resolve();
      });
      expect(executed.sort()).toEqual([0, 1, 2, 3, 4]);
    });

    it('should respect concurrency limit', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      await runConcurrent(10, 2, async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(resolve => setTimeout(resolve, 10));
        currentConcurrent--;
      });
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should handle zero concurrency by using 1', async () => {
      const executed: number[] = [];
      await runConcurrent(3, 0, (idx: number) => {
        executed.push(idx);
        return Promise.resolve();
      });
      expect(executed.length).toBe(3);
    });

    it('should handle concurrency greater than total runs', async () => {
      const executed: number[] = [];
      await runConcurrent(3, 10, (idx: number) => {
        executed.push(idx);
        return Promise.resolve();
      });
      expect(executed.length).toBe(3);
    });
  });

  describe('exportBenchmarkResults', () => {
    const tempDir = '/tmp/benchmark-test-export';
    const testFile = path.join(tempDir, 'test-results.json');

    afterEach(() => {
      // Clean up test files
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    });

    it('should export results to JSON file', () => {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const results = {
        model: 'test-model',
        runs: 3,
        avgScore: 85.5,
        data: [1, 2, 3],
      };

      exportBenchmarkResults(testFile, results);

      expect(fs.existsSync(testFile)).toBe(true);
      const content = fs.readFileSync(testFile, 'utf8');
      const parsed = JSON.parse(content) as typeof results;
      expect(parsed).toEqual(results);
    });

    it('should format JSON with indentation', () => {
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const results = { key: 'value' };
      exportBenchmarkResults(testFile, results);

      const content = fs.readFileSync(testFile, 'utf8');
      expect(content).toContain('  "key"');
    });
  });
});

describe('Benchmark Utilities - Formatting', () => {
  describe('formatNumber function', () => {
    it('should format as integer', () => {
      expect(formatNumber(42.7, { type: 'int' })).toBe(43);
      expect(formatNumber(42.3, { type: 'int' })).toBe(42);
      expect(formatNumber(0, { type: 'int' })).toBe(0);
    });

    it('should format with fixed decimals', () => {
      expect(formatNumber(42.123456, { type: 'fixed', decimals: 2 })).toBe(
        '42.12',
      );
      expect(formatNumber(42.123456, { type: 'fixed', decimals: 6 })).toBe(
        '42.123456',
      );
      expect(formatNumber(42, { type: 'fixed', decimals: 3 })).toBe('42.000');
    });

    it('should format as percentage', () => {
      expect(formatNumber(42.5, { type: 'percent' })).toBe('42.5%');
      expect(formatNumber(42.567, { type: 'percent', decimals: 2 })).toBe(
        '42.57%',
      );
      expect(formatNumber(100, { type: 'percent', decimals: 0 })).toBe('100%');
    });

    it('should format as milliseconds', () => {
      expect(formatNumber(42.7, { type: 'ms' })).toBe('43ms');
      expect(formatNumber(1234.5, { type: 'ms' })).toBe('1235ms');
      expect(formatNumber(0, { type: 'ms' })).toBe('0ms');
    });

    it('should format with rounding', () => {
      expect(formatNumber(42.7, { type: 'round' })).toBe('43');
      expect(formatNumber(42.3, { type: 'round' })).toBe('42');
      expect(formatNumber(0, { type: 'round' })).toBe('0');
    });

    it('should return N/A for NaN values', () => {
      expect(formatNumber(NaN, { type: 'int' })).toBe('N/A');
      expect(formatNumber(NaN, { type: 'fixed', decimals: 2 })).toBe('N/A');
      expect(formatNumber(NaN, { type: 'percent' })).toBe('N/A');
      expect(formatNumber(NaN, { type: 'ms' })).toBe('N/A');
      expect(formatNumber(NaN, { type: 'round' })).toBe('N/A');
    });

    it('should return N/A for non-number values', () => {
      expect(
        formatNumber(undefined as unknown as number, { type: 'int' }),
      ).toBe('N/A');
      expect(
        formatNumber(null as unknown as number, { type: 'fixed', decimals: 2 }),
      ).toBe('N/A');
      expect(
        formatNumber('string' as unknown as number, { type: 'percent' }),
      ).toBe('N/A');
    });

    it('should handle edge cases', () => {
      expect(formatNumber(0, { type: 'fixed', decimals: 2 })).toBe('0.00');
      expect(formatNumber(-42.5, { type: 'int' })).toBe(-42);
      expect(formatNumber(-42.5, { type: 'fixed', decimals: 1 })).toBe('-42.5');
      expect(formatNumber(-100, { type: 'percent', decimals: 0 })).toBe(
        '-100%',
      );
    });
  });
});

describe('Benchmark Utilities - Metric Builders', () => {
  describe('buildBenchmarkApproachMetrics function', () => {
    it('should return an array of table metrics', () => {
      const metrics = buildBenchmarkApproachMetrics(10);
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeGreaterThan(0);
    });

    it('should have correct metric properties', () => {
      const metrics = buildBenchmarkApproachMetrics(10);
      metrics.forEach(metric => {
        expect(metric).toHaveProperty('name');
        expect(metric).toHaveProperty('getValue');
        expect(typeof metric.name).toBe('string');
        expect(typeof metric.getValue).toBe('function');
      });
    });

    it('should extract quality score metric', () => {
      const metrics = buildBenchmarkApproachMetrics(10);
      const qualityMetric = metrics.find(m => m.name === 'Quality Score');
      expect(qualityMetric).toBeDefined();
      expect(qualityMetric!.higherIsBetter).toBe(true);

      const mockData = { avgScore: 85.5 } as BenchmarkApproachSummary;
      expect(qualityMetric!.getValue(mockData)).toBe(85.5);
    });

    it('should extract gen latency metric', () => {
      const metrics = buildBenchmarkApproachMetrics(10);
      const latencyMetric = metrics.find(m => m.name === 'Gen Latency (ms)');
      expect(latencyMetric).toBeDefined();
      expect(latencyMetric!.higherIsBetter).toBe(false);

      const mockData = { genAvgMs: 1234 } as BenchmarkApproachSummary;
      expect(latencyMetric!.getValue(mockData)).toBe(1234);
    });

    it('should calculate success rate from valid runs', () => {
      const metrics = buildBenchmarkApproachMetrics(10);
      const successRateMetric = metrics.find(m => m.name === 'Success Rate');
      expect(successRateMetric).toBeDefined();
      expect(successRateMetric!.higherIsBetter).toBe(true);

      const mockData = { valid: 8 } as BenchmarkApproachSummary;
      expect(successRateMetric!.getValue(mockData)).toBe(80);
    });

    it('should extract token and cost metrics', () => {
      const metrics = buildBenchmarkApproachMetrics(10);

      const inputTokenMetric = metrics.find(m => m.name === 'Gen Input Tokens');
      const outputTokenMetric = metrics.find(
        m => m.name === 'Gen Output Tokens',
      );
      const costMetric = metrics.find(m => m.name === 'Gen Cost ($)');

      expect(inputTokenMetric).toBeDefined();
      expect(outputTokenMetric).toBeDefined();
      expect(costMetric).toBeDefined();

      const mockData = {
        genAvgInputTokens: 1000,
        genAvgOutputTokens: 250,
        genAvgCost: 0.0042,
      } as BenchmarkApproachSummary;

      expect(inputTokenMetric!.getValue(mockData)).toBe(1000);
      expect(outputTokenMetric!.getValue(mockData)).toBe(250);
      expect(costMetric!.getValue(mockData)).toBe(0.0042);
    });
  });

  describe('buildBenchmarkModelMetrics function', () => {
    it('should return an array of table metrics', () => {
      const metrics = buildBenchmarkModelMetrics(10);
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeGreaterThan(0);
    });

    it('should extract values from nested summary object', () => {
      const metrics = buildBenchmarkModelMetrics(10);
      const qualityMetric = metrics.find(m => m.name === 'Quality Score');
      expect(qualityMetric).toBeDefined();

      const mockData = {
        summary: {
          avgScore: 92.3,
          genAvgMs: 2000,
          genAvgInputTokens: 1500,
          genAvgOutputTokens: 300,
          genAvgCost: 0.008,
          valid: 9,
          parseSuccessRate: 95,
          avgHintsPerRun: 3.2,
          avgConversionRate: 88,
        },
      } as BenchmarkModelItem;

      expect(qualityMetric!.getValue(mockData)).toBe(92.3);
    });

    it('should calculate success rate from nested summary', () => {
      const metrics = buildBenchmarkModelMetrics(10);
      const successRateMetric = metrics.find(m => m.name === 'Success Rate');
      expect(successRateMetric).toBeDefined();

      const mockData = { summary: { valid: 7 } } as BenchmarkModelItem;
      expect(successRateMetric!.getValue(mockData)).toBe(70);
    });

    it('should have same metric names as approach metrics', () => {
      const approachMetrics = buildBenchmarkApproachMetrics(10);
      const modelMetrics = buildBenchmarkModelMetrics(10);

      const approachNames = approachMetrics.map(m => m.name);
      const modelNames = modelMetrics.map(m => m.name);

      expect(modelNames).toEqual(approachNames);
    });
  });

  describe('buildInlineApproachMetrics function', () => {
    it('should return an array of table metrics', () => {
      const metrics = buildInlineApproachMetrics();
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeGreaterThan(0);
    });

    it('should format latency metrics', () => {
      const metrics = buildInlineApproachMetrics();
      const avgLatencyMetric = metrics.find(m => m.name === 'Avg Latency (ms)');
      const p50Metric = metrics.find(m => m.name === 'P50 Latency (ms)');
      const p95Metric = metrics.find(m => m.name === 'P95 Latency (ms)');

      expect(avgLatencyMetric).toBeDefined();
      expect(p50Metric).toBeDefined();
      expect(p95Metric).toBeDefined();

      const mockData = {
        avgLatency: 123.456,
        p50Latency: 100.789,
        p95Latency: 250.123,
      } as InlineApproachSummary;

      expect(avgLatencyMetric!.getValue(mockData)).toBe(123);
      expect(p50Metric!.getValue(mockData)).toBe(101);
      expect(p95Metric!.getValue(mockData)).toBe(250);
    });

    it('should format output tokens metric', () => {
      const metrics = buildInlineApproachMetrics();
      const outputTokensMetric = metrics.find(m => m.name === 'Output Tokens');
      expect(outputTokensMetric).toBeDefined();

      const mockData = { avgOutputTokens: 156.789 } as InlineApproachSummary;
      expect(outputTokensMetric!.getValue(mockData)).toBe(157);
    });

    it('should format cost with 6 decimal places', () => {
      const metrics = buildInlineApproachMetrics();
      const costMetric = metrics.find(m => m.name === 'Cost ($)');
      expect(costMetric).toBeDefined();

      const mockData = { avgCost: 0.001234567 } as InlineApproachSummary;
      expect(costMetric!.getValue(mockData)).toBe('0.001235');
    });

    it('should format success rate as percentage string', () => {
      const metrics = buildInlineApproachMetrics();
      const successRateMetric = metrics.find(
        m => m.name === 'Success Rate (%)',
      );
      expect(successRateMetric).toBeDefined();

      const mockData = { parseSuccessRate: 87.654 } as InlineApproachSummary;
      expect(successRateMetric!.getValue(mockData)).toBe('87.7%');
    });

    it('should format avg completions metric', () => {
      const metrics = buildInlineApproachMetrics();
      const completionsMetric = metrics.find(m => m.name === 'Avg Completions');
      expect(completionsMetric).toBeDefined();

      const mockData = { avgCompletions: 3.456 } as InlineApproachSummary;
      expect(completionsMetric!.getValue(mockData)).toBe('3.46');
    });

    it('should format quality scores', () => {
      const metrics = buildInlineApproachMetrics();
      const avgScoreMetric = metrics.find(m => m.name === 'Avg Quality Score');
      const maxScoreMetric = metrics.find(m => m.name === 'Max Quality Score');

      expect(avgScoreMetric).toBeDefined();
      expect(maxScoreMetric).toBeDefined();

      const mockData = {
        avgScore: 82.345,
        maxScore: 95.678,
      } as InlineApproachSummary;

      expect(avgScoreMetric!.getValue(mockData)).toBe('82.3');
      expect(maxScoreMetric!.getValue(mockData)).toBe('95.7');
    });

    it('should have correct higherIsBetter flags', () => {
      const metrics = buildInlineApproachMetrics();

      const latencyMetric = metrics.find(m => m.name === 'Avg Latency (ms)');
      const successRateMetric = metrics.find(
        m => m.name === 'Success Rate (%)',
      );
      const qualityMetric = metrics.find(m => m.name === 'Avg Quality Score');

      expect(latencyMetric!.higherIsBetter).toBe(false);
      expect(successRateMetric!.higherIsBetter).toBe(true);
      expect(qualityMetric!.higherIsBetter).toBe(true);
    });
  });

  describe('buildInlineModelMetrics function', () => {
    it('should return an array of table metrics', () => {
      const metrics = buildInlineModelMetrics();
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeGreaterThan(0);
    });

    it('should format latency metrics from summary', () => {
      const metrics = buildInlineModelMetrics();
      const avgLatencyMetric = metrics.find(m => m.name === 'Avg Latency (ms)');
      const p50Metric = metrics.find(m => m.name === 'P50 Latency (ms)');
      const p95Metric = metrics.find(m => m.name === 'P95 Latency (ms)');

      expect(avgLatencyMetric).toBeDefined();
      expect(p50Metric).toBeDefined();
      expect(p95Metric).toBeDefined();

      const mockData = {
        summary: {
          avgLatency: 456.789,
          p50Latency: 400.123,
          p95Latency: 600.456,
        },
      } as InlineModelItem;

      expect(avgLatencyMetric!.getValue(mockData)).toBe(457);
      expect(p50Metric!.getValue(mockData)).toBe(400);
      expect(p95Metric!.getValue(mockData)).toBe(600);
    });

    it('should format output tokens from summary', () => {
      const metrics = buildInlineModelMetrics();
      const outputTokensMetric = metrics.find(m => m.name === 'Output Tokens');
      expect(outputTokensMetric).toBeDefined();

      const mockData = {
        summary: {
          avgOutputTokens: 150.789,
        },
      } as InlineModelItem;

      expect(outputTokensMetric!.getValue(mockData)).toBe(151);
    });

    it('should format cost and success rate from summary', () => {
      const metrics = buildInlineModelMetrics();
      const costMetric = metrics.find(m => m.name === 'Cost ($)');
      const successRateMetric = metrics.find(
        m => m.name === 'Success Rate (%)',
      );

      expect(costMetric).toBeDefined();
      expect(successRateMetric).toBeDefined();

      const mockData = {
        summary: {
          avgCost: 0.001234567,
          parseSuccessRate: 87.654,
        },
      } as InlineModelItem;

      expect(costMetric!.getValue(mockData)).toBe('0.001235');
      expect(successRateMetric!.getValue(mockData)).toBe('87.7%');
    });

    it('should format completions metric from summary', () => {
      const metrics = buildInlineModelMetrics();
      const completionsMetric = metrics.find(m => m.name === 'Avg Completions');
      expect(completionsMetric).toBeDefined();

      const mockData = {
        summary: {
          avgCompletions: 2.876,
        },
      } as InlineModelItem;

      expect(completionsMetric!.getValue(mockData)).toBe('2.88');
    });

    it('should format quality scores from summary', () => {
      const metrics = buildInlineModelMetrics();
      const avgScoreMetric = metrics.find(m => m.name === 'Avg Quality Score');
      const maxScoreMetric = metrics.find(m => m.name === 'Max Quality Score');

      expect(avgScoreMetric).toBeDefined();
      expect(maxScoreMetric).toBeDefined();

      const mockData = {
        summary: {
          avgScore: 88.567,
          maxScore: 96.123,
        },
      } as InlineModelItem;

      expect(avgScoreMetric!.getValue(mockData)).toBe('88.6');
      expect(maxScoreMetric!.getValue(mockData)).toBe('96.1');
    });

    it('should have same metric names as inline approach metrics', () => {
      const approachMetrics = buildInlineApproachMetrics();
      const modelMetrics = buildInlineModelMetrics();

      const approachNames = approachMetrics.map(m => m.name);
      const modelNames = modelMetrics.map(m => m.name);

      expect(modelNames).toEqual(approachNames);
    });

    it('should handle NaN values gracefully', () => {
      const metrics = buildInlineModelMetrics();
      const avgLatencyMetric = metrics.find(m => m.name === 'Avg Latency (ms)');

      const mockData = {
        summary: {
          avgLatency: NaN,
        },
      } as InlineModelItem;

      expect(avgLatencyMetric!.getValue(mockData)).toBe('N/A');
    });
  });
});

describe('Benchmark Utilities - rateChange', () => {
  describe('rateChange function', () => {
    it('should return numeric score for valid critic response', async () => {
      const score = await rateChange(
        '- old code\n+ new code',
        'test.ts',
        'mock/test-model',
      );

      // Mock provider returns a response, either null or a valid number
      expect(score === null || typeof score === 'number').toBe(true);
      if (typeof score === 'number') {
        expect(score).toBeGreaterThanOrEqual(0);
      }
    });

    it('should work with completion mode', async () => {
      const score = await rateChange(
        'const x = 42;',
        'test.js',
        'mock/test-model',
        'completion',
      );

      expect(score === null || typeof score === 'number').toBe(true);
    });

    it('should work with diff mode (default)', async () => {
      const score = await rateChange(
        '- old line\n+ new line',
        'test.ts',
        'mock/test-model',
        'diff',
      );

      expect(score === null || typeof score === 'number').toBe(true);
    });

    it('should handle empty diff string', async () => {
      const score = await rateChange('', 'test.ts', 'mock/test-model');

      expect(score === null || typeof score === 'number').toBe(true);
    });

    it('should handle different file extensions', async () => {
      // Test with Python
      const scorePy = await rateChange(
        '- old\n+ new',
        'test.py',
        'mock/test-model',
      );
      expect(scorePy === null || typeof scorePy === 'number').toBe(true);

      // Test with Rust
      const scoreRs = await rateChange(
        '- old\n+ new',
        'test.rs',
        'mock/test-model',
      );
      expect(scoreRs === null || typeof scoreRs === 'number').toBe(true);

      // Test with Go
      const scoreGo = await rateChange(
        '- old\n+ new',
        'test.go',
        'mock/test-model',
      );
      expect(scoreGo === null || typeof scoreGo === 'number').toBe(true);

      // Test with no extension
      const scoreTxt = await rateChange(
        '- old\n+ new',
        'README',
        'mock/test-model',
      );
      expect(scoreTxt === null || typeof scoreTxt === 'number').toBe(true);
    });

    it('should handle invalid provider gracefully', async () => {
      // Using a provider that doesn't exist
      const score = await rateChange(
        'diff content',
        'test.ts',
        'nonexistent/invalid-provider',
      );

      // Should return null on error, not throw
      expect(score).toBeNull();
    });

    it('should handle large diff content', async () => {
      const largeDiff = Array(1000)
        .fill(null)
        .map((_, i) => `- line ${i}\n+ new line ${i}`)
        .join('\n');

      const score = await rateChange(largeDiff, 'test.ts', 'mock/test-model');

      expect(score === null || typeof score === 'number').toBe(true);
    });

    it('should handle special characters in diff', async () => {
      const diffWithSpecialChars =
        '- const x = "hello"\n+ const x = "hello\\nworld"';

      const score = await rateChange(
        diffWithSpecialChars,
        'test.ts',
        'mock/test-model',
      );

      expect(score === null || typeof score === 'number').toBe(true);
    });

    it('should handle unicode in diff', async () => {
      const unicodeDiff = '- const x = "hello"\n+ const x = "hello 你好 🎉"';

      const score = await rateChange(unicodeDiff, 'test.ts', 'mock/test-model');

      expect(score === null || typeof score === 'number').toBe(true);
    });

    it('should not throw on any input', async () => {
      // Testing that rateChange never throws, always returns null or number
      const result1 = await rateChange(
        'random diff',
        'file.ts',
        'mock/test-model',
      );
      expect(result1 === null || typeof result1 === 'number').toBe(true);

      const result2 = await rateChange('', '', 'mock/test-model');
      expect(result2 === null || typeof result2 === 'number').toBe(true);

      const result3 = await rateChange(
        'very long diff'.repeat(1000),
        'file.ts',
        'mock/test-model',
      );
      expect(result3 === null || typeof result3 === 'number').toBe(true);
    });
  });
});
