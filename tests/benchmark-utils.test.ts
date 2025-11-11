import { describe, it, expect } from 'bun:test';
import {
  avg,
  percentile,
  calculateCost,
  parseApproachArg,
  parseCommonArgs,
  classifyParseError,
  createEditDiff,
  colorizeUnifiedDiff,
  extractTokenMetricArrays,
  runConcurrent,
} from '../scripts/benchmark-utils';
import type { TokenUsage } from '../src/util';

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
      const validApproaches = ['prefix_suffix', 'line_number'] as const;
      const result = parseApproachArg('all', validApproaches);
      expect(result).toEqual(['prefix_suffix', 'line_number']);
    });

    it('should throw error for invalid approach', () => {
      const validApproaches = ['prefix_suffix', 'line_number'] as const;
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
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 },
          },
          text: 'Y',
        },
      ];
      const diff = createEditDiff(original, edits);
      expect(diff.indexOf('Y')).toBeLessThan(diff.indexOf('X'));
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
      const result = extractTokenMetricArrays(runMetrics as any);
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
      await runConcurrent(5, 2, async idx => {
        executed.push(idx);
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
      await runConcurrent(3, 0, async idx => {
        executed.push(idx);
      });
      expect(executed.length).toBe(3);
    });

    it('should handle concurrency greater than total runs', async () => {
      const executed: number[] = [];
      await runConcurrent(3, 10, async idx => {
        executed.push(idx);
      });
      expect(executed.length).toBe(3);
    });
  });
});
