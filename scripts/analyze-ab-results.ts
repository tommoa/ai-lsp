#!/usr/bin/env bun
/**
 * Analysis script for A/B test results.
 * Reads benchmark output (or JSON results file) and provides
 * statistical comparison.
 * Usage: bun run scripts/analyze-ab-results.ts --results <path-to-json>
 */

import fs from 'fs';
import path from 'path';

function usage(): void {
  console.log(
    'Usage: bun run scripts/analyze-ab-results.ts --results <path-to-json>',
  );
  console.log('');
  console.log('The JSON file should contain benchmark results in this format:');
  console.log('{');
  console.log('  "baseline": {');
  console.log('    "scores": [100, 95, 98],');
  console.log('    "genLatencies": [123, 145, 156],');
  console.log('    "genTokens": [450, 460, 470],');
  console.log('    "genCosts": [0.001, 0.002, 0.003]');
  console.log('  },');
  console.log('  "linenum": { ... }');
  console.log('}');
  process.exit(1);
}

function parseArgs(): Record<string, string | undefined> {
  const argv = process.argv.slice(2);
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') out.results = argv[++i];
    else usage();
  }
  return out;
}

type AnalysisData = {
  scores: number[];
  genLatencies: number[];
  genTokens: number[];
  genCosts: number[];
};

type ResultsFile = {
  baseline?: AnalysisData;
  linenum?: AnalysisData;
};

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stddev(arr: number[], m?: number): number {
  if (arr.length < 2) return NaN;
  const mu = m ?? mean(arr);
  const variance =
    arr.reduce((a, b) => a + (b - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function min(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return Math.min(...arr);
}

function max(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return Math.max(...arr);
}

/**
 * Welch's t-test for comparing two independent samples.
 * Returns the t-statistic and an indication of significance.
 */
function tTest(
  arr1: number[],
  arr2: number[],
): {
  t: number;
  significant: boolean;
} {
  if (arr1.length < 2 || arr2.length < 2) {
    return { t: NaN, significant: false };
  }

  const m1 = mean(arr1);
  const m2 = mean(arr2);
  const sd1 = stddev(arr1, m1);
  const sd2 = stddev(arr2, m2);
  const n1 = arr1.length;
  const n2 = arr2.length;

  const se = Math.sqrt(sd1 ** 2 / n1 + sd2 ** 2 / n2);
  if (se === 0) return { t: NaN, significant: false };

  const t = (m1 - m2) / se;
  // Very rough p-value estimate (two-tailed)
  const absT = Math.abs(t);
  // For adequate sample sizes, approximate p-value
  const pValue = absT > 2.0 ? 0.05 : absT > 1.5 ? 0.1 : 1.0;
  return { t, significant: pValue < 0.05 };
}

function printStats(label: string, data: number[], unit: string = ''): void {
  if (data.length === 0) {
    console.log(`${label}: N/A (no data)`);
    return;
  }
  const m = mean(data);
  const med = median(data);
  const sd = stddev(data);
  const minVal = min(data);
  const maxVal = max(data);

  const mStr = Number.isNaN(m) ? 'N/A' : m.toFixed(2);
  const medStr = Number.isNaN(med) ? 'N/A' : med.toFixed(2);
  const sdStr = Number.isNaN(sd) ? 'N/A' : sd.toFixed(2);
  const minStr = Number.isNaN(minVal) ? 'N/A' : minVal.toFixed(2);
  const maxStr = Number.isNaN(maxVal) ? 'N/A' : maxVal.toFixed(2);

  console.log(`${label}:`);
  console.log(`  Mean: ${mStr}${unit}`);
  console.log(`  Median: ${medStr}${unit}`);
  console.log(`  StdDev: ${sdStr}${unit}`);
  console.log(`  Min: ${minStr}${unit}`);
  console.log(`  Max: ${maxStr}${unit}`);
  console.log(`  Count: ${data.length}`);
}

function main(): void {
  const args = parseArgs();
  if (!args.results) usage();

  const resultsPath = path.resolve(args.results as string);
  if (!fs.existsSync(resultsPath)) {
    console.error(`File not found: ${resultsPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resultsPath, 'utf8');
  let results: ResultsFile;
  try {
    results = JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse JSON:', String(e));
    process.exit(1);
  }

  const baseline = results.baseline;
  const linenum = results.linenum;

  if (!baseline || !linenum) {
    console.error('Results must contain both "baseline" and "linenum" data');
    process.exit(1);
  }

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║        A/B TEST ANALYSIS - BASELINE vs LINENUM     ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Quality Score Analysis
  console.log('\n━━━ QUALITY SCORE ━━━');
  printStats('Baseline', baseline.scores);
  console.log();
  printStats('LineNum', linenum.scores);

  if (baseline.scores.length > 1 && linenum.scores.length > 1) {
    const { t, significant } = tTest(baseline.scores, linenum.scores);
    console.log(
      `\nT-test result: t=${Number.isNaN(t) ? 'N/A' : t.toFixed(3)}, ` +
        `significant=${significant}`,
    );
    const meanDiff = (mean(baseline.scores) - mean(linenum.scores)).toFixed(2);
    console.log(`Mean difference: ${meanDiff} (baseline - linenum)`);
  }

  // Generation Latency Analysis
  console.log('\n━━━ GENERATION LATENCY (ms) ━━━');
  printStats('Baseline', baseline.genLatencies, ' ms');
  console.log();
  printStats('LineNum', linenum.genLatencies, ' ms');

  if (baseline.genLatencies.length > 1 && linenum.genLatencies.length > 1) {
    const { t, significant } = tTest(
      baseline.genLatencies,
      linenum.genLatencies,
    );
    console.log(
      `\nT-test result: t=${Number.isNaN(t) ? 'N/A' : t.toFixed(3)}, ` +
        `significant=${significant}`,
    );
    const meanDiff = mean(baseline.genLatencies) - mean(linenum.genLatencies);
    const pctDiff = ((meanDiff / mean(baseline.genLatencies)) * 100).toFixed(1);
    console.log(
      `Mean difference: ${meanDiff.toFixed(0)} ms (${pctDiff}% faster/slower)`,
    );
  }

  // Token Usage Analysis
  console.log('\n━━━ TOKEN USAGE ━━━');
  printStats('Baseline', baseline.genTokens, ' tokens');
  console.log();
  printStats('LineNum', linenum.genTokens, ' tokens');

  if (baseline.genTokens.length > 1 && linenum.genTokens.length > 1) {
    const meanDiff = mean(baseline.genTokens) - mean(linenum.genTokens);
    const pctDiff = ((meanDiff / mean(baseline.genTokens)) * 100).toFixed(1);
    console.log(
      `\nMean difference: ${meanDiff.toFixed(0)} tokens (${pctDiff}%)`,
    );
  }

  // Cost Analysis
  if (baseline.genCosts.length > 0 && linenum.genCosts.length > 0) {
    console.log('\n━━━ GENERATION COST ($) ━━━');
    printStats('Baseline', baseline.genCosts, ' $');
    console.log();
    printStats('LineNum', linenum.genCosts, ' $');

    const meanDiff = mean(baseline.genCosts) - mean(linenum.genCosts);
    const pctDiff = ((meanDiff / mean(baseline.genCosts)) * 100).toFixed(1);
    console.log(`\nMean difference: $${meanDiff.toFixed(6)} (${pctDiff}%)`);
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY & RECOMMENDATIONS');
  console.log('═'.repeat(60));

  const baselineScoreMean = mean(baseline.scores);
  const linenumScoreMean = mean(linenum.scores);
  const qualityWinner =
    baselineScoreMean > linenumScoreMean ? 'Baseline' : 'LineNum';

  const baselineLatencyMean = mean(baseline.genLatencies);
  const linenumLatencyMean = mean(linenum.genLatencies);
  const latencyWinner =
    baselineLatencyMean < linenumLatencyMean ? 'Baseline' : 'LineNum';

  const baselineTokenMean = mean(baseline.genTokens);
  const linenumTokenMean = mean(linenum.genTokens);
  const tokenWinner =
    baselineTokenMean < linenumTokenMean ? 'Baseline' : 'LineNum';

  console.log(`\nQuality Winner: ${qualityWinner}`);
  console.log(`Speed Winner: ${latencyWinner}`);
  console.log(`Efficiency Winner: ${tokenWinner}`);

  if (qualityWinner === latencyWinner && qualityWinner === tokenWinner) {
    console.log(`\n✓ Clear winner: ${qualityWinner}`);
  } else {
    console.log('\n⚠ Trade-offs detected. Consider priorities:');
    console.log('  - If quality is priority: use ' + qualityWinner);
    console.log('  - If speed is priority: use ' + latencyWinner);
    console.log('  - If cost is priority: use ' + tokenWinner);
  }
}

main();
