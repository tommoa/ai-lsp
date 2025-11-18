#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { NextEdit } from '../src/next-edit';
import { Provider } from '../src/provider';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  type ParseErrorType,
  type TokenCost,
  avg,
  classifyParseError,
  createEditDiff,
  colorizeUnifiedDiff,
  rateChange,
  calculateCost,
  runConcurrent,
  parseCommonArgs,
  parseApproachArg,
  printComparisonTable as printComparisonTableUtil,
  exportBenchmarkResults,
  extractTokenMetricArrays,
  buildBenchmarkApproachMetrics,
  buildBenchmarkModelMetrics,
  formatNumber,
} from './benchmark-utils';
import { NOOP_LOG, type TokenUsage } from '../src/util';

type ApproachType = 'prefix_suffix' | 'line_number';

interface RunMetrics {
  parseSuccess: boolean;
  hintCount: number;
  validHintCount: number;
  parseErrorType: ParseErrorType;
  genLatency: number;
  score?: number;
  tokenMetrics?: TokenUsage & TokenCost;
}

interface BenchmarkOptions {
  file: string;
  models: string[];
  approaches: ApproachType[];
  runs: number;
  concurrency: number;
  preview: boolean;
  context: number;
  noColor: boolean;
  critic: boolean;
  criticModel: string;
  exportJson?: string;
}

function usage(): void {
  console.log(
    'Usage: bun run scripts/benchmark.ts --file <path> --models <m1,m2> ' +
      '[--approach prefix_suffix|line_number|both] ' +
      '[--runs N] [--concurrency N] [--preview] [--context N] [--no-color] ' +
      '[--critic] [--critic-model <provider/model>] [--export-json <path>]',
  );
  process.exit(1);
}

function parseArgs(): BenchmarkOptions {
  const argv = process.argv.slice(2);
  const { common, remaining } = parseCommonArgs(argv);

  if (common.models.length === 0) {
    usage();
  }

  let file: string | undefined;
  let context = '3';
  let approach = 'both';

  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i]!;
    if (arg === '--file' && i + 1 < remaining.length) {
      file = remaining[++i]!;
    } else if (arg === '--approach' && i + 1 < remaining.length) {
      approach = remaining[++i]!;
    } else if (arg === '--context' && i + 1 < remaining.length) {
      context = remaining[++i]!;
    } else {
      usage();
    }
  }

  if (!file) usage();

  let approaches: ApproachType[] = [];
  try {
    const validApproaches = ['prefix_suffix', 'line_number'] as const;
    const normalized = approach === 'both' ? 'all' : approach;
    approaches = parseApproachArg(
      normalized,
      validApproaches,
    ) as ApproachType[];
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }

  return {
    file: file!,
    models: common.models,
    approaches,
    runs: common.runs,
    concurrency: common.concurrency,
    preview: common.preview,
    context: Math.max(0, Number(context)),
    noColor: common.noColor,
    critic: common.critic,
    criticModel: common.criticModel,
    exportJson: common.exportJson,
  };
}

interface ApproachSummary {
  approach: ApproachType;
  avgScore: number;
  genAvgMs: number;
  genAvgInputTokens: number;
  genAvgOutputTokens: number;
  genAvgReasoningTokens: number;
  genAvgCachedInputTokens: number;
  genAvgCost: number;
  genAvgCostWithoutCache: number;
  valid: number;
  parseSuccessRate: number;
  avgHintsPerRun: number;
  avgValidHintsPerRun: number;
  avgConversionRate: number;
  parseErrorBreakdown: {
    json_parse: number;
    schema_invalid: number;
    extraction_failed: number;
    conversion_failed: number;
    generation_failed: number;
  };
}

interface ModelResults {
  modelName: string;
  summaries: ApproachSummary[];
  results: Map<ApproachType, RunMetrics[]>;
}

async function runApproachBenchmark(opts: {
  approach: ApproachType;
  modelStr: string;
  runs: number;
  concurrency: number;
  filePath: string;
  doc: string;
  criticModel: string;
  enableCritic: boolean;
  preview: boolean;
  context: number;
  noColor: boolean;
}): Promise<RunMetrics[]> {
  const {
    approach,
    modelStr,
    runs,
    concurrency,
    filePath,
    doc,
    criticModel,
    enableCritic,
    preview,
    noColor,
  } = opts;
  const benchMsg =
    `=== Benchmarking ${approach} ` +
    `(runs=${runs}, concurrency=${concurrency}) ===`;
  console.log(`\n${benchMsg}`);

  const runMetrics: RunMetrics[] = [];

  const { provider, modelName } = Provider.parseModelString(modelStr);
  const factory = await Provider.create({
    provider,
    log: NOOP_LOG,
  });
  const model = factory(modelName);

  await runConcurrent(runs, concurrency, async idx => {
    console.log(`${approach} run ${idx + 1}/${runs}...`);

    try {
      const docObj = TextDocument.create(
        `file://${filePath}`,
        path.extname(filePath).slice(1) || 'text',
        1,
        doc,
      );

      const start = Date.now();
      let edits: any[] = [];
      let parseSuccess = false;
      let parseErrorType: ParseErrorType = 'none';
      let hintCount = 0;
      let validHintCount = 0;
      let tokenUsage: TokenUsage | undefined;

      try {
        const promptType =
          approach === 'prefix_suffix'
            ? NextEdit.PromptType.PrefixSuffix
            : NextEdit.PromptType.LineNumber;
        const result = await NextEdit.generate({
          model: model.model,
          document: docObj,
          prompt: promptType,
          log: NOOP_LOG,
        });
        edits = result.edits;
        tokenUsage = result.tokenUsage;
        parseSuccess = true;
        validHintCount = edits?.length ?? 0;
        hintCount = validHintCount;
      } catch (e) {
        parseErrorType = classifyParseError(e);
        console.error(
          `${approach} generation failed (${parseErrorType}):`,
          String(e),
        );
        runMetrics.push({
          parseSuccess: false,
          hintCount: 0,
          validHintCount: 0,
          parseErrorType,
          genLatency: 0,
          tokenMetrics: undefined,
        });
        return;
      }

      const genLatency = Date.now() - start;
      console.log(`${approach} generation latency=${genLatency}ms`);

      // Calculate cost from token usage
      const cost = tokenUsage
        ? calculateCost(tokenUsage, model.info?.cost)
        : null;
      const metrics =
        tokenUsage && cost ? { ...tokenUsage, ...cost } : undefined;
      if (metrics) {
        const {
          input,
          output,
          reasoning,
          cachedInput,
          cost,
          costWithoutCache,
        } = metrics;
        let tokenMsg =
          `${approach} generation tokens=input:${input} ` + `output:${output}`;
        if (reasoning) tokenMsg += ` reasoning:${reasoning}`;
        if (cachedInput) tokenMsg += ` cachedInput:${cachedInput}`;
        tokenMsg += ` cost=$${cost.toFixed(6)}`;
        if (costWithoutCache < cost) {
          tokenMsg += ` uncached=$${costWithoutCache.toFixed(6)}`;
        }
        console.log(tokenMsg);
      }

      // Create diff
      const diff = createEditDiff(doc, edits, 3);

      // Show preview if requested
      if (preview) {
        const colorizedDiff = colorizeUnifiedDiff(diff, noColor);
        console.log(`\n${colorizedDiff}\n`);
      }

      let score: number | undefined;
      // Rate the change if critic enabled
      if (enableCritic) {
        const rateScore = await rateChange(diff, filePath, criticModel);
        if (typeof rateScore === 'number') {
          console.log(`${approach} score=`, rateScore);
          score = rateScore;
        } else {
          console.log(`${approach} score= (failed to parse)`);
        }
      }

      // count valid hints (ones that have valid edits)
      validHintCount = edits.filter(e => {
        if (e.start === undefined || e.end === undefined) return false;
        const prevChar = doc[e.start - 1] ?? '';
        const nextChar = doc[e.end] ?? '';
        return !(prevChar === ' ' && nextChar === ' ');
      }).length;

      runMetrics.push({
        parseSuccess,
        hintCount,
        validHintCount,
        parseErrorType,
        genLatency,
        score,
        tokenMetrics: metrics,
      });
    } catch (e) {
      console.error(`${approach} run failed:`, String(e));
    }
  });

  return runMetrics;
}

function computeSummary(
  runMetrics: RunMetrics[],
  approach: ApproachType,
): ApproachSummary {
  const scores = runMetrics
    .filter(r => r.score !== undefined)
    .map(r => r.score!);
  const genLatencies = runMetrics.map(r => r.genLatency);
  const {
    tokensInput: genTokensInput,
    tokensOutput: genTokensOutput,
    tokensReasoning: genTokensReasoning,
    tokensCachedInput: genTokensCachedInput,
    costs: genCosts,
    costsWithoutCache: genCostsWithoutCache,
  } = extractTokenMetricArrays(runMetrics);

  const parseSuccesses = runMetrics.filter(r => r.parseSuccess);
  const hintCounts = runMetrics.map(r => r.hintCount);
  const validHintCounts = runMetrics.map(r => r.validHintCount);
  const parseErrorTypes = runMetrics.map(r => r.parseErrorType);

  const totalHints = hintCounts.reduce((a, b) => a + b, 0);
  const totalValidHints = validHintCounts.reduce((a, b) => a + b, 0);

  return {
    approach,
    avgScore: avg(scores),
    genAvgMs: avg(genLatencies),
    genAvgInputTokens: avg(genTokensInput),
    genAvgOutputTokens: avg(genTokensOutput),
    genAvgReasoningTokens: avg(genTokensReasoning),
    genAvgCachedInputTokens: avg(genTokensCachedInput),
    genAvgCost: avg(genCosts),
    genAvgCostWithoutCache: avg(genCostsWithoutCache),
    valid: scores.length,
    parseSuccessRate: (parseSuccesses.length / runMetrics.length) * 100,
    avgHintsPerRun: avg(hintCounts),
    avgValidHintsPerRun: avg(validHintCounts),
    avgConversionRate: totalHints ? (totalValidHints / totalHints) * 100 : 0,
    parseErrorBreakdown: {
      json_parse: parseErrorTypes.filter(t => t === 'json_parse').length,
      schema_invalid: parseErrorTypes.filter(t => t === 'schema_invalid')
        .length,
      extraction_failed: parseErrorTypes.filter(t => t === 'extraction_failed')
        .length,
      conversion_failed: parseErrorTypes.filter(t => t === 'conversion_failed')
        .length,
      generation_failed: parseErrorTypes.filter(t => t === 'generation_failed')
        .length,
    },
  };
}

function printComparisonTableLocal(
  summaries: ApproachSummary[],
  runs: number,
): void {
  const metrics = buildBenchmarkApproachMetrics(runs);
  printComparisonTableUtil(summaries, s => s.approach, metrics, {
    metricColWidth: 22,
    valueColWidth: 15,
  });
}

function printModelComparisonTable(
  modelResults: Array<{ modelName: string; summary: ApproachSummary }>,
  approach: ApproachType,
  runs: number,
): void {
  const metrics = buildBenchmarkModelMetrics(runs);

  const separator = '='.repeat(60);
  console.log(
    `\n${separator}\nCross-Model Comparison (${approach})\n${separator}`,
  );

  printComparisonTableUtil(modelResults, item => item.modelName, metrics, {
    metricColWidth: 22,
    valueColWidth: 15,
  });
}

function printSummary(summary: ApproachSummary, runs: number): void {
  const avgScoreStr = formatNumber(summary.avgScore, {
    type: 'fixed',
    decimals: 3,
  });
  const genAvgMsStr = formatNumber(summary.genAvgMs, { type: 'ms' });
  const genInputTokensStr = formatNumber(summary.genAvgInputTokens, {
    type: 'round',
  });
  const genOutputTokensStr = formatNumber(summary.genAvgOutputTokens, {
    type: 'round',
  });
  const parseSuccessRateStr = summary.parseSuccessRate.toFixed(1);
  const avgHintsStr = summary.avgHintsPerRun.toFixed(2);
  const conversionRateStr = summary.avgConversionRate.toFixed(1);

  let resultMsg =
    `\n=> ${summary.approach} avg=${avgScoreStr} ` +
    `(${summary.valid}/${runs} valid) genAvg=${genAvgMsStr} ` +
    `genTokens=input:${genInputTokensStr} output:${genOutputTokensStr}`;

  const costStr = formatNumber(summary.genAvgCost, {
    type: 'fixed',
    decimals: 6,
  });
  resultMsg += ` genCost=$${costStr}`;

  if (costStr !== 'N/A' && !Number.isNaN(summary.genAvgCostWithoutCache)) {
    const costWithoutCacheStr = formatNumber(summary.genAvgCostWithoutCache, {
      type: 'fixed',
      decimals: 6,
    });
    resultMsg += ` uncached:$${costWithoutCacheStr}`;
  }

  resultMsg +=
    ` formatSuccess=${parseSuccessRateStr}% ` +
    `avgHints=${avgHintsStr} conversionRate=${conversionRateStr}%`;

  const errorMsg =
    `parseErrors: json=${summary.parseErrorBreakdown.json_parse} ` +
    `schema=${summary.parseErrorBreakdown.schema_invalid} ` +
    `extract=${summary.parseErrorBreakdown.extraction_failed} ` +
    `convert=${summary.parseErrorBreakdown.conversion_failed} ` +
    `gen=${summary.parseErrorBreakdown.generation_failed}`;

  console.log(resultMsg);
  console.log(errorMsg);
}

function exportResultsToJson(
  allResults: ModelResults[],
  exportPath: string,
): void {
  const results = allResults.flatMap(modelData =>
    modelData.summaries.map(summary => {
      const runMetrics = modelData.results.get(summary.approach) ?? [];
      const { tokensInput, tokensOutput, costs } =
        extractTokenMetricArrays(runMetrics);

      const key = `${modelData.modelName}:${summary.approach}`;
      return {
        key,
        value: {
          modelName: modelData.modelName,
          approach: summary.approach,
          scores: runMetrics
            .filter(r => r.score !== undefined)
            .map(r => r.score!),
          genLatencies: runMetrics.map(r => r.genLatency),
          genTokensInput: tokensInput,
          genTokensOutput: tokensOutput,
          genCosts: costs,
          // Summary statistics
          avgScore: summary.avgScore,
          genAvgMs: summary.genAvgMs,
          genAvgInputTokens: summary.genAvgInputTokens,
          genAvgOutputTokens: summary.genAvgOutputTokens,
          genAvgCost: summary.genAvgCost,
          valid: summary.valid,
          parseSuccessRate: summary.parseSuccessRate,
        },
      };
    }),
  );

  exportBenchmarkResults(exportPath, results);
}

async function main(): Promise<void> {
  const opts = parseArgs();

  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }

  const doc = fs.readFileSync(filePath, 'utf8');

  const allResults: ModelResults[] = [];

  for (const modelStr of opts.models) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Model: ${modelStr}`);
    console.log(`${'='.repeat(60)}`);

    const summaries: ApproachSummary[] = [];
    const resultsMap = new Map<ApproachType, RunMetrics[]>();

    for (const approach of opts.approaches) {
      try {
        const result = await runApproachBenchmark({
          approach,
          modelStr,
          runs: opts.runs,
          concurrency: opts.concurrency,
          filePath,
          doc,
          criticModel: opts.criticModel,
          enableCritic: opts.critic,
          preview: opts.preview,
          context: opts.context,
          noColor: opts.noColor,
        });

        const summary = computeSummary(result, approach);
        summaries.push(summary);
        resultsMap.set(approach, result);

        printSummary(summary, opts.runs);
      } catch (e) {
        console.error(`Approach benchmark failed for ${approach}:`, String(e));
      }
    }

    // Print comparison table if we have both approaches
    printComparisonTableLocal(summaries, opts.runs);

    allResults.push({
      modelName: modelStr,
      summaries,
      results: resultsMap,
    });
  }

  // Print cross-model comparison tables (one per approach)
  if (opts.models.length > 1) {
    for (const approach of opts.approaches) {
      const modelSummaries = allResults
        .map(mr => ({
          modelName: mr.modelName,
          summary: mr.summaries.find(s => s.approach === approach),
        }))
        .filter(
          (
            item,
          ): item is {
            modelName: string;
            summary: ApproachSummary;
          } => item.summary !== undefined,
        );

      if (modelSummaries.length > 1) {
        printModelComparisonTable(modelSummaries, approach, opts.runs);
      }
    }
  }

  // Export results if requested
  if (opts.exportJson) {
    exportResultsToJson(allResults, opts.exportJson);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
