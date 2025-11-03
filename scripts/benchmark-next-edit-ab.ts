#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { NextEdit } from '../src/next-edit';
import { createProvider, getModelCostInfo } from '../src/provider/provider';
import { generateText, type ModelMessage } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ModelCost } from '../src/provider/module-resolver';

// A/B benchmark comparing baseline (prefix/suffix) vs line-number approaches.
// Costs are fetched automatically from models.dev API per model.

type ApproachType = 'baseline' | 'linenum' | 'both';

function usage(): void {
  const msg =
    'Usage: bun run scripts/benchmark-next-edit-ab.ts ' +
    '--file <path> --models <m1,m2> ' +
    '[--approach baseline|linenum|both] ' +
    '[--runs N] [--concurrency N] ' +
    '[--critic-model <provider/model>] [--critic-retries N] ' +
    '[--export-json <output-path>]';
  console.log(msg);
  process.exit(1);
}

function parseArgs(): Record<string, string | undefined> {
  const argv = process.argv.slice(2);
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--models') out.models = argv[++i];
    else if (a === '--approach') out.approach = argv[++i];
    else if (a === '--runs') out.runs = argv[++i];
    else if (a === '--concurrency') out.concurrency = argv[++i];
    else if (a === '--critic-model') out['critic-model'] = argv[++i];
    else if (a === '--critic-retries') out['critic-retries'] = argv[++i];
    else if (a === '--export-json') out['export-json'] = argv[++i];
    else usage();
  }
  return out;
}

function simpleUnifiedDiff(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const aa = al[i];
    const bb = bl[i];
    if (aa === bb) lines.push(' ' + (aa ?? ''));
    else {
      if (aa !== undefined) lines.push('-' + aa);
      if (bb !== undefined) lines.push('+' + bb);
    }
  }
  return lines.join('\n');
}

const CRITIC_PROMPT =
  'You are a strict code reviewer. All scores are ' +
  'out of 100. Return ONLY a JSON object with the schema ' +
  '{"overall":number,...}. Be concise.';

type TokenUsage = {
  input: number;
  output: number;
  reasoning?: number;
  cachedInput?: number;
};

type RateResult = {
  score: number | null;
};

type ParseErrorType =
  | 'none'
  | 'json_parse'
  | 'schema_invalid'
  | 'extraction_failed'
  | 'conversion_failed'
  | 'generation_failed';

function classifyParseError(err: unknown): ParseErrorType {
  const msg = String(err);
  if (msg.includes('JSON')) return 'json_parse';
  if (msg.includes('Invalid hint shape')) return 'schema_invalid';
  if (msg.includes('not an array')) return 'extraction_failed';
  if (msg.includes('Unsupported') || msg.includes('invalid')) {
    return 'conversion_failed';
  }
  return 'schema_invalid';
}

function extractTokenUsage(res: any): TokenUsage | null {
  if (!res || typeof res !== 'object') return null;
  const usage =
    res.usage ?? res?.result?.usage ?? res?.token_usage ?? res?.meta?.usage;
  if (usage) {
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    if (typeof input === 'number' && typeof output === 'number') {
      const result: TokenUsage = { input, output };
      if (
        typeof usage.reasoningTokens === 'number' &&
        usage.reasoningTokens > 0
      ) {
        result.reasoning = usage.reasoningTokens;
      }
      if (
        typeof usage.cachedInputTokens === 'number' &&
        usage.cachedInputTokens > 0
      ) {
        result.cachedInput = usage.cachedInputTokens;
      }
      return result;
    }
  }
  return null;
}

type CostBreakdown = {
  cost: number;
  costWithoutCache: number;
};

function calculateCost(
  tokens: TokenUsage,
  modelCost: ModelCost | undefined,
): CostBreakdown | null {
  if (!modelCost) return null;

  let totalCost = 0;
  let costWithoutCache = 0;

  // Calculate non-cached input tokens
  // tokens.input includes both cached and non-cached, so subtract cached
  const nonCachedInputTokens = tokens.cachedInput
    ? tokens.input - tokens.cachedInput
    : tokens.input;

  // Non-cached input tokens at regular rate
  const inputCost = (nonCachedInputTokens / 1_000_000) * modelCost.input;
  totalCost += inputCost;
  costWithoutCache += inputCost;

  // Regular output tokens
  const outputCost = (tokens.output / 1_000_000) * modelCost.output;
  totalCost += outputCost;
  costWithoutCache += outputCost;

  // Reasoning tokens (billed as output)
  if (tokens.reasoning) {
    const reasoningCost = (tokens.reasoning / 1_000_000) * modelCost.output;
    totalCost += reasoningCost;
    costWithoutCache += reasoningCost;
  }

  // Cached input tokens (cheaper rate if available)
  if (tokens.cachedInput) {
    // With cache: use cache_read rate if available, otherwise use input rate
    if (modelCost.cache_read) {
      totalCost += (tokens.cachedInput / 1_000_000) * modelCost.cache_read;
    } else {
      totalCost += (tokens.cachedInput / 1_000_000) * modelCost.input;
    }
    // Without cache: those cached tokens would be billed at regular input rate
    costWithoutCache += (tokens.cachedInput / 1_000_000) * modelCost.input;
  }

  return { cost: totalCost, costWithoutCache };
}

async function rateChange(
  diff: string,
  filePath: string,
  criticModelStr: string,
  criticRetries: number,
): Promise<RateResult> {
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
    const criticProviderId = String(criticModelStr.split('/')[0]);
    const criticFactory = await createProvider({
      provider: criticProviderId,
      log: console.log,
    });
    const criticModelName = criticModelStr.includes('/')
      ? criticModelStr.split('/').slice(1).join('/')
      : '';
    const criticModelObj = criticFactory(criticModelName);
    const promptText =
      CRITIC_PROMPT + '\n' + JSON.stringify(ratingPayload, null, 2);

    for (let attempt = 0; attempt < criticRetries; attempt++) {
      try {
        const messages: ModelMessage[] = [{ role: 'user', content: promptText }];
        const res = await generateText({
          model: criticModelObj,
          messages,
        });
        const criticRaw = (res as any)?.text ?? String(res ?? '');
        let parsed: any = null;
        try {
          parsed = JSON.parse(criticRaw);
        } catch (e) {
          const s = criticRaw.indexOf('{');
          const eidx = criticRaw.lastIndexOf('}');
          if (s !== -1 && eidx !== -1) {
            try {
              parsed = JSON.parse(criticRaw.slice(s, eidx + 1));
            } catch {}
          }
        }
        if (!parsed)
          return {
            score: null,
          };
        if (typeof parsed.overall === 'number')
          return {
            score: parsed.overall,
          };
        return {
          score: null,
        };
      } catch (err) {
        // retry
      }
    }
  } catch (err) {
    // fallthrough
  }
  return {
    score: null,
  };
}

type ApproachResults = {
  scores: number[];
  genLatencies: number[];
  genTokensInput: number[];
  genTokensOutput: number[];
  genTokensReasoning: number[];
  genTokensCachedInput: number[];
  genCosts: number[];
  genCostsWithoutCache: number[];
  successCount: number;
  parseSuccesses: boolean[];
  hintCounts: number[];
  validHintCounts: number[];
  parseErrorTypes: ParseErrorType[];
};

type ApproachSummary = {
  approach: string;
  avgScore: number;
  genAvgMs: number;
  genAvgInputTokens: number;
  genAvgOutputTokens: number;
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
};

type ModelSummary = {
  modelName: string;
  summaries: ApproachSummary[];
  results?: Map<string, ApproachResults>;
};

async function runApproachBenchmark(opts: {
  approach: ApproachType;
  modelStr: string;
  runs: number;
  concurrency: number;
  filePath: string;
  doc: string;
  criticModelStr: string;
  criticRetries: number;
  modelCost: ModelCost | undefined;
}): Promise<ApproachResults> {
  const {
    approach,
    modelStr,
    runs,
    concurrency,
    filePath,
    doc,
    criticModelStr,
    criticRetries,
    modelCost,
  } = opts;

  const benchMsg =
    `=== Benchmarking ${approach} ` +
    `(runs=${runs}, concurrency=${concurrency}) ===`;
  console.log(`\n${benchMsg}`);

  const results: number[] = [];
  const genLatencies: number[] = [];
  const genTokensInput: number[] = [];
  const genTokensOutput: number[] = [];
  const genTokensReasoning: number[] = [];
  const genTokensCachedInput: number[] = [];
  const genCosts: number[] = [];
  const genCostsWithoutCache: number[] = [];
  const parseSuccesses: boolean[] = [];
  const hintCounts: number[] = [];
  const validHintCounts: number[] = [];
  const parseErrorTypes: ParseErrorType[] = [];

  const providerId = String(modelStr.split('/')[0]);
  const factory = await createProvider({
    provider: providerId,
    log: console.log,
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

        // wrapper to capture tokens for generation
        const generateWrapper = async (params: any) => {
          const res = await generateText(params);
          const t = extractTokenUsage(res);
          if (t !== null) {
            genTokensInput.push(t.input);
            genTokensOutput.push(t.output);
            if (t.reasoning) genTokensReasoning.push(t.reasoning);
            if (t.cachedInput) genTokensCachedInput.push(t.cachedInput);
            const costBreakdown = calculateCost(t, modelCost);
            if (costBreakdown !== null) {
              genCosts.push(costBreakdown.cost);
              genCostsWithoutCache.push(costBreakdown.costWithoutCache);
            }
          }
          return res;
        };

        const start = Date.now();
        let parseSuccess = false;
        let parseErrorType: ParseErrorType = 'none';
        let hintCount = 0;
        let validHintCount = 0;
        let edits: any[] = [];

        try {
          const prompt =
            approach === 'baseline' ? 'prefix_suffix' : 'line_number';
          edits = await NextEdit.generate({
            model: languageModel,
            document: docObj,
            prompt,
            log: console.log,
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
          parseSuccesses.push(false);
          hintCounts.push(0);
          validHintCounts.push(0);
          parseErrorTypes.push(parseErrorType);
          continue;
        }
        const genLatency = Date.now() - start;
        parseSuccesses.push(parseSuccess);
        hintCounts.push(hintCount);
        validHintCounts.push(validHintCount);
        parseErrorTypes.push(parseErrorType);
        genLatencies.push(genLatency);
        console.log(`${approach} generation latency=${genLatency}ms`);
        if (genTokensInput.length > 0) {
          const lastInput = genTokensInput[genTokensInput.length - 1];
          const lastOutput = genTokensOutput[genTokensOutput.length - 1];
          const lastReasoning =
            genTokensReasoning.length > 0
              ? genTokensReasoning[genTokensReasoning.length - 1]
              : undefined;
          const lastCachedInput =
            genTokensCachedInput.length > 0
              ? genTokensCachedInput[genTokensCachedInput.length - 1]
              : undefined;
          const lastCost = genCosts[genCosts.length - 1];
          const lastCostWithoutCache =
            genCostsWithoutCache.length > 0
              ? genCostsWithoutCache[genCostsWithoutCache.length - 1]
              : undefined;

          let tokenMsg =
            `${approach} generation tokens=` +
            `input:${lastInput} output:${lastOutput}`;
          if (lastReasoning) tokenMsg += ` reasoning:${lastReasoning}`;
          if (lastCachedInput) tokenMsg += ` cached:${lastCachedInput}`;
          tokenMsg +=
            lastCost !== undefined
              ? ` cost=$${lastCost.toFixed(6)}`
              : ' (no cost data)';
          if (lastCostWithoutCache !== undefined && lastCost !== undefined) {
            tokenMsg += ` uncached:$${lastCostWithoutCache.toFixed(6)}`;
          }
          console.log(tokenMsg);
        }

        // For now, just record that we got edits (don't apply them)
        const newDoc = doc;
        const diff = simpleUnifiedDiff(doc, newDoc);

        const rateRes = await rateChange(
          diff,
          filePath,
          criticModelStr,
          criticRetries,
        );
        if (typeof rateRes.score === 'number') {
          console.log(`${approach} score=`, rateRes.score);
          results.push(rateRes.score);
        } else {
          console.log(`${approach} score= (failed to parse)`);
        }
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

  return {
    scores: results,
    genLatencies,
    genTokensInput,
    genTokensOutput,
    genTokensReasoning,
    genTokensCachedInput,
    genCosts,
    genCostsWithoutCache,
    successCount: results.length,
    parseSuccesses,
    hintCounts,
    validHintCounts,
    parseErrorTypes,
  };
}

function computeSummary(
  results: ApproachResults,
  approach: string,
): ApproachSummary {
  return {
    approach,
    avgScore: results.scores.length
      ? results.scores.reduce((a, b) => a + b, 0) / results.scores.length
      : NaN,
    genAvgMs: results.genLatencies.length
      ? results.genLatencies.reduce((a, b) => a + b, 0) /
        results.genLatencies.length
      : NaN,
    genAvgInputTokens: results.genTokensInput.length
      ? results.genTokensInput.reduce((a, b) => a + b, 0) /
        results.genTokensInput.length
      : NaN,
    genAvgOutputTokens: results.genTokensOutput.length
      ? results.genTokensOutput.reduce((a, b) => a + b, 0) /
        results.genTokensOutput.length
      : NaN,
    genAvgCost: results.genCosts.length
      ? results.genCosts.reduce((a, b) => a + b, 0) / results.genCosts.length
      : NaN,
    genAvgCostWithoutCache: results.genCostsWithoutCache.length
      ? results.genCostsWithoutCache.reduce((a, b) => a + b, 0) /
        results.genCostsWithoutCache.length
      : NaN,
    valid: results.successCount,
    parseSuccessRate:
      (results.parseSuccesses.filter(Boolean).length /
        results.parseSuccesses.length) *
      100,
    avgHintsPerRun: results.hintCounts.length
      ? results.hintCounts.reduce((a, b) => a + b, 0) /
        results.hintCounts.length
      : 0,
    avgValidHintsPerRun: results.validHintCounts.length
      ? results.validHintCounts.reduce((a, b) => a + b, 0) /
        results.validHintCounts.length
      : 0,
    avgConversionRate: results.hintCounts.reduce((a, b) => a + b, 0)
      ? (results.validHintCounts.reduce((a, b) => a + b, 0) /
          results.hintCounts.reduce((a, b) => a + b, 0)) *
        100
      : 0,
    parseErrorBreakdown: {
      json_parse: results.parseErrorTypes.filter(t => t === 'json_parse')
        .length,
      schema_invalid: results.parseErrorTypes.filter(
        t => t === 'schema_invalid',
      ).length,
      extraction_failed: results.parseErrorTypes.filter(
        t => t === 'extraction_failed',
      ).length,
      conversion_failed: results.parseErrorTypes.filter(
        t => t === 'conversion_failed',
      ).length,
      generation_failed: results.parseErrorTypes.filter(
        t => t === 'generation_failed',
      ).length,
    },
  };
}

function exportResultsToJson(
  allModels: ModelSummary[],
  exportPath: string,
): void {
  const exportData: Record<string, any> = {};

  for (const modelData of allModels) {
    const resultsMap = modelData.results ?? new Map();

    for (const summary of modelData.summaries) {
      const results = resultsMap.get(summary.approach);

      const key = `${modelData.modelName}:${summary.approach}`;
      exportData[key] = {
        modelName: modelData.modelName,
        approach: summary.approach,
        scores: results?.scores ?? [],
        genLatencies: results?.genLatencies ?? [],
        genTokensInput: results?.genTokensInput ?? [],
        genTokensOutput: results?.genTokensOutput ?? [],
        genCosts: results?.genCosts ?? [],
        // Summary statistics
        avgScore: summary.avgScore,
        genAvgMs: summary.genAvgMs,
        genAvgInputTokens: summary.genAvgInputTokens,
        genAvgOutputTokens: summary.genAvgOutputTokens,
        genAvgCost: summary.genAvgCost,
        valid: summary.valid,
        parseSuccessRate: summary.parseSuccessRate,
      };
    }
  }

  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`\nResults exported to: ${exportPath}`);
}

function printFinalSummary(allModels: ModelSummary[], runs: number): void {
  if (allModels.length === 0) return;

  // Calculate column widths
  let maxModelNameLen = 'Model'.length;
  for (const modelData of allModels) {
    maxModelNameLen = Math.max(maxModelNameLen, modelData.modelName.length);
  }
  const modelColWidth = maxModelNameLen + 2;

  const approachColWidth = 10;
  const scoreColWidth = 8;
  const latencyColWidth = 13;
  const costColWidth = 12;
  const successColWidth = 10;

  const totalWidth =
    modelColWidth +
    approachColWidth +
    scoreColWidth +
    latencyColWidth +
    costColWidth +
    successColWidth +
    10; // separators

  console.log(`\n${'='.repeat(totalWidth)}`);
  console.log('FINAL SUMMARY - ALL MODELS');
  console.log(`${'='.repeat(totalWidth)}`);

  const rows: string[] = [];
  rows.push(
    'Model'.padEnd(modelColWidth) +
      '| Approach'.padEnd(approachColWidth + 1) +
      '| Score'.padEnd(scoreColWidth + 1) +
      '| Gen Latency'.padEnd(latencyColWidth + 1) +
      '| Gen Cost'.padEnd(costColWidth + 1) +
      '| Success',
  );
  rows.push('-'.repeat(totalWidth));

  for (const modelData of allModels) {
    for (const summary of modelData.summaries) {
      const modelNameCol = modelData.modelName.padEnd(modelColWidth);

      const scoreStr = Number.isNaN(summary.avgScore)
        ? 'N/A'
        : summary.avgScore.toFixed(2);
      const scoreCol = scoreStr.padEnd(scoreColWidth);

      const latencyStr = Number.isNaN(summary.genAvgMs)
        ? 'N/A'
        : Math.round(summary.genAvgMs) + 'ms';
      const latencyCol = latencyStr.padEnd(latencyColWidth);

      const costStr = Number.isNaN(summary.genAvgCost)
        ? 'N/A'
        : '$' + summary.genAvgCost.toFixed(6);
      const costCol = costStr.padEnd(costColWidth);

      const successRateStr = ((summary.valid / runs) * 100).toFixed(1) + '%';
      const successCol = successRateStr.padEnd(successColWidth);

      const approachCol = summary.approach.padEnd(approachColWidth);

      const row =
        `${modelNameCol}| ${approachCol}| ${scoreCol}| ` +
        `${latencyCol}| ${costCol}| ${successCol}`;

      rows.push(row);
    }
  }

  for (const row of rows) {
    console.log(row);
  }
  console.log(`${'='.repeat(totalWidth)}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.file || !args.models) usage();
  const filePath = path.resolve(args.file as string);
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }
  const doc = fs.readFileSync(filePath, 'utf8');
  const models = (args.models as string)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const approach = (args.approach ?? 'both') as ApproachType;
  const runs = Math.max(1, Number(args.runs ?? '3'));
  const concurrency = Math.max(1, Number(args.concurrency ?? '2'));
  const criticModelStr = args['critic-model'] ?? models[0]!;
  const criticRetries = Math.max(1, Number(args['critic-retries'] ?? '1'));
  const exportJsonPath = args['export-json'];

  const approaches: ApproachType[] =
    approach === 'both' ? ['baseline', 'linenum'] : [approach];

  const allModelsSummary: ModelSummary[] = [];

  for (const modelStr of models) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Model: ${modelStr}`);
    console.log(`${'='.repeat(60)}`);

    const providerId = String(modelStr.split('/')[0]);
    const modelName = modelStr.includes('/')
      ? modelStr.split('/').slice(1).join('/')
      : '';
    const criticProviderId = String(criticModelStr.split('/')[0]);
    const criticModelName = criticModelStr.includes('/')
      ? criticModelStr.split('/').slice(1).join('/')
      : '';

    const modelCost = await getModelCostInfo(providerId, modelName);

    if (!modelCost) {
      console.warn(
        `Warning: No cost data found for ${modelStr}. ` +
          'Cost calculations will be unavailable.',
      );
    }

    const summaries: ApproachSummary[] = [];
    const resultsMap = new Map<string, ApproachResults>();

    for (const app of approaches) {
      try {
        const results = await runApproachBenchmark({
          approach: app,
          modelStr,
          runs,
          concurrency,
          filePath,
          doc,
          criticModelStr,
          criticRetries,
          modelCost,
        });
        const summary = computeSummary(results, app);
        summaries.push(summary);
        resultsMap.set(app, results);

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
        let resultMsg =
          `\n=> ${app} avg=${avgScoreStr} ` +
          `(${summary.valid}/${runs} valid) ` +
          `genAvg=${genAvgMsStr} ` +
          `genTokens=input:${genInputTokensStr} output:${genOutputTokensStr}`;
        if (!Number.isNaN(summary.genAvgCost)) {
          const costStr = summary.genAvgCost.toFixed(6);
          resultMsg += ` genCost=$${costStr}`;
          if (!Number.isNaN(summary.genAvgCostWithoutCache)) {
            const costWithoutCacheStr =
              summary.genAvgCostWithoutCache.toFixed(6);
            resultMsg += ` uncached:$${costWithoutCacheStr}`;
          }
        } else {
          resultMsg += ` genCost=N/A`;
        }

        const parseSuccessRateStr = summary.parseSuccessRate.toFixed(1);
        const avgHintsStr = summary.avgHintsPerRun.toFixed(2);
        const conversionRateStr = summary.avgConversionRate.toFixed(1);

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
      } catch (e) {
        console.error(`Approach benchmark failed for ${app}:`, String(e));
      }
    }

    // Print comparison table
    if (summaries.length > 1) {
      console.log(`\n${'='.repeat(60)}`);
      console.log('COMPARISON TABLE');
      console.log(`${'='.repeat(60)}`);
      console.log('Metric | Baseline | LineNum | Winner'.padEnd(70));
      console.log('-'.repeat(70));

      const base = summaries[0]!;
      const linenum = summaries[1]!;

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
        const linenumStr = Number.isNaN(m.linenum)
          ? 'N/A'
          : m.linenum.toFixed(2);
        let winner = '-';
        if (!Number.isNaN(m.base) && !Number.isNaN(m.linenum)) {
          const baseBetter = m.higher ? m.base > m.linenum : m.base < m.linenum;
          winner = baseBetter ? 'Baseline' : 'LineNum';
        }
        const row =
          `${m.name.padEnd(20)} | ` +
          `${baseStr.padEnd(8)} | ${linenumStr.padEnd(7)} | ${winner}`;
        console.log(row);
      }
    }

    allModelsSummary.push({
      modelName: modelStr,
      summaries,
      results: resultsMap,
    });
  }

  printFinalSummary(allModelsSummary, runs);

  if (exportJsonPath) {
    exportResultsToJson(allModelsSummary, exportJsonPath);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
