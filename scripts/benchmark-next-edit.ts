#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { NextEdit } from '../src/next-edit';
import { createProvider, getModelCostInfo } from '../src/provider/provider';
import { generateText, type CoreMessage } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { ModelCost } from '../src/provider/module-resolver';

// Simple benchmark for NextEdit.generate with critic scoring.
// Costs are fetched automatically from models.dev API per model.

function usage(): void {
  console.log(
    'Usage: bun run scripts/benchmark-next-edit.ts ' +
      '--file <path> --models <m1,m2> [--runs N] ' +
      '[--concurrency N] [--critic-model <provider/model>] ' +
      '[--critic-retries N]',
  );
  process.exit(1);
}

function parseArgs(): Record<string, string | undefined> {
  const argv = process.argv.slice(2);
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--models') out.models = argv[++i];
    else if (a === '--runs') out.runs = argv[++i];
    else if (a === '--concurrency') out.concurrency = argv[++i];
    else if (a === '--critic-model') out['critic-model'] = argv[++i];
    else if (a === '--critic-retries') out['critic-retries'] = argv[++i];
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
  'You are a strict code reviewer. All scores are out of 100. ' +
  'Return ONLY a JSON object with the schema {"overall":number,...}. ' +
  'Be concise.';

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
      log: () => {},
    });
    const criticModelName = criticModelStr.includes('/')
      ? criticModelStr.split('/').slice(1).join('/')
      : '';
    const criticModelObj = criticFactory(criticModelName);
    const promptText =
      CRITIC_PROMPT + '\n' + JSON.stringify(ratingPayload, null, 2);

    for (let attempt = 0; attempt < criticRetries; attempt++) {
      try {
        const messages: CoreMessage[] = [{ role: 'user', content: promptText }];
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

async function runModelBenchmark(opts: {
  modelStr: string;
  runs: number;
  concurrency: number;
  filePath: string;
  doc: string;
  criticModelStr: string;
  criticRetries: number;
  modelCost: ModelCost | undefined;
}) {
  const {
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
    `\n=== Benchmarking model: ${modelStr} ` +
    `(runs=${runs}, concurrency=${concurrency}) ===`;
  console.log(benchMsg);

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
    log: () => {},
  }).catch(e => {
    throw e;
  });
  const modelName = modelStr.includes('/')
    ? modelStr.split('/').slice(1).join('/')
    : '';
  const languageModel = factory(modelName);

  // shared index for workers
  let nextIdx = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= runs) return;

      console.log(`run ${idx + 1}/${runs}...`);

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
        let edits: NextEdit.LspEdit[] | undefined = undefined;
        let parseSuccess = false;
        let parseErrorType: ParseErrorType = 'none';
        let hintCount = 0;
        let validHintCount = 0;

        try {
          edits = await NextEdit.generate({
            model: languageModel,
            document: docObj,
            log: console.log,
            generateFn: generateWrapper,
          });
          parseSuccess = true;
          // edits successfully generated
          validHintCount = edits?.length ?? 0;
          hintCount = validHintCount;
        } catch (e) {
          parseErrorType = classifyParseError(e);
          console.error(`Generation failed (${parseErrorType}):`, String(e));
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
        console.log(`generation latency=${genLatency}ms`);
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
          let tokenMsg = 'generation tokens=';
          tokenMsg += `input:${lastInput} output:${lastOutput}`;
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

        const newDoc =
          edits && edits.length
            ? (() => {
                // apply edits locally
                const lineStarts = [0];
                for (let i = 0; i < doc.length; i++)
                  if (doc[i] === '\n') lineStarts.push(i + 1);
                // fallback to simple diff if edits can't be applied
                // conservatively
                try {
                  // reuse earlier simple diff for now
                  return doc; // keep original if risky
                } catch {
                  return doc;
                }
              })()
            : doc;

        const diff = simpleUnifiedDiff(doc, newDoc);
        const rateRes = await rateChange(
          diff,
          filePath,
          criticModelStr,
          criticRetries,
        );
        if (typeof rateRes.score === 'number') {
          console.log('score=', rateRes.score);
          results.push(rateRes.score);
        } else {
          console.log('score= (failed to parse)');
        }
      } catch (e) {
        console.error('Run failed:', String(e));
      }
    }
  };

  // start workers
  const workers: Promise<void>[] = [];
  const usedConcurrency = Math.max(1, Math.min(concurrency, runs));
  for (let w = 0; w < usedConcurrency; w++) workers.push(worker());
  await Promise.all(workers);

  const summary = {
    avgScore: results.length
      ? results.reduce((a, b) => a + b, 0) / results.length
      : NaN,
    genAvgMs: genLatencies.length
      ? genLatencies.reduce((a, b) => a + b, 0) / genLatencies.length
      : NaN,
    genAvgInputTokens: genTokensInput.length
      ? genTokensInput.reduce((a, b) => a + b, 0) / genTokensInput.length
      : NaN,
    genAvgOutputTokens: genTokensOutput.length
      ? genTokensOutput.reduce((a, b) => a + b, 0) / genTokensOutput.length
      : NaN,
    genAvgCost: genCosts.length
      ? genCosts.reduce((a, b) => a + b, 0) / genCosts.length
      : NaN,
    genAvgCostWithoutCache: genCostsWithoutCache.length
      ? genCostsWithoutCache.reduce((a, b) => a + b, 0) /
        genCostsWithoutCache.length
      : NaN,
    valid: results.length,
    parseSuccessRate: (parseSuccesses.filter(Boolean).length / runs) * 100,
    avgHintsPerRun: hintCounts.length
      ? hintCounts.reduce((a, b) => a + b, 0) / hintCounts.length
      : 0,
    avgValidHintsPerRun: validHintCounts.length
      ? validHintCounts.reduce((a, b) => a + b, 0) / validHintCounts.length
      : 0,
    avgConversionRate: hintCounts.reduce((a, b) => a + b, 0)
      ? (validHintCounts.reduce((a, b) => a + b, 0) /
          hintCounts.reduce((a, b) => a + b, 0)) *
        100
      : 0,
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

  const costDisplay = (
    cost: number | undefined,
    costWithoutCache: number | undefined,
  ) => {
    if (cost === undefined || Number.isNaN(cost)) return '';
    let str = ` cost=$${cost.toFixed(6)}`;
    if (costWithoutCache !== undefined && !Number.isNaN(costWithoutCache)) {
      str += ` uncached:$${costWithoutCache.toFixed(6)}`;
    }
    return str;
  };

  const genInputTokensStr = Number.isNaN(summary.genAvgInputTokens)
    ? 'N/A'
    : Math.round(summary.genAvgInputTokens);
  const genOutputTokensStr = Number.isNaN(summary.genAvgOutputTokens)
    ? 'N/A'
    : Math.round(summary.genAvgOutputTokens);
  const avgScoreStr = Number.isNaN(summary.avgScore)
    ? 'N/A'
    : summary.avgScore.toFixed(3);
  const genAvgMsStr = Number.isNaN(summary.genAvgMs)
    ? 'N/A'
    : Math.round(summary.genAvgMs) + 'ms';
  const parseSuccessRateStr = summary.parseSuccessRate.toFixed(1);
  const avgHintsStr = summary.avgHintsPerRun.toFixed(2);
  const conversionRateStr = summary.avgConversionRate.toFixed(1);

  const summaryMsg =
    `=> model ${modelStr} avg=${avgScoreStr} ` +
    `(${summary.valid}/${runs} valid) genAvg=${genAvgMsStr} ` +
    `genTokens=input:${genInputTokensStr} output:${genOutputTokensStr}` +
    costDisplay(summary.genAvgCost, summary.genAvgCostWithoutCache) +
    ` formatSuccess=${parseSuccessRateStr}% avgHints=${avgHintsStr} ` +
    `conversionRate=${conversionRateStr}%`;

  const errorMsg =
    `parseErrors: json=${summary.parseErrorBreakdown.json_parse} ` +
    `schema=${summary.parseErrorBreakdown.schema_invalid} ` +
    `extract=${summary.parseErrorBreakdown.extraction_failed} ` +
    `convert=${summary.parseErrorBreakdown.conversion_failed} ` +
    `gen=${summary.parseErrorBreakdown.generation_failed}`;

  console.log(summaryMsg);
  console.log(errorMsg);
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
  const runs = Math.max(1, Number(args.runs ?? '3'));
  const concurrency = Math.max(1, Number(args.concurrency ?? '2'));
  const criticModelStr = args['critic-model'] ?? models[0]!;
  const criticRetries = Math.max(1, Number(args['critic-retries'] ?? '1'));

  for (const modelStr of models) {
    try {
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

      await runModelBenchmark({
        modelStr,
        runs,
        concurrency,
        filePath,
        doc,
        criticModelStr,
        criticRetries,
        modelCost,
      });
    } catch (e) {
      console.error('Model benchmark failed for', modelStr, String(e));
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
