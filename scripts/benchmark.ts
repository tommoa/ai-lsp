#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { NextEdit } from '../src/next-edit';
import { createProvider, getModelCostInfo } from '../src/provider/provider';
import { generateText } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ModelCost } from '../src/provider/module-resolver';
import {
  type ParseErrorType,
  extractTokenUsage,
  calculateCost,
  classifyParseError,
  simpleUnifiedDiff,
  colorizeUnifiedDiff,
  rateChange,
} from './benchmark-utils';

type ApproachType = 'prefix_suffix' | 'line_number';

interface TokenMetrics {
  input: number;
  output: number;
  reasoning?: number;
  cachedInput?: number;
  cost: number;
  costWithoutCache: number;
}

interface RunMetrics {
  parseSuccess: boolean;
  hintCount: number;
  validHintCount: number;
  parseErrorType: ParseErrorType;
  genLatency: number;
  score?: number;
  tokenMetrics?: TokenMetrics;
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
  const opts: Record<string, string | undefined> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a === '--models') opts.models = argv[++i];
    else if (a === '--approach') opts.approach = argv[++i];
    else if (a === '--runs') opts.runs = argv[++i];
    else if (a === '--concurrency') opts.concurrency = argv[++i];
    else if (a === '--preview') opts.preview = '1';
    else if (a === '--context') opts.context = argv[++i];
    else if (a === '--no-color') opts.noColor = '1';
    else if (a === '--critic') opts.critic = '1';
    else if (a === '--critic-model') opts['critic-model'] = argv[++i];
    else if (a === '--export-json') opts['export-json'] = argv[++i];
    else usage();
  }

  if (!opts.file || !opts.models) usage();

  const models = (opts.models as string)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let approaches: ApproachType[] = [];
  const approachStr = opts.approach ?? 'both';
  if (approachStr === 'both') {
    approaches = ['prefix_suffix', 'line_number'];
  } else if (approachStr === 'prefix_suffix') {
    approaches = ['prefix_suffix'];
  } else if (approachStr === 'line_number') {
    approaches = ['line_number'];
  } else {
    console.error(
      `Invalid approach: ${approachStr}. ` +
        'Must be prefix_suffix, line_number, or both.',
    );
    process.exit(1);
  }

  return {
    file: opts.file as string,
    models,
    approaches,
    runs: Math.max(1, Number(opts.runs ?? '3')),
    concurrency: Math.max(1, Number(opts.concurrency ?? '2')),
    preview: Boolean(opts.preview),
    context: Math.max(0, Number(opts.context ?? '3')),
    noColor: Boolean(opts.noColor),
    critic: Boolean(opts.critic),
    criticModel: opts['critic-model'] ?? models[0]!,
    exportJson: opts['export-json'],
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
  modelCost: ModelCost | undefined;
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
    modelCost,
    preview,
    noColor,
  } = opts;

  const benchMsg =
    `=== Benchmarking ${approach} ` +
    `(runs=${runs}, concurrency=${concurrency}) ===`;
  console.log(`\n${benchMsg}`);

  const runMetrics: RunMetrics[] = [];

  const providerId = String(modelStr.split('/')[0]);
  const factory = await createProvider({
    provider: providerId,
    log: () => {},
  }).catch(e => {
    throw e;
  });
  const modelName = modelStr.includes('/')
    ? modelStr.split('/').slice(1).join('/')
    : '';
  const languageModel = factory(modelName);

  let nextIdx = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= runs) return;

      console.log(`${approach} run ${idx + 1}/${runs}...`);

      try {
        const docObj = TextDocument.create(
          `file://${filePath}`,
          path.extname(filePath).slice(1) || 'text',
          1,
          doc,
        );

        let capturedTokenMetrics: TokenMetrics | undefined;

        // wrapper to capture tokens for generation
        const generateWrapper = async (params: any) => {
          const res = await generateText(params);
          const t = extractTokenUsage(res);
          if (t !== null) {
            const costBreakdown = calculateCost(t, modelCost);
            if (costBreakdown !== null) {
              capturedTokenMetrics = {
                input: t.input,
                output: t.output,
                reasoning: t.reasoning,
                cachedInput: t.cachedInput,
                cost: costBreakdown.cost,
                costWithoutCache: costBreakdown.costWithoutCache,
              };
            }
          }
          return res;
        };

        const start = Date.now();
        let edits: any[] = [];
        let parseSuccess = false;
        let parseErrorType: ParseErrorType = 'none';
        let hintCount = 0;
        let validHintCount = 0;

        try {
          const promptType =
            approach === 'prefix_suffix' ? 'prefix_suffix' : 'line_number';
          edits = await NextEdit.generate({
            model: languageModel,
            document: docObj,
            prompt: promptType,
            log: () => {},
            generateFn: generateWrapper,
          });
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
            tokenMetrics: capturedTokenMetrics,
          });
          continue;
        }

        const genLatency = Date.now() - start;
        console.log(`${approach} generation latency=${genLatency}ms`);

        if (capturedTokenMetrics) {
          const {
            input,
            output,
            reasoning,
            cachedInput,
            cost,
            costWithoutCache,
          } = capturedTokenMetrics;
          let tokenMsg =
            `${approach} generation tokens=` +
            `input:${input} output:${output}`;
          if (reasoning) tokenMsg += ` reasoning:${reasoning}`;
          if (cachedInput) tokenMsg += ` cached:${cachedInput}`;
          tokenMsg += ` cost=$${cost.toFixed(6)}`;
          tokenMsg += ` uncached:$${costWithoutCache.toFixed(6)}`;
          console.log(tokenMsg);
        }

        // Create diff
        const newDoc = doc; // For now, don't apply edits
        const diff = simpleUnifiedDiff(doc, newDoc);

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

        runMetrics.push({
          parseSuccess,
          hintCount,
          validHintCount,
          parseErrorType,
          genLatency,
          score,
          tokenMetrics: capturedTokenMetrics,
        });
      } catch (e) {
        console.error(`${approach} run failed:`, String(e));
      }
    }
  };

  // start workers
  const workers: Promise<void>[] = [];
  const usedConcurrency = Math.max(1, Math.min(concurrency, runs));
  for (let w = 0; w < usedConcurrency; w++) workers.push(worker());
  await Promise.all(workers);

  return runMetrics;
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function countBy<T>(arr: T[], predicate: (item: T) => boolean): number {
  return arr.filter(predicate).length;
}

function computeSummary(
  runMetrics: RunMetrics[],
  approach: ApproachType,
): ApproachSummary {
  const scores = runMetrics
    .filter(r => r.score !== undefined)
    .map(r => r.score!);
  const genLatencies = runMetrics.map(r => r.genLatency);
  const tokenMetrics = runMetrics
    .filter(r => r.tokenMetrics !== undefined)
    .map(r => r.tokenMetrics!);

  const genTokensInput = tokenMetrics.map(t => t.input);
  const genTokensOutput = tokenMetrics.map(t => t.output);
  const genTokensReasoning = tokenMetrics
    .filter(t => t.reasoning !== undefined)
    .map(t => t.reasoning!);
  const genTokensCachedInput = tokenMetrics
    .filter(t => t.cachedInput !== undefined)
    .map(t => t.cachedInput!);
  const genCosts = tokenMetrics.map(t => t.cost);
  const genCostsWithoutCache = tokenMetrics.map(t => t.costWithoutCache);

  const parseSuccesses = runMetrics.filter(r => r.parseSuccess);
  const hintCounts = runMetrics.map(r => r.hintCount);
  const validHintCounts = runMetrics.map(r => r.validHintCount);
  const parseErrorTypes = runMetrics.map(r => r.parseErrorType);

  const totalHints = sum(hintCounts);
  const totalValidHints = sum(validHintCounts);

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
      json_parse: countBy(parseErrorTypes, t => t === 'json_parse'),
      schema_invalid: countBy(parseErrorTypes, t => t === 'schema_invalid'),
      extraction_failed: countBy(
        parseErrorTypes,
        t => t === 'extraction_failed',
      ),
      conversion_failed: countBy(
        parseErrorTypes,
        t => t === 'conversion_failed',
      ),
      generation_failed: countBy(
        parseErrorTypes,
        t => t === 'generation_failed',
      ),
    },
  };
}

function printComparisonTable(
  summaries: ApproachSummary[],
  runs: number,
): void {
  if (summaries.length < 2) return;

  const metricColWidth = 22;
  const prefixColWidth = 15;
  const linenumColWidth = 14;
  const winnerColWidth = 14;
  const totalWidth =
    metricColWidth + prefixColWidth + linenumColWidth + winnerColWidth + 6;

  console.log(`\n${'='.repeat(totalWidth)}`);
  console.log('COMPARISON TABLE');
  console.log(`${'='.repeat(totalWidth)}`);

  const header =
    'Metric'.padEnd(metricColWidth) +
    '| ' +
    'prefix_suffix'.padEnd(prefixColWidth) +
    '| ' +
    'line_number'.padEnd(linenumColWidth) +
    '| ' +
    'Winner'.padEnd(winnerColWidth);
  console.log(header);
  console.log('-'.repeat(totalWidth));

  const base = summaries.find(s => s.approach === 'prefix_suffix')!;
  const linenum = summaries.find(s => s.approach === 'line_number')!;

  const metrics = [
    {
      name: 'Quality Score',
      base: base.avgScore,
      linenum: linenum.avgScore,
      higher: true,
    },
    {
      name: 'Gen Latency (ms)',
      base: base.genAvgMs,
      linenum: linenum.genAvgMs,
      higher: false,
    },
    {
      name: 'Gen Input Tokens',
      base: base.genAvgInputTokens,
      linenum: linenum.genAvgInputTokens,
      higher: false,
    },
    {
      name: 'Gen Output Tokens',
      base: base.genAvgOutputTokens,
      linenum: linenum.genAvgOutputTokens,
      higher: false,
    },
    {
      name: 'Gen Cost ($)',
      base: base.genAvgCost,
      linenum: linenum.genAvgCost,
      higher: false,
    },
    {
      name: 'Success Rate',
      base: (base.valid / runs) * 100,
      linenum: (linenum.valid / runs) * 100,
      higher: true,
    },
    {
      name: 'Parse Success Rate',
      base: base.parseSuccessRate,
      linenum: linenum.parseSuccessRate,
      higher: true,
    },
    {
      name: 'Avg Hints Per Run',
      base: base.avgHintsPerRun,
      linenum: linenum.avgHintsPerRun,
      higher: true,
    },
    {
      name: 'Conversion Rate (%)',
      base: base.avgConversionRate,
      linenum: linenum.avgConversionRate,
      higher: true,
    },
  ];

  for (const m of metrics) {
    const baseStr = Number.isNaN(m.base) ? 'N/A' : m.base.toFixed(2);
    const linenumStr = Number.isNaN(m.linenum) ? 'N/A' : m.linenum.toFixed(2);
    let winner = '-';
    if (!Number.isNaN(m.base) && !Number.isNaN(m.linenum)) {
      const baseBetter = m.higher ? m.base > m.linenum : m.base < m.linenum;
      winner = baseBetter ? 'prefix_suffix' : 'line_number';
    }
    const row =
      m.name.padEnd(metricColWidth) +
      '| ' +
      baseStr.padEnd(prefixColWidth) +
      '| ' +
      linenumStr.padEnd(linenumColWidth) +
      '| ' +
      winner.padEnd(winnerColWidth);
    console.log(row);
  }
  console.log('='.repeat(totalWidth));
}

function printSummary(summary: ApproachSummary, runs: number): void {
  const avgScoreStr = Number.isNaN(summary.avgScore)
    ? 'N/A'
    : summary.avgScore.toFixed(3);
  const genAvgMsStr = Number.isNaN(summary.genAvgMs)
    ? 'N/A'
    : Math.round(summary.genAvgMs) + 'ms';
  const genInputTokensStr = Number.isNaN(summary.genAvgInputTokens)
    ? 'N/A'
    : Math.round(summary.genAvgInputTokens);
  const genOutputTokensStr = Number.isNaN(summary.genAvgOutputTokens)
    ? 'N/A'
    : Math.round(summary.genAvgOutputTokens);
  const parseSuccessRateStr = summary.parseSuccessRate.toFixed(1);
  const avgHintsStr = summary.avgHintsPerRun.toFixed(2);
  const conversionRateStr = summary.avgConversionRate.toFixed(1);

  let resultMsg =
    `\n=> ${summary.approach} avg=${avgScoreStr} ` +
    `(${summary.valid}/${runs} valid) genAvg=${genAvgMsStr} ` +
    `genTokens=input:${genInputTokensStr} output:${genOutputTokensStr}`;

  if (!Number.isNaN(summary.genAvgCost)) {
    const costStr = summary.genAvgCost.toFixed(6);
    resultMsg += ` genCost=$${costStr}`;
    if (!Number.isNaN(summary.genAvgCostWithoutCache)) {
      const costWithoutCacheStr = summary.genAvgCostWithoutCache.toFixed(6);
      resultMsg += ` uncached:$${costWithoutCacheStr}`;
    }
  } else {
    resultMsg += ` genCost=N/A`;
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
  const exportData = Object.fromEntries(
    allResults.flatMap(modelData =>
      modelData.summaries.map(summary => {
        const runMetrics = modelData.results.get(summary.approach) ?? [];
        const tokenMetrics = runMetrics
          .filter(r => r.tokenMetrics !== undefined)
          .map(r => r.tokenMetrics!);

        const key = `${modelData.modelName}:${summary.approach}`;
        return [
          key,
          {
            modelName: modelData.modelName,
            approach: summary.approach,
            scores: runMetrics
              .filter(r => r.score !== undefined)
              .map(r => r.score!),
            genLatencies: runMetrics.map(r => r.genLatency),
            genTokensInput: tokenMetrics.map(t => t.input),
            genTokensOutput: tokenMetrics.map(t => t.output),
            genCosts: tokenMetrics.map(t => t.cost),
            // Summary statistics
            avgScore: summary.avgScore,
            genAvgMs: summary.genAvgMs,
            genAvgInputTokens: summary.genAvgInputTokens,
            genAvgOutputTokens: summary.genAvgOutputTokens,
            genAvgCost: summary.genAvgCost,
            valid: summary.valid,
            parseSuccessRate: summary.parseSuccessRate,
          },
        ];
      }),
    ),
  );

  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`\nResults exported to: ${exportPath}`);
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

    const providerId = String(modelStr.split('/')[0]);
    const modelName = modelStr.includes('/')
      ? modelStr.split('/').slice(1).join('/')
      : '';

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
          runs: opts.runs,
          concurrency: opts.concurrency,
          filePath,
          doc,
          criticModel: opts.criticModel,
          enableCritic: opts.critic,
          modelCost,
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
    printComparisonTable(summaries, opts.runs);

    allResults.push({
      modelName: modelStr,
      summaries,
      results: resultsMap,
    });
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
