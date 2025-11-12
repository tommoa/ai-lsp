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
    'Usage: bun run scripts/analyze-ab-results.ts --results <path-to-json> ' +
      '[--model <model-name>]',
  );
  console.log('');
  console.log('The JSON file should contain benchmark results exported from');
  console.log('benchmark-next-edit-ab.ts using --export-json flag.');
  console.log('');
  console.log('Use --model to specify which model to analyze (optional).');
  console.log('If not specified, will analyze the first model found.');
  process.exit(1);
}

function parseArgs(): Record<string, string | undefined> {
  const argv = process.argv.slice(2);
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') out.results = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else usage();
  }
  return out;
}

type _AnalysisData = {
  scores: number[];
  genLatencies: number[];
  genTokensInput: number[];
  genTokensOutput: number[];
  genCosts: number[];
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
  let rawResults: Record<string, any>;
  try {
    rawResults = JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse JSON:', String(e));
    process.exit(1);
  }

  // New format: keys are "model:approach"
  // Extract model names
  const modelNames = new Set<string>();
  for (const key of Object.keys(rawResults)) {
    if (key.includes(':')) {
      const [modelName] = key.split(':');
      modelNames.add(modelName!);
    }
  }

  if (modelNames.size === 0) {
    console.error(
      'No valid results found. Expected format: "model:approach" keys',
    );
    process.exit(1);
  }

  // Select model to analyze
  const requestedModel = args.model;
  let selectedModel: string;

  if (requestedModel) {
    if (!modelNames.has(requestedModel)) {
      console.error(`Model "${requestedModel}" not found in results.`);
      console.error(`Available models: ${Array.from(modelNames).join(', ')}`);
      process.exit(1);
    }
    selectedModel = requestedModel;
  } else {
    selectedModel = Array.from(modelNames)[0]!;
    if (modelNames.size > 1) {
      console.log(`Multiple models found. Analyzing: ${selectedModel}`);
      console.log(
        `Use --model to specify: ${Array.from(modelNames).join(', ')}\n`,
      );
    }
  }

  // Extract baseline and linenum for selected model
  const baselineKey = `${selectedModel}:baseline`;
  const linenumKey = `${selectedModel}:linenum`;

  const baseline = rawResults[baselineKey];
  const linenum = rawResults[linenumKey];

  if (!baseline || !linenum) {
    console.error(
      `Model "${selectedModel}" must have both baseline and linenum results`,
    );
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

  const baselineTokens = baseline.genTokensInput.map(
    (inp: number, i: number) => inp + (baseline.genTokensOutput[i] ?? 0),
  );
  const linenumTokens = linenum.genTokensInput.map(
    (inp: number, i: number) => inp + (linenum.genTokensOutput[i] ?? 0),
  );

  printStats('Baseline', baselineTokens, ' tokens');
  console.log();
  printStats('LineNum', linenumTokens, ' tokens');

  if (baselineTokens.length > 1 && linenumTokens.length > 1) {
    const meanDiff = mean(baselineTokens) - mean(linenumTokens);
    const pctDiff = ((meanDiff / mean(baselineTokens)) * 100).toFixed(1);
    console.log(
      `\nMean difference: ${meanDiff.toFixed(0)} tokens (${pctDiff}%)`,
    );
  }

  // Detailed input/output breakdown
  console.log('\n━━━ DETAILED TOKEN BREAKDOWN ━━━');
  console.log('\nBaseline:');
  printStats('  Input Tokens', baseline.genTokensInput, ' tokens');
  printStats('  Output Tokens', baseline.genTokensOutput, ' tokens');
  console.log('\nLineNum:');
  printStats('  Input Tokens', linenum.genTokensInput, ' tokens');
  printStats('  Output Tokens', linenum.genTokensOutput, ' tokens');

  // Cost Analysis
  console.log('\n━━━ GENERATION COST ($) ━━━');
  printStats('Baseline', baseline.genCosts, ' $');
  console.log();
  printStats('LineNum', linenum.genCosts, ' $');

  const meanDiff = mean(baseline.genCosts) - mean(linenum.genCosts);
  const pctDiff = ((meanDiff / mean(baseline.genCosts)) * 100).toFixed(1);
  console.log(`\nMean difference: $${meanDiff.toFixed(6)} (${pctDiff}%)`);

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

  const baselineTokenMean = mean(baselineTokens);
  const linenumTokenMean = mean(linenumTokens);
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
