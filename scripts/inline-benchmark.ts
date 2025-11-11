#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { InlineCompletion } from '../src/inline-completion';
import {
  createProvider,
  getModelCostInfo,
  parseModelString,
} from '../src/provider/provider';
import type { LanguageModel } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ModelCost } from '../src/provider/module-resolver';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';
import {
  type ParseErrorType,
  type TokenCost,
  type TestCase,
  type TableMetric,
  type NumberFormat,
  avg,
  classifyParseError,
  rateChange,
  percentile,
  calculateCost,
  runConcurrent,
  parseCommonArgs,
  parseApproachArg,
  printComparisonTable as printComparisonTableUtil,
  exportBenchmarkResults,
  shortenModelName,
  extractTokenMetricArrays,
  formatNumber,
  formatNumberString,
  buildInlineApproachMetrics,
  buildInlineModelMetrics,
} from './benchmark-utils';
import { NOOP_LOG, type TokenUsage } from '../src/util';
import { isUnsupportedPromptError } from '../src/inline-completion/errors';

// ApproachType is derived from InlineCompletion.PromptType
type ApproachType = 'chat' | 'fim';

interface BenchmarkOptions {
  testCases: string;
  models: string[];
  approaches: ApproachType[];
  runs: number;
  concurrency: number;
  preview: boolean;
  noColor: boolean;
  critic: boolean;
  criticModel: string;
  exportJson?: string;
}

function usage(): void {
  console.log(
    'Usage: bun run scripts/inline-benchmark.ts ' +
      '--test-cases <path> --models <m1,m2> ' +
      '[--approach chat|fim|all] ' +
      '[--runs N] [--concurrency N] [--preview] [--no-color] ' +
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

  let testCases: string | undefined;
  let approach = 'all';

  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i]!;
    if (arg === '--test-cases' && i + 1 < remaining.length) {
      testCases = remaining[++i]!;
    } else if (arg === '--approach' && i + 1 < remaining.length) {
      approach = remaining[++i]!;
    } else {
      usage();
    }
  }

  if (!testCases) usage();

  let approaches: ApproachType[] = [];
  try {
    const validApproaches = ['chat', 'fim'] as const;
    approaches = parseApproachArg(approach, validApproaches) as ApproachType[];
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }

  return {
    testCases: testCases!,
    models: common.models,
    approaches,
    runs: common.runs,
    concurrency: common.concurrency,
    preview: common.preview,
    noColor: common.noColor,
    critic: common.critic,
    criticModel: common.criticModel,
    exportJson: common.exportJson,
  };
}

interface RunMetrics {
  latency: number;
  tokenMetrics?: TokenUsage & TokenCost;
  parseSuccess: boolean;
  completionCount: number;
  avgCompletionLength: number;
  scores?: number[];
  maxScore?: number;
  parseErrorType: ParseErrorType;
  skipped?: boolean;
}

interface ApproachSummary {
  approach: ApproachType;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCost: number;
  avgCostWithoutCache: number;
  parseSuccessRate: number;
  avgCompletions: number;
  avgCompletionLength: number;
  avgScore: number;
  maxScore: number;
  valid: number;
  skipped?: boolean;
}

interface TestCaseResults {
  testCaseName: string;
  modelName: string;
  summaries: ApproachSummary[];
  results: Map<ApproachType, RunMetrics[]>;
}

async function generateCompletion(opts: {
  approach: ApproachType;
  model: LanguageModel;
  testCase: TestCase;
  modelName: string;
}): Promise<InlineCompletion.Result> {
  const { approach, model, testCase, modelName } = opts;

  // Create a fake document with before+after content
  // The position will be at the end of "before"
  const fullContent = testCase.before + testCase.after;

  const document = TextDocument.create(
    `test://${testCase.name}`,
    testCase.language,
    1,
    fullContent,
  );

  // Calculate position: after the "before" part
  const offset = testCase.before.length;
  const position: TextDocumentPositionParams = {
    textDocument: { uri: document.uri },
    position: document.positionAt(offset),
  };

  // Map approach directly to PromptType (same string values)
  const promptType =
    approach === 'fim'
      ? InlineCompletion.PromptType.FIM
      : InlineCompletion.PromptType.Chat;

  return await InlineCompletion.generate({
    model,
    document,
    position,
    log: NOOP_LOG,
    prompt: promptType,
    modelName: approach === 'fim' ? modelName : undefined,
  });
}

async function runSingleBenchmark(opts: {
  approach: ApproachType;
  testCase: TestCase;
  runNum: number;
  totalRuns: number;
  languageModel: LanguageModel;
  modelCost: ModelCost | undefined;
  preview: boolean;
  critic: boolean;
  criticModel: string;
  modelName: string;
}): Promise<RunMetrics> {
  const {
    approach,
    testCase,
    runNum,
    totalRuns,
    languageModel,
    modelCost,
    preview,
    critic,
    criticModel,
    modelName,
  } = opts;

  console.log(`${approach} [${testCase.name}] run ${runNum}/${totalRuns}...`);

  const start = Date.now();
  let parseErrorType: ParseErrorType = 'none';

  try {
    const result = await generateCompletion({
      approach,
      model: languageModel,
      testCase,
      modelName,
    });

    const completions = result.completions ?? [];
    const tokenUsage = result.tokenUsage;

    const latency = Date.now() - start;
    const completionCount = completions.length;
    const avgLength =
      completionCount > 0
        ? completions.reduce((sum, c) => sum + c.text.length, 0) /
          completionCount
        : 0;

    console.log(
      `${approach} [${testCase.name}] latency=${latency}ms ` +
        `completions=${completionCount}`,
    );

    // Calculate cost from token usage
    const cost = tokenUsage ? calculateCost(tokenUsage, modelCost) : null;
    const metrics = tokenUsage && cost ? { ...tokenUsage, ...cost } : undefined;
    if (metrics) {
      const { input, output, cost } = metrics;
      console.log(
        `${approach} tokens=input:${input} output:${output} ` +
          `cost=$${cost.toFixed(6)}`,
      );
    }

    if (preview && completions.length > 0) {
      const previewText = completions
        .slice(0, 3)
        .map((c, i) => `  [${i + 1}] "${c.text}" (${c.reason})`)
        .join('\n');
      console.log(`Completions:\n${previewText}`);
    }

    let scores: number[] = [];
    let maxScore: number | undefined;
    if (critic && completions.length > 0) {
      for (let i = 0; i < completions.length; i++) {
        const completion = completions[i]!;
        const resultCode = testCase.before + completion.text + testCase.after;
        const rateRes = await rateChange(
          resultCode,
          `${testCase.name}.${testCase.language}`,
          criticModel,
        );
        if (typeof rateRes === 'number') {
          scores.push(rateRes);
        }
      }
      if (scores.length > 0) {
        maxScore = Math.max(...scores);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        console.log(
          `${approach} [${testCase.name}] ` +
            `maxScore=${maxScore} avgScore=${avgScore.toFixed(1)}`,
        );
      }
    }

    return {
      latency,
      tokenMetrics: metrics,
      parseSuccess: true,
      completionCount,
      avgCompletionLength: avgLength,
      scores: scores.length > 0 ? scores : undefined,
      maxScore,
      parseErrorType,
    };
  } catch (e) {
    // Skip if approach is not supported
    if (isUnsupportedPromptError(e)) {
      console.log(
        `${approach} [${testCase.name}] SKIPPED: ` +
          `Approach '${approach}' not supported by this model`,
      );
      return {
        latency: 0,
        parseSuccess: false,
        completionCount: 0,
        avgCompletionLength: 0,
        parseErrorType: 'none',
        skipped: true,
      };
    }

    parseErrorType = classifyParseError(e);
    console.error(
      `${approach} [${testCase.name}] generation failed ` +
        `(${parseErrorType}): ${String(e)}`,
    );
    return {
      latency: 0,
      parseSuccess: false,
      completionCount: 0,
      avgCompletionLength: 0,
      parseErrorType,
    };
  }
}

async function runApproachBenchmark(opts: {
  approach: ApproachType;
  modelStr: string;
  testCases: TestCase[];
  runs: number;
  concurrency: number;
  modelCost: ModelCost | undefined;
  preview: boolean;
  critic: boolean;
  criticModel: string;
}): Promise<RunMetrics[]> {
  const {
    approach,
    modelStr,
    testCases,
    runs,
    concurrency,
    modelCost,
    preview,
    critic,
    criticModel,
  } = opts;

  console.log(
    `\n=== Benchmarking ${approach} ` +
      `(runs=${runs}, concurrency=${concurrency}) ===`,
  );

  const runMetrics: RunMetrics[] = [];
  const { providerId, modelName } = parseModelString(modelStr);
  const factory = await createProvider({
    provider: providerId,
    log: NOOP_LOG,
  });
  const languageModel = factory(modelName);

  await runConcurrent(runs * testCases.length, concurrency, async idx => {
    const testCaseIdx = idx % testCases.length;
    const runNum = Math.floor(idx / testCases.length) + 1;
    const currentTestCase = testCases[testCaseIdx]!;

    try {
      const metrics = await runSingleBenchmark({
        approach,
        testCase: currentTestCase,
        runNum,
        totalRuns: runs,
        languageModel,
        modelCost,
        preview,
        critic,
        criticModel,
        modelName,
      });
      runMetrics.push(metrics);
    } catch (e) {
      console.error(`${approach} run failed: ${String(e)}`);
    }
  });

  return runMetrics;
}

function computeSummary(
  runMetrics: RunMetrics[],
  approach: ApproachType,
): ApproachSummary {
  // Filter out skipped runs
  const validMetrics = runMetrics.filter(m => !m.skipped);

  // If all runs were skipped, return a summary indicating that
  if (validMetrics.length === 0) {
    return {
      approach,
      avgLatency: 0,
      p50Latency: 0,
      p95Latency: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgCost: 0,
      avgCostWithoutCache: 0,
      parseSuccessRate: 0,
      avgCompletions: 0,
      avgCompletionLength: 0,
      avgScore: 0,
      maxScore: NaN,
      valid: 0,
      skipped: true,
    };
  }

  const latencies = validMetrics.map(m => m.latency);
  const { tokensInput, tokensOutput, costs, costsWithoutCache } =
    extractTokenMetricArrays(validMetrics);
  const parseSuccesses = validMetrics.filter(m => m.parseSuccess);
  const completionCounts = validMetrics.map(m => m.completionCount);
  const completionLengths = validMetrics.map(m => m.avgCompletionLength);
  const maxScores = validMetrics
    .filter(m => m.maxScore !== undefined)
    .map(m => m.maxScore!);

  return {
    approach,
    avgLatency: avg(latencies),
    p50Latency: percentile(latencies, 50),
    p95Latency: percentile(latencies, 95),
    avgInputTokens: avg(tokensInput),
    avgOutputTokens: avg(tokensOutput),
    avgCost: avg(costs),
    avgCostWithoutCache: avg(costsWithoutCache),
    parseSuccessRate: (parseSuccesses.length / validMetrics.length) * 100,
    avgCompletions: avg(completionCounts),
    avgCompletionLength: avg(completionLengths),
    avgScore: avg(maxScores),
    maxScore: maxScores.length > 0 ? Math.max(...maxScores) : NaN,
    valid: maxScores.length,
  };
}

function printComparisonTableLocal(summaries: ApproachSummary[]): void {
  const metrics = buildInlineApproachMetrics();
  printComparisonTableUtil(summaries, s => s.approach, metrics, {
    metricColWidth: 22,
    valueColWidth: 18,
  });
}

function printModelComparisonTable(
  modelResults: Array<{ modelName: string; summary: ApproachSummary }>,
  approach: ApproachType,
): void {
  const metrics = buildInlineModelMetrics();

  const separator = '='.repeat(60);
  console.log(
    `\n${separator}\nCross-Model Comparison (${approach})\n${separator}`,
  );

  printComparisonTableUtil(modelResults, item => item.modelName, metrics, {
    metricColWidth: 22,
    valueColWidth: 18,
  });
}

function printSummary(summary: ApproachSummary): void {
  // Handle skipped approach
  if (summary.skipped) {
    console.log(
      `\n=> ${summary.approach} SKIPPED ` +
        `(approach not supported by this model)`,
    );
    return;
  }

  const avgLatencyStr = formatNumberString(
    summary.avgLatency,
    v => Math.round(v) + 'ms',
  );
  const p50LatencyStr = formatNumberString(
    summary.p50Latency,
    v => Math.round(v) + 'ms',
  );
  const p95LatencyStr = formatNumberString(
    summary.p95Latency,
    v => Math.round(v) + 'ms',
  );
  const avgInputTokensStr = formatNumberString(summary.avgInputTokens, v =>
    String(Math.round(v)),
  );
  const avgOutputTokensStr = formatNumberString(summary.avgOutputTokens, v =>
    String(Math.round(v)),
  );
  const parseSuccessRateStr = summary.parseSuccessRate.toFixed(1);
  const avgCompletionsStr = summary.avgCompletions.toFixed(2);
  const avgCompletionLengthStr = Math.round(summary.avgCompletionLength);
  const avgScoreStr = formatNumberString(summary.avgScore, v => v.toFixed(1));
  const maxScoreStr = formatNumberString(summary.maxScore, v => v.toFixed(1));

  let resultMsg =
    `\n=> ${summary.approach} avgLatency=${avgLatencyStr} ` +
    `(p50=${p50LatencyStr} p95=${p95LatencyStr}) ` +
    `genTokens=input:${avgInputTokensStr} output:${avgOutputTokensStr}`;

  const costStr = formatNumberString(summary.avgCost, v => v.toFixed(6));
  resultMsg += ` cost=$${costStr}`;

  if (costStr !== 'N/A' && !Number.isNaN(summary.avgCostWithoutCache)) {
    const costWithoutCacheStr = formatNumberString(
      summary.avgCostWithoutCache,
      v => v.toFixed(6),
    );
    resultMsg += ` uncached=$${costWithoutCacheStr}`;
  }

  resultMsg +=
    ` parseSuccess=${parseSuccessRateStr}% ` +
    `avgCompletions=${avgCompletionsStr} ` +
    `avgLength=${avgCompletionLengthStr}chars ` +
    `avgScore=${avgScoreStr} maxScore=${maxScoreStr}`;

  console.log(resultMsg);
}

function exportResultsToJson(
  allResults: TestCaseResults[],
  exportPath: string,
): void {
  const results = allResults.flatMap(tcResults =>
    tcResults.summaries.map(summary => {
      const result = tcResults.results.get(summary.approach);
      const key =
        `${tcResults.modelName}:${tcResults.testCaseName}:` +
        `${summary.approach}`;

      const latencies = result?.map(m => m.latency) ?? [];
      const { tokensInput, tokensOutput, costs } = extractTokenMetricArrays(
        result ?? [],
      );

      return {
        key,
        value: {
          modelName: tcResults.modelName,
          testCaseName: tcResults.testCaseName,
          approach: summary.approach,
          latencies,
          tokensInput,
          tokensOutput,
          costs,
          // Summary statistics
          avgLatency: summary.avgLatency,
          p50Latency: summary.p50Latency,
          p95Latency: summary.p95Latency,
          avgInputTokens: summary.avgInputTokens,
          avgOutputTokens: summary.avgOutputTokens,
          avgCost: summary.avgCost,
          parseSuccessRate: summary.parseSuccessRate,
          avgCompletions: summary.avgCompletions,
        },
      };
    }),
  );

  exportBenchmarkResults(exportPath, results);
}

async function main(): Promise<void> {
  const opts = parseArgs();

  const testCasesPath = path.resolve(opts.testCases);
  if (!fs.existsSync(testCasesPath)) {
    console.error('Test cases file not found:', testCasesPath);
    process.exit(1);
  }

  const testCasesData = fs.readFileSync(testCasesPath, 'utf8');
  let testCases: TestCase[];
  try {
    testCases = JSON.parse(testCasesData);
  } catch (e) {
    console.error('Failed to parse test cases JSON:', String(e));
    process.exit(1);
  }

  if (!Array.isArray(testCases) || testCases.length === 0) {
    console.error('Test cases must be a non-empty array');
    process.exit(1);
  }

  const allResults: TestCaseResults[] = [];

  for (const modelStr of opts.models) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Model: ${modelStr}`);
    console.log(`${'='.repeat(60)}`);

    const { providerId, modelName } = parseModelString(modelStr);

    const modelCost = await getModelCostInfo(providerId, modelName);

    if (!modelCost) {
      console.warn(
        `Warning: No cost data found for ${modelStr}. ` +
          'Cost calculations will be unavailable.',
      );
    }

    const summaries: ApproachSummary[] = [];
    const resultsMap = new Map<ApproachType, RunMetrics[]>();

    for (const approach of opts.approaches) {
      try {
        const result = await runApproachBenchmark({
          approach,
          modelStr,
          testCases,
          runs: opts.runs,
          concurrency: opts.concurrency,
          modelCost,
          preview: opts.preview,
          critic: opts.critic,
          criticModel: opts.criticModel,
        });

        const summary = computeSummary(result, approach);
        summaries.push(summary);
        resultsMap.set(approach, result);

        printSummary(summary);
      } catch (e) {
        console.error(
          `Approach benchmark failed for ${approach}: ${String(e)}`,
        );
      }
    }

    // Print comparison table if we have multiple approaches
    printComparisonTableLocal(summaries);

    allResults.push({
      testCaseName: 'all',
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
          modelName: shortenModelName(mr.modelName),
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
        printModelComparisonTable(modelSummaries, approach);
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
