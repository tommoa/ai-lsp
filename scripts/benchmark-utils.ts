import path from 'path';
import fs from 'fs';
import {
  create as createProvider,
  parseModelString,
  type Cost,
} from '../src/provider';
import { generateText, type ModelMessage } from 'ai';
import { NOOP_LOG, type TokenUsage } from '../src/util';
import { parseJSONObject } from '../src/parser';

export interface TokenCost {
  cost: number;
  costWithoutCache: number;
}

/**
 * Summary interface for benchmark.ts approach comparison
 */
export interface BenchmarkApproachSummary {
  approach: string;
  avgScore: number;
  genAvgMs: number;
  genAvgInputTokens: number;
  genAvgOutputTokens: number;
  genAvgCost: number;
  valid: number;
  parseSuccessRate: number;
  avgHintsPerRun: number;
  avgConversionRate: number;
}

/**
 * Summary interface for inline-benchmark.ts approach comparison
 */
export interface InlineApproachSummary {
  approach: string;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  avgOutputTokens: number;
  avgCost: number;
  parseSuccessRate: number;
  avgCompletions: number;
  avgScore: number;
  maxScore: number;
}

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

const CRITIC_PROMPT_DIFF =
  'You are a strict code reviewer evaluating code changes. ' +
  'Rate the quality of the CHANGES shown in the diff, not the overall file. ' +
  'All scores are out of 100. ' +
  'Return ONLY a JSON object with the schema {"overall":number,...}. ' +
  'Be concise.';

const CRITIC_PROMPT_COMPLETION =
  'You are evaluating an inline autocomplete suggestion shown as a diff. ' +
  'Lines with - are the original text being replaced. ' +
  'Lines with + show the suggested completion. ' +
  'Lines with space prefix are unchanged context. ' +
  'Evaluate: (1) syntactic correctness, (2) semantic fit with surrounding ' +
  'code, (3) whether it completes at a natural boundary (token, statement, ' +
  'or block), (4) likelihood this is what the developer intended. ' +
  'Rate only the suggestion itself, not the quality of the surrounding code. ' +
  'Score 0-100 where 80+ is good, 50-80 is acceptable, <50 is poor. ' +
  'Return ONLY JSON: {"overall": number}.';

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
  modelCost: Cost | undefined,
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
  edits: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    text: string;
  }[],
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

    // Get the prefix from the first line and suffix from the last line
    const startLine = originalLines[start.line] ?? '';
    const endLine = originalLines[end.line] ?? '';
    const before = startLine.slice(0, start.character);
    const after = endLine.slice(end.character);

    // Add the old and new content
    if (start.line === end.line) {
      // Single line edit - show old and new versions
      const deleted = startLine.slice(start.character, end.character);

      // Show the old line only if something was deleted
      if (deleted) {
        hunkLines.push('-' + startLine);
      }
      // Show the new line
      hunkLines.push('+' + before + edit.text + after);
    } else {
      // Multi-line edit
      for (let i = start.line; i <= end.line && i < originalLines.length; i++) {
        hunkLines.push('-' + originalLines[i]);
      }

      // Add the new content with prefix and suffix
      const newLines = edit.text.split('\n');

      if (newLines.length === 1) {
        // Multi-line original collapsed to single line: needs both prefix and
        // suffix
        hunkLines.push('+' + before + newLines[0] + after);
      } else {
        // First line gets the prefix
        hunkLines.push('+' + before + newLines[0]);

        // Middle lines unchanged
        for (let i = 1; i < newLines.length - 1; i++) {
          hunkLines.push('+' + newLines[i]);
        }

        // Last line gets the suffix
        hunkLines.push('+' + newLines[newLines.length - 1] + after);
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

/**
 * Format a completion as a diff showing the insertion point.
 * Returns the full file with diff markers:
 * - Lines before cursor: shown as context (space prefix)
 * - Partial line at cursor: shown as deleted (-) then added (+) with completion
 * - New lines from completion: shown as added (+)
 * - Lines after cursor: shown as context (space prefix)
 *
 * This gives the critic full file context to evaluate the completion.
 */
export function formatCompletionAsDiff(
  prefix: string,
  completion: string,
  suffix: string,
): string {
  // Handle empty completion - just return the unchanged file
  if (completion === '') {
    const fullFile = prefix + suffix;
    return fullFile
      .split('\n')
      .map(line => ' ' + line)
      .join('\n');
  }

  const prefixLines = prefix.split('\n');
  const suffixLines = suffix.split('\n');

  // The partial line is the last line of prefix (may be empty if cursor is at
  // start of line)
  const partialLine = prefixLines[prefixLines.length - 1];
  // Context lines before the cursor (all prefix lines except the last)
  const contextBefore = prefixLines.slice(0, -1);

  // The suffix remainder is the first line of suffix (continues after cursor)
  const suffixRemainder = suffixLines[0];
  // Context lines after the cursor (all suffix lines except the first)
  const contextAfter = suffixLines.slice(1);

  // Split completion into lines
  const completionLines = completion.split('\n');

  const result: string[] = [];

  // Add context before (all lines before the cursor line)
  for (const line of contextBefore) {
    result.push(' ' + line);
  }

  // Determine if this is a pure insertion (cursor at end of complete line)
  // A pure insertion is when the partial line is empty AND the completion
  // starts with content (not extending a partial line)
  const isPureInsertion = partialLine === '' && !completion.startsWith('\n');

  if (isPureInsertion) {
    // Pure insertion: completion is new lines inserted at cursor
    // First completion line + suffix remainder becomes the first new line
    if (completionLines.length === 1) {
      result.push('+' + completionLines[0] + suffixRemainder);
    } else {
      // Multiple completion lines
      result.push('+' + completionLines[0]);
      for (let i = 1; i < completionLines.length - 1; i++) {
        result.push('+' + completionLines[i]);
      }
      result.push(
        '+' + completionLines[completionLines.length - 1] + suffixRemainder,
      );
    }
  } else if (completionLines.length === 1) {
    // Single-line completion extending the partial line
    // Show old partial line as deleted, new completed line as added
    if (partialLine !== '' || suffixRemainder !== '') {
      result.push('-' + partialLine + suffixRemainder);
    }
    result.push('+' + partialLine + completion + suffixRemainder);
  } else {
    // Multi-line completion
    // The first line of completion extends the partial line
    // Subsequent lines are new
    // The last line of completion is joined with suffix remainder

    // Show the original line (partial + suffix remainder) as deleted
    if (partialLine !== '' || suffixRemainder !== '') {
      result.push('-' + partialLine + suffixRemainder);
    }

    // First completion line extends the partial line
    result.push('+' + partialLine + completionLines[0]);

    // Middle completion lines (if any)
    for (let i = 1; i < completionLines.length - 1; i++) {
      result.push('+' + completionLines[i]);
    }

    // Last completion line + suffix remainder
    result.push(
      '+' + completionLines[completionLines.length - 1] + suffixRemainder,
    );
  }

  // Add context after (all lines after the cursor line)
  for (const line of contextAfter) {
    result.push(' ' + line);
  }

  return result.join('\n');
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
  mode: 'diff' | 'completion' = 'diff',
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
    const { provider, modelName } = parseModelString(criticModelStr);
    const criticFactory = await createProvider({
      provider,
      log: NOOP_LOG,
    });
    const criticModelObj = criticFactory(modelName);
    const criticPrompt =
      mode === 'completion' ? CRITIC_PROMPT_COMPLETION : CRITIC_PROMPT_DIFF;
    const promptText = `${criticPrompt}\n${JSON.stringify(
      ratingPayload,
      null,
      2,
    )}`;

    const messages: ModelMessage[] = [{ role: 'user', content: promptText }];
    const res = await generateText({
      model: criticModelObj.model,
      messages,
    });
    const criticRaw = (res as { text?: string }).text ?? JSON.stringify(res);

    const parsed = parseJSONObject(criticRaw);
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
    (parsed.get('--critic-model') as string) ?? models[0] ?? '';

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
          : formatNumber(val, { type: 'fixed', decimals: 2 });
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
  const name = fullName.split('/').at(-1) ?? fullName;
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
  results: Record<string, unknown>,
): void {
  fs.writeFileSync(exportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nResults exported to: ${exportPath}`);
}

/**
 * Extract token metric arrays from run metrics.
 * Filters metrics with valid tokenMetrics and extracts individual arrays.
 */
export function extractTokenMetricArrays(
  runMetrics: { tokenMetrics?: TokenUsage & TokenCost }[],
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
): TableMetric<BenchmarkApproachSummary>[] {
  return [
    {
      name: 'Quality Score',
      getValue: (s: BenchmarkApproachSummary) => s.avgScore,
      higherIsBetter: true,
    },
    {
      name: 'Gen Latency (ms)',
      getValue: (s: BenchmarkApproachSummary) => s.genAvgMs,
      higherIsBetter: false,
    },
    {
      name: 'Gen Input Tokens',
      getValue: (s: BenchmarkApproachSummary) => s.genAvgInputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Output Tokens',
      getValue: (s: BenchmarkApproachSummary) => s.genAvgOutputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Cost ($)',
      getValue: (s: BenchmarkApproachSummary) => s.genAvgCost,
      higherIsBetter: false,
    },
    {
      name: 'Success Rate',
      getValue: (s: BenchmarkApproachSummary) => (s.valid / runs) * 100,
      higherIsBetter: true,
    },
    {
      name: 'Parse Success Rate',
      getValue: (s: BenchmarkApproachSummary) => s.parseSuccessRate,
      higherIsBetter: true,
    },
    {
      name: 'Avg Hints Per Run',
      getValue: (s: BenchmarkApproachSummary) => s.avgHintsPerRun,
      higherIsBetter: true,
    },
    {
      name: 'Conversion Rate (%)',
      getValue: (s: BenchmarkApproachSummary) => s.avgConversionRate,
      higherIsBetter: true,
    },
  ];
}

/**
 * Model result item for benchmark.ts model comparison
 */
export interface BenchmarkModelItem {
  modelName: string;
  summary: BenchmarkApproachSummary;
}

/**
 * Metric definitions for benchmark.ts model comparison
 */
export function buildBenchmarkModelMetrics(
  runs: number,
): TableMetric<BenchmarkModelItem>[] {
  return [
    {
      name: 'Quality Score',
      getValue: (item: BenchmarkModelItem) => item.summary.avgScore,
      higherIsBetter: true,
    },
    {
      name: 'Gen Latency (ms)',
      getValue: (item: BenchmarkModelItem) => item.summary.genAvgMs,
      higherIsBetter: false,
    },
    {
      name: 'Gen Input Tokens',
      getValue: (item: BenchmarkModelItem) => item.summary.genAvgInputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Output Tokens',
      getValue: (item: BenchmarkModelItem) => item.summary.genAvgOutputTokens,
      higherIsBetter: false,
    },
    {
      name: 'Gen Cost ($)',
      getValue: (item: BenchmarkModelItem) => item.summary.genAvgCost,
      higherIsBetter: false,
    },
    {
      name: 'Success Rate',
      getValue: (item: BenchmarkModelItem) => (item.summary.valid / runs) * 100,
      higherIsBetter: true,
    },
    {
      name: 'Parse Success Rate',
      getValue: (item: BenchmarkModelItem) => item.summary.parseSuccessRate,
      higherIsBetter: true,
    },
    {
      name: 'Avg Hints Per Run',
      getValue: (item: BenchmarkModelItem) => item.summary.avgHintsPerRun,
      higherIsBetter: true,
    },
    {
      name: 'Conversion Rate (%)',
      getValue: (item: BenchmarkModelItem) => item.summary.avgConversionRate,
      higherIsBetter: true,
    },
  ];
}

type InlineMetric = TableMetric<InlineApproachSummary>;

/**
 * Metric definitions for inline-benchmark.ts approach comparison
 */
export function buildInlineApproachMetrics(): InlineMetric[] {
  return [
    {
      name: 'Avg Latency (ms)',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.avgLatency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P50 Latency (ms)',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.p50Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P95 Latency (ms)',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.p95Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Output Tokens',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.avgOutputTokens, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Cost ($)',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.avgCost, { type: 'fixed', decimals: 6 }),
      higherIsBetter: false,
    },
    {
      name: 'Success Rate (%)',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.parseSuccessRate, {
          type: 'fixed',
          decimals: 1,
        }) + '%',
      higherIsBetter: true,
    },
    {
      name: 'Avg Completions',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.avgCompletions, {
          type: 'fixed',
          decimals: 2,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Avg Quality Score',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.avgScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Max Quality Score',
      getValue: (s: InlineApproachSummary) =>
        formatNumber(s.maxScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
  ];
}

/**
 * Model result item for inline-benchmark.ts model comparison
 */
export interface InlineModelItem {
  modelName: string;
  summary: InlineApproachSummary;
}

/**
 * Metric definitions for inline-benchmark.ts model comparison
 */
export function buildInlineModelMetrics(): TableMetric<InlineModelItem>[] {
  return [
    {
      name: 'Avg Latency (ms)',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.avgLatency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P50 Latency (ms)',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.p50Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'P95 Latency (ms)',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.p95Latency, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Output Tokens',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.avgOutputTokens, { type: 'int' }),
      higherIsBetter: false,
    },
    {
      name: 'Cost ($)',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.avgCost, {
          type: 'fixed',
          decimals: 6,
        }),
      higherIsBetter: false,
    },
    {
      name: 'Success Rate (%)',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.parseSuccessRate, {
          type: 'fixed',
          decimals: 1,
        }) + '%',
      higherIsBetter: true,
    },
    {
      name: 'Avg Completions',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.avgCompletions, {
          type: 'fixed',
          decimals: 2,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Avg Quality Score',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.avgScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
    {
      name: 'Max Quality Score',
      getValue: (item: InlineModelItem) =>
        formatNumber(item.summary.maxScore, {
          type: 'fixed',
          decimals: 1,
        }),
      higherIsBetter: true,
    },
  ];
}
