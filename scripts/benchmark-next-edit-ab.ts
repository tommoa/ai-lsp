#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { NextEdit } from '../src/next-edit';
import { NextEditLineNum } from '../src/next-edit-linenum';
import { createProvider } from '../src/provider/provider';
import { generateText, type CoreMessage } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';

// A/B benchmark comparing baseline (prefix/suffix) vs line-number approaches.
// Runs both methods on the same file and compares quality, latency, usage.

type ApproachType = 'baseline' | 'linenum' | 'both';

function usage(): void {
  const msg =
    'Usage: bun run scripts/benchmark-next-edit-ab.ts ' +
    '--file <path> --models <m1,m2> [--approach baseline|linenum|both] ' +
    '[--runs N] [--concurrency N] [--critic-model <provider/model>] ' +
    '[--critic-retries N] [--price-per-1k N]';
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
    else if (a === '--price-per-1k') out['price-per-1k'] = argv[++i];
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

type RateResult = {
  score: number | null;
  latencyMs: number | null;
  tokens: number | null;
  cost: number | null;
};

function extractTokenCount(res: any): number | null {
  if (!res || typeof res !== 'object') return null;
  const usage =
    res.usage ?? res?.result?.usage ?? res?.token_usage ?? res?.meta?.usage;
  if (usage) {
    const total =
      usage.total_tokens ??
      usage.totalTokens ??
      usage.total ??
      usage.tokens ??
      usage.token_count;
    if (typeof total === 'number') return total;
    const p = usage.prompt_tokens ?? usage.promptTokens ?? usage.prompt;
    const c =
      usage.completion_tokens ?? usage.completionTokens ?? usage.completion;
    if (typeof p === 'number' && typeof c === 'number') return p + c;
  }
  if (typeof res.total_tokens === 'number') return res.total_tokens;
  if (typeof res.totalTokens === 'number') return res.totalTokens;
  if (typeof res.tokens === 'number') return res.tokens;
  if (typeof res.tokenCount === 'number') return res.tokenCount;
  if (res.result && typeof res.result.total_tokens === 'number')
    return res.result.total_tokens;
  return null;
}

async function rateChange(
  diff: string,
  filePath: string,
  criticModelStr: string,
  criticRetries: number,
  pricePer1k: number | null,
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
        const messages: CoreMessage[] = [{ role: 'user', content: promptText }];
        const start = Date.now();
        const res = await generateText({
          model: criticModelObj,
          messages,
        });
        const latencyMs = Date.now() - start;
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
        const tokenCount = extractTokenCount(res);
        const cost =
          tokenCount !== null && pricePer1k !== null
            ? (tokenCount / 1000) * pricePer1k
            : null;
        if (!parsed)
          return { score: null, latencyMs, tokens: tokenCount, cost };
        if (typeof parsed.overall === 'number')
          return { score: parsed.overall, latencyMs, tokens: tokenCount, cost };
        return { score: null, latencyMs, tokens: tokenCount, cost };
      } catch (err) {
        // retry
      }
    }
  } catch (err) {
    // fallthrough
  }
  return { score: null, latencyMs: null, tokens: null, cost: null };
}

type ApproachResults = {
  scores: number[];
  genLatencies: number[];
  genTokens: number[];
  genCosts: number[];
  criticLatencies: number[];
  criticTokens: number[];
  criticCosts: number[];
  successCount: number;
};

type ApproachSummary = {
  approach: string;
  avgScore: number;
  genAvgMs: number;
  genAvgTokens: number;
  genAvgCost: number;
  criticAvgMs: number;
  criticAvgTokens: number;
  criticAvgCost: number;
  valid: number;
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
  pricePer1k: number | null;
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
    pricePer1k,
  } = opts;

  const benchMsg =
    `=== Benchmarking ${approach} ` +
    `(runs=${runs}, concurrency=${concurrency}) ===`;
  console.log(`\n${benchMsg}`);

  const results: number[] = [];
  const genLatencies: number[] = [];
  const genTokens: number[] = [];
  const genCosts: number[] = [];
  const criticLatencies: number[] = [];
  const criticTokens: number[] = [];
  const criticCosts: number[] = [];

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
          const t = extractTokenCount(res);
          if (typeof t === 'number') {
            genTokens.push(t);
            if (pricePer1k !== null) genCosts.push((t / 1000) * pricePer1k);
          }
          return res;
        };

        const start = Date.now();
        try {
          if (approach === 'baseline') {
            await NextEdit.generate({
              model: languageModel,
              document: docObj,
              log: console.log,
              generateFn: generateWrapper,
            });
          } else {
            await NextEditLineNum.generate({
              model: languageModel,
              document: docObj,
              log: console.log,
              generateFn: generateWrapper,
            });
          }
        } catch (e) {
          console.error(`${approach} generation failed:`, String(e));
          continue;
        }
        const genLatency = Date.now() - start;
        genLatencies.push(genLatency);
        console.log(`${approach} generation latency=${genLatency}ms`);
        if (genTokens.length > 0) {
          const last = genTokens[genTokens.length - 1];
          if (typeof last === 'number')
            console.log(
              `${approach} generation tokens=${last}` +
                (pricePer1k !== null
                  ? ` cost=$${((last / 1000) * pricePer1k).toFixed(6)}`
                  : ''),
            );
        }

        // For now, just record that we got edits (don't apply them)
        const newDoc = doc;
        const diff = simpleUnifiedDiff(doc, newDoc);

        const rateRes = await rateChange(
          diff,
          filePath,
          criticModelStr,
          criticRetries,
          pricePer1k,
        );
        if (typeof rateRes.latencyMs === 'number')
          criticLatencies.push(rateRes.latencyMs);
        if (typeof rateRes.tokens === 'number')
          criticTokens.push(rateRes.tokens);
        if (typeof rateRes.cost === 'number') criticCosts.push(rateRes.cost);
        if (typeof rateRes.score === 'number') {
          console.log(`${approach} score=`, rateRes.score);
          results.push(rateRes.score);
        } else {
          console.log(`${approach} score= (failed to parse)`);
        }
        if (typeof rateRes.latencyMs === 'number')
          console.log(`${approach} critic latency=${rateRes.latencyMs}ms`);
        if (typeof rateRes.tokens === 'number')
          console.log(
            `${approach} critic tokens=${rateRes.tokens}` +
              (rateRes.cost !== null
                ? ` cost=$${rateRes.cost.toFixed(6)}`
                : ''),
          );
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
    genTokens,
    genCosts,
    criticLatencies,
    criticTokens,
    criticCosts,
    successCount: results.length,
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
    genAvgTokens: results.genTokens.length
      ? results.genTokens.reduce((a, b) => a + b, 0) / results.genTokens.length
      : NaN,
    genAvgCost: results.genCosts.length
      ? results.genCosts.reduce((a, b) => a + b, 0) / results.genCosts.length
      : NaN,
    criticAvgMs: results.criticLatencies.length
      ? results.criticLatencies.reduce((a, b) => a + b, 0) /
        results.criticLatencies.length
      : NaN,
    criticAvgTokens: results.criticTokens.length
      ? results.criticTokens.reduce((a, b) => a + b, 0) /
        results.criticTokens.length
      : NaN,
    criticAvgCost: results.criticCosts.length
      ? results.criticCosts.reduce((a, b) => a + b, 0) /
        results.criticCosts.length
      : NaN,
    valid: results.successCount,
  };
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
  const pricePer1k = args['price-per-1k'] ? Number(args['price-per-1k']) : null;

  const approaches: ApproachType[] =
    approach === 'both' ? ['baseline', 'linenum'] : [approach];

  for (const modelStr of models) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Model: ${modelStr}`);
    console.log(`${'='.repeat(60)}`);

    const summaries: ApproachSummary[] = [];

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
          pricePer1k,
        });
        const summary = computeSummary(results, app);
        summaries.push(summary);

        const avgScoreStr = Number.isNaN(summary.avgScore)
          ? 'N/A'
          : summary.avgScore.toFixed(3);
        const genAvgMsStr = Number.isNaN(summary.genAvgMs)
          ? 'N/A'
          : Math.round(summary.genAvgMs) + 'ms';
        const genTokensStr = Number.isNaN(summary.genAvgTokens)
          ? 'N/A'
          : Math.round(summary.genAvgTokens);
        const criticAvgMsStr = Number.isNaN(summary.criticAvgMs)
          ? 'N/A'
          : Math.round(summary.criticAvgMs) + 'ms';
        const criticTokensStr = Number.isNaN(summary.criticAvgTokens)
          ? 'N/A'
          : Math.round(summary.criticAvgTokens);
        let resultMsg =
          `\n=> ${app} avg=${avgScoreStr} ` +
          `(${summary.valid}/${runs} valid) ` +
          `genAvg=${genAvgMsStr} ` +
          `genTokens=${genTokensStr}`;
        if (pricePer1k !== null) {
          const costStr = Number.isNaN(summary.genAvgCost)
            ? 'N/A'
            : summary.genAvgCost.toFixed(6);
          resultMsg += ` genCost=$${costStr}`;
        }
        resultMsg +=
          ` criticAvg=${criticAvgMsStr} ` + `criticTokens=${criticTokensStr}`;
        if (pricePer1k !== null) {
          const criticCostStr = Number.isNaN(summary.criticAvgCost)
            ? 'N/A'
            : summary.criticAvgCost.toFixed(6);
          resultMsg += ` criticCost=$${criticCostStr}`;
        }
        console.log(resultMsg);
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
          name: 'Gen Tokens',
          base: base.genAvgTokens,
          linenum: linenum.genAvgTokens,
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
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
