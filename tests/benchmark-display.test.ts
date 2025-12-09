import { describe, it, expect } from 'bun:test';
import {
  shortenModelName,
  formatNumber,
  formatCost,
  colorizeUnifiedDiff,
  printComparisonTable,
  buildBenchmarkApproachMetrics,
  buildBenchmarkModelMetrics,
  buildInlineApproachMetrics,
  buildInlineModelMetrics,
  type BenchmarkApproachSummary,
} from '../scripts/benchmark-utils';

describe('shortenModelName', () => {
  it('should remove date suffixes', () => {
    expect(shortenModelName('anthropic/claude-3-5-sonnet-20241022')).toBe(
      'claude-3.5-sonnet',
    );
    expect(shortenModelName('openai/gpt-4o-20231215')).toBe('gpt-4o');
  });

  it('should simplify claude version numbers', () => {
    expect(shortenModelName('claude-3-5-sonnet')).toBe('claude-3.5-sonnet');
    expect(shortenModelName('claude-2-1')).toBe('claude-2.1');
  });

  it('should extract model name from provider/model format', () => {
    expect(shortenModelName('openai/gpt-4o')).toBe('gpt-4o');
    expect(shortenModelName('anthropic/claude-3-opus')).toBe('claude-3-opus');
  });

  it('should handle models without provider prefix', () => {
    expect(shortenModelName('gpt-4o')).toBe('gpt-4o');
    expect(shortenModelName('gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });
});

describe('formatNumber', () => {
  it('should format integers', () => {
    expect(formatNumber(42, { type: 'int' })).toBe(42);
    expect(formatNumber(42.7, { type: 'int' })).toBe(43);
  });

  it('should format fixed decimals', () => {
    expect(formatNumber(3.14159, { type: 'fixed', decimals: 2 })).toBe('3.14');
    expect(formatNumber(100, { type: 'fixed', decimals: 3 })).toBe('100.000');
  });

  it('should format percentages', () => {
    expect(formatNumber(95.5, { type: 'percent' })).toBe('95.5%');
    expect(formatNumber(100, { type: 'percent', decimals: 2 })).toBe('100.00%');
  });

  it('should format milliseconds', () => {
    expect(formatNumber(1234.5, { type: 'ms' })).toBe('1235ms');
    expect(formatNumber(42, { type: 'ms' })).toBe('42ms');
  });

  it('should format rounded numbers', () => {
    expect(formatNumber(3.7, { type: 'round' })).toBe('4');
    expect(formatNumber(42.1, { type: 'round' })).toBe('42');
  });

  it('should return N/A for NaN', () => {
    expect(formatNumber(NaN, { type: 'int' })).toBe('N/A');
    expect(formatNumber(NaN, { type: 'fixed', decimals: 2 })).toBe('N/A');
  });
});

describe('formatCost', () => {
  it('should format basic cost', () => {
    expect(formatCost(0.001234)).toBe('$0.001234');
    expect(formatCost(0.0)).toBe('$0.000000');
  });

  it('should include uncached cost when different', () => {
    const result = formatCost(0.001, 0.002);
    expect(result).toContain('$0.001000');
    expect(result).toContain('uncached: $0.002000');
  });

  it('should not include uncached cost when same', () => {
    const result = formatCost(0.001, 0.001);
    expect(result).toBe('$0.001000');
  });

  it('should handle NaN cost', () => {
    expect(formatCost(NaN)).toBe('N/A');
  });

  it('should handle undefined uncached cost', () => {
    expect(formatCost(0.001, undefined)).toBe('$0.001000');
  });
});

describe('colorizeUnifiedDiff', () => {
  it('should colorize diff with ANSI codes', () => {
    const diff = '+added\n-removed\n context\n@@ hunk @@';
    const colored = colorizeUnifiedDiff(diff, false);
    expect(colored).toContain('\x1b[32m+added\x1b[0m');
    expect(colored).toContain('\x1b[31m-removed\x1b[0m');
    expect(colored).toContain('\x1b[36m@@ hunk @@\x1b[0m');
  });

  it('should not colorize when noColor is true', () => {
    const diff = '+added\n-removed';
    const result = colorizeUnifiedDiff(diff, true);
    expect(result).toBe(diff);
    expect(result).not.toContain('\x1b[');
  });

  it('should handle file headers', () => {
    const diff = '--- a/file\n+++ b/file';
    const colored = colorizeUnifiedDiff(diff, false);
    expect(colored).toContain('\x1b[1m---');
    expect(colored).toContain('\x1b[1m+++');
  });
});

describe('printComparisonTable', () => {
  it('should print comparison table for items', () => {
    const items = [
      { name: 'approach1', score: 85, time: 100 },
      { name: 'approach2', score: 90, time: 120 },
    ];

    interface TestItem {
      name: string;
      score: number;
      time: number;
    }
    const metrics = [
      {
        name: 'Score',
        getValue: (item: TestItem) => item.score,
        higherIsBetter: true,
      },
      {
        name: 'Time (ms)',
        getValue: (item: TestItem) => item.time,
        higherIsBetter: false,
      },
    ];

    // Just verify it doesn't crash - output goes to console
    expect(() => {
      printComparisonTable(items, item => item.name, metrics);
    }).not.toThrow();
  });

  it('should not print for single item', () => {
    const items = [{ name: 'only', value: 42 }];
    const metrics = [
      { name: 'Value', getValue: (item: { value: number }) => item.value },
    ];

    // Should not print for < 2 items
    expect(() => {
      printComparisonTable(items, item => item.name, metrics);
    }).not.toThrow();
  });
});

describe('metric builders', () => {
  it('should build benchmark approach metrics', () => {
    const metrics = buildBenchmarkApproachMetrics(3);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('name');
    expect(metrics[0]).toHaveProperty('getValue');
  });

  it('should build benchmark model metrics', () => {
    const metrics = buildBenchmarkModelMetrics(3);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('name');
    expect(metrics[0]).toHaveProperty('getValue');
  });

  it('should build inline approach metrics', () => {
    const metrics = buildInlineApproachMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('name');
    expect(metrics[0]).toHaveProperty('getValue');
  });

  it('should build inline model metrics', () => {
    const metrics = buildInlineModelMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]).toHaveProperty('name');
    expect(metrics[0]).toHaveProperty('getValue');
  });

  it('should have getValue functions that work', () => {
    const metrics = buildBenchmarkApproachMetrics(3);
    const testData = {
      avgScore: 85.5,
      genAvgMs: 1234,
      genAvgInputTokens: 500,
      genAvgOutputTokens: 100,
      genAvgCost: 0.001,
      valid: 3,
      parseSuccessRate: 95.5,
      avgHintsPerRun: 2.5,
      avgConversionRate: 90.0,
    } as BenchmarkApproachSummary;

    for (const metric of metrics) {
      const value = metric.getValue(testData);
      expect(value).toBeDefined();
    }
  });
});
