import path from 'path';
import fs from 'fs';
import { createProvider, parseModelString } from '../src/provider/provider';
import { generateText, type ModelMessage } from 'ai';
import type { ModelCost } from '../src/provider/module-resolver';
import { Parser, NOOP_LOG, type TokenUsage } from '../src/util';

export type TokenCost = {
  cost: number;
  costWithoutCache: number;
};

/**
 * Test case for inline completion or editing benchmarks.
 */
export interface TestCase {
  name: string;
  language: string;
  before: string;
  after: string;
  description?: string;
}

export type ParseErrorType =
  | 'none'
  | 'json_parse'
  | 'schema_invalid'
  | 'extraction_failed'
  | 'conversion_failed'
  | 'generation_failed';

const CRITIC_PROMPT =
  'You are a strict code reviewer. All scores are out of 100. ' +
  'Return ONLY a JSON object with the schema {"overall":number,...}. ' +
  'Be concise.';

export function classifyParseError(err: unknown): ParseErrorType {
  const msg = String(err);
  if (msg.includes('JSON')) return 'json_parse';
  if (msg.includes('Invalid hint shape')) return 'schema_invalid';
  if (msg.includes('not an array')) return 'extraction_failed';
  if (msg.includes('Unsupported') || msg.includes('invalid')) {
    return 'conversion_failed';
  }
  return 'schema_invalid';
}

export function calculateCost(
  tokens: TokenUsage,
  modelCost: ModelCost | undefined,
): TokenCost | null {
  if (!modelCost) return null;

  // Helper to calculate cost for a given number of tokens at a rate
  const calcTokenCost = (tokenCount: number, rate: number): number =>
    (tokenCount / 1_000_000) * rate;

  const nonCachedInput = tokens.input - (tokens.cachedInput ?? 0);
  const outputTokenCost = calcTokenCost(tokens.output, modelCost.output);
  const reasoningTokenCost = tokens.reasoning
    ? calcTokenCost(tokens.reasoning, modelCost.output)
    : 0;
  const cachedInputTokenCost = tokens.cachedInput
    ? calcTokenCost(tokens.cachedInput, modelCost.cache_read ?? modelCost.input)
    : 0;

  const nonCachedInputTokenCost = calcTokenCost(
    nonCachedInput,
    modelCost.input,
  );

  return {
    cost:
      nonCachedInputTokenCost +
      outputTokenCost +
      reasoningTokenCost +
      cachedInputTokenCost,
    costWithoutCache:
      calcTokenCost(tokens.input, modelCost.input) +
      outputTokenCost +
      reasoningTokenCost,
  };
}

/**
 * Create a unified diff showing only the edited regions with context.
 * This is much more readable than a full-file line-by-line diff.
 */
export function createEditDiff(
  original: string,
  edits: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    text: string;
  }>,
  contextLines = 3,
): string {
  if (edits.length === 0) return '';

  const originalLines = original.split('\n');
  const hunks: string[] = [];

  // Sort edits by start position
  const sortedEdits = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return a.range.start.line - b.range.start.line;
    }
    return a.range.start.character - b.range.start.character;
  });

  for (const edit of sortedEdits) {
    const { start, end } = edit.range;
    const hunkLines: string[] = [];

    // Add context before
    const contextStart = Math.max(0, start.line - contextLines);
    for (let i = contextStart; i < start.line; i++) {
      hunkLines.push(' ' + originalLines[i]);
    }

    // Add the old and new content
    if (start.line === end.line) {
      // Single line edit - show old and new versions
      const line = originalLines[start.line] ?? '';
      const before = line.slice(0, start.character);
      const deleted = line.slice(start.character, end.character);
      const after = line.slice(end.character);

      // Show the old line only if something was deleted
      if (deleted) {
        hunkLines.push('-' + line);
      }
      // Show the new line
      hunkLines.push('+' + before + edit.text + after);
    } else {
      // Multi-line edit
      for (let i = start.line; i <= end.line && i < originalLines.length; i++) {
        hunkLines.push('-' + originalLines[i]);
      }

      // Add the new content
      const newLines = edit.text.split('\n');
      for (const newLine of newLines) {
        hunkLines.push('+' + newLine);
      }
    }

    // Add context after
    const contextEnd = Math.min(
      originalLines.length,
      end.line + contextLines + 1,
    );
    for (let i = end.line + 1; i < contextEnd; i++) {
      hunkLines.push(' ' + originalLines[i]);
    }

    // Add hunk header
    const hunkHeader = `@@ -${start.line + 1},${
      end.line - start.line + 1
    } +${start.line + 1} @@`;
    hunks.push(hunkHeader + '\n' + hunkLines.join('\n'));
  }

  return hunks.join('\n\n');
}

export function colorizeUnifiedDiff(diffText: string, noColor = false): string {
  if (noColor) return diffText;
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const CYAN = '\x1b[36m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';

  return diffText
    .split('\n')
    .map(line => {
      if (line.startsWith('+++') || line.startsWith('---'))
        return BOLD + line + RESET;
      if (line.startsWith('@@')) return CYAN + line + RESET;
      if (line.startsWith('+') && !line.startsWith('+++'))
        return GREEN + line + RESET;
      if (line.startsWith('-') && !line.startsWith('---'))
        return RED + line + RESET;
      return line;
    })
    .join('\n');
}

export async function rateChange(
  diff: string,
  filePath: string,
  criticModelStr: string,
): Promise<number | null> {
  const ratingPayload = {
    metadata: {
      language: path.extname(filePath).slice(1) || 'text',
      file: filePath,
      model_used: criticModelStr,
    },
    quickChecks: {},
    diff,
  };

  try {
    const { providerId, modelName } = parseModelString(criticModelStr);
    const criticFactory = await createProvider({
      provider: providerId,
      log: NOOP_LOG,
    });
    const criticModelObj = criticFactory(modelName);
    const promptText = `${CRITIC_PROMPT}\n${JSON.stringify(
      ratingPayload,
      null,
      2,
    )}`;

    const messages: ModelMessage[] = [{ role: 'user', content: promptText }];
    const res = await generateText({
      model: criticModelObj,
      messages,
    });
    const criticRaw = (res as any)?.text ?? String(res ?? '');

    const parsed = Parser.parseJSONObject(criticRaw);
    return typeof parsed?.overall === 'number' ? parsed.overall : null;
  } catch {
    return null;
  }
}

/**
 * Calculate average of a numeric array
 */
export function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

/**
 * Calculate percentile of a numeric array
 */
export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? NaN;
}

/**
 * Metric definitions for inline-benchmark.ts approach comparison
 */
export async function runConcurrent<T>(
  totalRuns: number,
  concurrency: number,
  worker: (idx: number) => Promise<T>,
): Promise<void> {
  let nextIdx = 0;

  const workerFn = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= totalRuns) return;
      await worker(idx);
    }
  };

  const workers: Promise<void>[] = [];
  const usedConcurrency = Math.max(1, Math.min(concurrency, totalRuns));
  for (let w = 0; w < usedConcurrency; w++) workers.push(workerFn());
  await Promise.all(workers);
}

/**
 * Common benchmark options shared across all benchmark scripts
 */
export interface CommonBenchmarkOptions {
  models: string[];
  runs: number;
  concurrency: number;
  preview: boolean;
  noColor: boolean;
  critic: boolean;
  criticModel: string;
  exportJson?: string;
}

/**
 * Parse and validate approach argument from command line.
 * If approach is 'all', returns all valid approaches. Otherwise validates
 * against the provided list.
 */
export function parseApproachArg<T extends string>(
  approach: string,
  validApproaches: readonly T[],
): T[] {
  if (approach === 'all') {
    return [...validApproaches];
  }
  if (validApproaches.includes(approach as T)) {
    return [approach as T];
  }
  throw new Error(
    `Invalid approach: ${approach}. ` +
      `Must be ${validApproaches.join(', ')}, or 'all'.`,
  );
}

/**
 * Parse command-line arguments common to all benchmark scripts.
 * Returns common options and remaining unparsed arguments.
 */
export function parseCommonArgs(argv: string[]): {
  common: CommonBenchmarkOptions;
  remaining: string[];
} {
  const flags = new Set([
    '--preview',
    '--no-color',
    '--critic',
    '--export-json',
  ]);
  const options = new Set([
    '--runs',
    '--concurrency',
    '--models',
    '--critic-model',
  ]);
  const parsed = new Map<string, string | boolean>();
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (flags.has(arg)) {
      parsed.set(arg, true);
    } else if (options.has(arg) && i + 1 < argv.length) {
      parsed.set(arg, argv[++i]!);
    } else {
      remaining.push(arg);
    }
  }

  const models = ((parsed.get('--models') as string) || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const criticModel =
    (parsed.get('--critic-model') as string) || models[0] || '';

  return {
    common: {
      models,
      runs: Math.max(1, Number(parsed.get('--runs') ?? '3')),
      concurrency: Math.max(1, Number(parsed.get('--concurrency') ?? '2')),
      preview: Boolean(parsed.get('--preview')),
      noColor: Boolean(parsed.get('--no-color')),
      critic: Boolean(parsed.get('--critic')),
      criticModel,
      exportJson: (parsed.get('--export-json') as string) || undefined,
    },
    remaining,
  };
}

/**
 * Configuration for a metric column in a comparison table
 */
export interface TableMetric<T> {
  name: string;
  getValue: (item: T) => number | string;
  higherIsBetter?: boolean;
}

/**
 * Print a comparison table for benchmark results
 */
export function printComparisonTable<T>(
  items: T[],
  getLabel: (item: T) => string,
  metrics: TableMetric<T>[],
  options?: {
    metricColWidth?: number;
    valueColWidth?: number;
  },
): void {
  if (items.length < 2) return;

  const minMetricColWidth = options?.metricColWidth ?? 22;
  const minValueColWidth = options?.valueColWidth ?? 18;

  // Calculate dynamic column widths based on content
  const labels = items.map(i => getLabel(i));
  const maxLabelLength = Math.max(...labels.map(l => l.length));
  const valueColWidth = Math.max(minValueColWidth, maxLabelLength + 2);

  const maxMetricLength = Math.max(...metrics.map(m => m.name.length));
  const metricColWidth = Math.max(minMetricColWidth, maxMetricLength + 2);

  const winnerColWidth = 14;
  const totalWidth =
    metricColWidth + valueColWidth * items.length + winnerColWidth + 4 + 2;

  // Helper to find best value index
  const findBestIdx = (values: number[], higherIsBetter = false): number => {
    if (values.length === 0) return 0;
    const extremeFn = higherIsBetter ? Math.max : Math.min;
    const extremeVal = extremeFn(...values);
    return values.indexOf(extremeVal);
  };

  console.log(`\n${'='.repeat(totalWidth)}`);
  console.log('COMPARISON TABLE');
  console.log(`${'='.repeat(totalWidth)}`);

  const header =
    'Metric'.padEnd(metricColWidth) +
    '| ' +
    labels.map(l => l.padEnd(valueColWidth)).join('| ') +
    '| ' +
    'Winner'.padEnd(winnerColWidth);
  console.log(header);
  console.log('-'.repeat(totalWidth));

  for (const metric of metrics) {
    const values = items.map(item => {
      const val = metric.getValue(item);
      const formatted =
        typeof val === 'string'
          ? val
          : formatNumber(val as number, { type: 'fixed', decimals: 2 });
      return String(formatted).padEnd(valueColWidth);
    });

    let winner = '-';
    const numericValues = items.map(item => {
      const val = metric.getValue(item);
      return typeof val === 'string' ? NaN : Number(val);
    });

    if (numericValues.every(v => !Number.isNaN(v))) {
      const bestIdx = findBestIdx(numericValues, metric.higherIsBetter);
      winner = getLabel(items[bestIdx]!);
    }

    const row =
      metric.name.padEnd(metricColWidth) +
      '| ' +
      values.join('| ') +
      '| ' +
      winner.padEnd(winnerColWidth);
    console.log(row);
  }

  console.log('='.repeat(totalWidth));
}

/**
 * Shorten a model name for display in tables
 * Examples:
 * - "anthropic/claude-3-5-sonnet-20241022" -> "claude-3.5-sonnet"
 * - "openai/gpt-4o" -> "gpt-4o"
 * - "gemini-2.0-flash" -> "gemini-2.0-flash"
 */
export function shortenModelName(fullName: string): string {
  const name = fullName.split('/').at(-1) || fullName;
  return name
    .replace(/-20\d{6}$/g, '') // Remove date suffixes like -20241022
    .replace(/claude-(\d+)-(\d+)/, 'claude-$1.$2'); // Simplify claude version numbers (3-5 -> 3.5)
}

export type NumberFormat =
  | { type: 'int' }
  | { type: 'fixed'; decimals: number }
  | { type: 'percent'; decimals?: number }
  | { type: 'ms' }
  | { type: 'round' };

/**
 * Format a string representation of a number, returning 'N/A' if NaN
 */
export function formatNumberString(
  value: number,
  formatter: (v: number) => string,
): string {
  return Number.isNaN(value) ? 'N/A' : formatter(value);
}

/**
 * Format a number with specified format type. Returns string or number
 * depending on the format. Returns 'N/A' for NaN values.
 */
export function formatNumber(
  value: number,
  format: NumberFormat,
): string | number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A';

  switch (format.type) {
    case 'int':
      return Math.round(value);
    case 'fixed':
      return value.toFixed(format.decimals);
    case 'percent':
      return value.toFixed(format.decimals ?? 1) + '%';
    case 'ms':
      return Math.round(value) + 'ms';
    case 'round':
      return String(Math.round(value));
  }
}

/**
 * Format cost information with optional uncached cost
 */
export function formatCost(cost: number, uncachedCost?: number): string {
  if (Number.isNaN(cost)) return 'N/A';
  let result = `$${formatNumber(cost, { type: 'fixed', decimals: 6 })}`;
  if (
    uncachedCost !== undefined &&
    !Number.isNaN(uncachedCost) &&
    uncachedCost !== cost
  ) {
    result += ` (uncached: $${formatNumber(uncachedCost, {
      type: 'fixed',
      decimals: 6,
    })})`;
  }
  return result;
}

/**
 * Export benchmark results to JSON file
 */
export function exportBenchmarkResults(
  exportPath: string,
  results: Record<string, any>,
): void {
  fs.writeFileSync(exportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nResults exported to: ${exportPath}`);
}

/**
 * Extract token metric arrays from run metrics.
 * Filters metrics with valid tokenMetrics and extracts individual arrays.
 */
export function extractTokenMetricArrays(
  runMetrics: Array<{ tokenMetrics?: TokenUsage & TokenCost }>,
): {
  tokensInput: number[];
  tokensOutput: number[];
  tokensReasoning: number[];
  tokensCachedInput: number[];
  costs: number[];
  costsWithoutCache: number[];
} {
  const tokenMetrics = runMetrics
    .filter(m => m.tokenMetrics !== undefined)
    .map(m => m.tokenMetrics!);

  return {
    tokensInput: tokenMetrics.map(t => t.input),
    tokensOutput: tokenMetrics.map(t => t.output),
    tokensReasoning: tokenMetrics
      .filter(t => t.reasoning !== undefined)
      .map(t => t.reasoning!),
    tokensCachedInput: tokenMetrics
      .filter(t => t.cachedInput !== undefined)
      .map(t => t.cachedInput!),
    costs: tokenMetrics.map(t => t.cost),
    costsWithoutCache: tokenMetrics.map(t => t.costWithoutCache),
  };
}

/**
 * Metric definitions for benchmark.ts approach comparison
 */
export function buildBenchmarkApproachMetrics(
  runs: number,
): TableMetric<any>[] {
  return [
    {
      name: 'Quality Score',
      getValue: (s: any) => s.avgScore,
      higherIsBetter: true,
    },
    {
      name: 'Gen Latency (ms)',
      getValue: (s: any) => s.genAvgMs,
      higherIsBetter: false,
    },
    {
      name: 'Gen Input Tokens',
      getValue: (s: any) => s.genAvgInputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Output Tokens',
      getValue: (s: any) => s.genAvgOutputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Cost ($)',
      getValue: (s: any) => s.genAvgCost,
      higherIsBetter: false,
    },
    {
      name: 'Success Rate',
      getValue: (s: any) => (s.valid / runs) * 100,
      higherIsBetter: true,
    },
    {
      name: 'Parse Success Rate',
      getValue: (s: any) => s.parseSuccessRate,
      higherIsBetter: true,
    },
    {
      name: 'Avg Hints Per Run',
      getValue: (s: any) => s.avgHintsPerRun,
      higherIsBetter: true,
    },
    {
      name: 'Conversion Rate (%)',
      getValue: (s: any) => s.avgConversionRate,
      higherIsBetter: true,
    },
  ];
}

/**
 * Metric definitions for benchmark.ts model comparison
 */
export function buildBenchmarkModelMetrics(runs: number): TableMetric<any>[] {
  return [
    {
      name: 'Quality Score',
      getValue: (item: any) => item.summary.avgScore,
      higherIsBetter: true,
    },
    {
      name: 'Gen Latency (ms)',
      getValue: (item: any) => item.summary.genAvgMs,
      higherIsBetter: false,
    },
    {
      name: 'Gen Input Tokens',
      getValue: (item: any) => item.summary.genAvgInputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Output Tokens',
      getValue: (item: any) => item.summary.genAvgOutputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Cost ($)',
      getValue: (item: any) => item.summary.genAvgCost,
      higherIsBetter: false,
    },
    {
      name: 'Success Rate',
      getValue: (item: any) => (item.summary.valid / runs) * 100,
      higherIsBetter: true,
    },
    {
      name: 'Parse Success Rate',
      getValue: (item: any) => item.summary.parseSuccessRate,
      higherIsBetter: true,
    },
    {
      name: 'Avg Hints Per Run',
      getValue: (item: any) => item.summary.avgHintsPerRun,
      higherIsBetter: true,
    },
    {
      name: 'Conversion Rate (%)',
      getValue: (item: any) => item.summary.avgConversionRate,
      higherIsBetter: true,
    },
  ];
}

/**
 * Metric definitions for inline-benchmark.ts approach comparison
 */
export function buildInlineApproachMetrics(): TableMetric<any>[] {
  return [
    {
      name: 'Avg Latency (ms)',
      getValue: (s: any) => formatNumber(s.avgLatency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P50 Latency (ms)',
      getValue: (s: any) => formatNumber(s.p50Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P95 Latency (ms)',
      getValue: (s: any) => formatNumber(s.p95Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Output Tokens',
      getValue: (s: any) => formatNumber(s.avgOutputTokens, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Cost ($)',
      getValue: (s: any) =>
        formatNumber(s.avgCost, { type: 'fixed', decimals: 6 }),
      higherIsBetter: false,
    },
    {
      name: 'Success Rate (%)',
      getValue: (s: any) =>
        formatNumber(s.parseSuccessRate, {
          type: 'fixed',
          decimals: 1,
        }) + '%',
      higherIsBetter: true,
    },
    {
      name: 'Avg Completions',
      getValue: (s: any) =>
        formatNumber(s.avgCompletions, {
          type: 'fixed',
          decimals: 2,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Avg Quality Score',
      getValue: (s: any) =>
        formatNumber(s.avgScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Max Quality Score',
      getValue: (s: any) =>
        formatNumber(s.maxScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
  ];
}

/**
 * Metric definitions for inline-benchmark.ts model comparison
 */
export function buildInlineModelMetrics(): TableMetric<any>[] {
  return [
    {
      name: 'Avg Latency (ms)',
      getValue: (item: any) =>
        formatNumber(item.summary.avgLatency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P50 Latency (ms)',
      getValue: (item: any) =>
        formatNumber(item.summary.p50Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P95 Latency (ms)',
      getValue: (item: any) =>
        formatNumber(item.summary.p95Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Output Tokens',
      getValue: (item: any) =>
        formatNumber(item.summary.avgOutputTokens, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Cost ($)',
      getValue: (item: any) =>
        formatNumber(item.summary.avgCost, {
          type: 'fixed',
          decimals: 6,
        }),
      higherIsBetter: false,
    },
    {
      name: 'Success Rate (%)',
      getValue: (item: any) =>
        formatNumber(item.summary.parseSuccessRate, {
          type: 'fixed',
          decimals: 1,
        }) + '%',
      higherIsBetter: true,
    },
    {
      name: 'Avg Completions',
      getValue: (item: any) =>
        formatNumber(item.summary.avgCompletions, {
          type: 'fixed',
          decimals: 2,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Avg Quality Score',
      getValue: (item: any) =>
        formatNumber(item.summary.avgScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Max Quality Score',
      getValue: (item: any) =>
        formatNumber(item.summary.maxScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
  ];
}
