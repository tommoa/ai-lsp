import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { exportBenchmarkResults } from '../scripts/benchmark-utils';

describe('Benchmark Integration - Export', () => {
  let testOutputDir: string;

  beforeEach(() => {
    testOutputDir = `/tmp/benchmark-test-${Date.now()}`;
    try {
      fs.mkdirSync(testOutputDir, { recursive: true });
    } catch {
      // Directory might already exist
    }
  });

  it('should export benchmark results and preserve structure', () => {
    const exportPath = path.join(testOutputDir, 'results.json');
    const results: Record<string, unknown> = {
      'model1:prefix-suffix': {
        modelName: 'model1',
        approach: 'prefix-suffix',
        avgScore: 85.5,
        genAvgMs: 250,
        valid: 5,
        field3: [1, 2, 3],
      },
    };

    exportBenchmarkResults(exportPath, results);

    expect(fs.existsSync(exportPath)).toBe(true);
    const content = fs.readFileSync(exportPath, 'utf8');
    const parsed = JSON.parse(content) as Record<
      string,
      { avgScore: number; field3: number[] }
    >;
    expect(parsed).toBeDefined();
    expect(parsed['model1:prefix-suffix']?.avgScore).toBe(85.5);
    expect(parsed['model1:prefix-suffix']?.field3).toEqual([1, 2, 3]);
    expect(content).toContain('\n');
  });
});
