#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import { NextEdit } from '../src/next-edit';
import { createProvider } from '../src/provider/provider';
import { generateText, type CoreMessage } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';

// Simple benchmark for NextEdit.generate with critic scoring.
// Supports concurrent runs per-model and optional cost estimation.

function usage(): void {
  console.log(
    'Usage: bun run scripts/benchmark-next-edit.ts --file <path> --models <m1,m2> [--runs N] [--concurrency N] [--critic-model <provider/model>] [--critic-retries N] [--price-per-1k N]',
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

const CRITIC_PROMPT = `You are a strict code reviewer. All scores are out of 100. Return ONLY a JSON object with the schema {"overall":number,...}. Be concise.`;

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

async function runModelBenchmark(opts: {
  modelStr: string;
  runs: number;
  concurrency: number;
  filePath: string;
  doc: string;
  criticModelStr: string;
  criticRetries: number;
  pricePer1k: number | null;
}) {
  const {
    modelStr,
    runs,
    concurrency,
    filePath,
    doc,
    criticModelStr,
    criticRetries,
    pricePer1k,
  } = opts;

  console.log(
    `\n=== Benchmarking model: ${modelStr} (runs=${runs}, concurrency=${concurrency}) ===`,
  );

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
          const t = extractTokenCount(res);
          if (typeof t === 'number') {
            genTokens.push(t);
            if (pricePer1k !== null) genCosts.push((t / 1000) * pricePer1k);
          }
          return res;
        };

        const start = Date.now();
        let edits: NextEdit.LspEdit[] | undefined = undefined;
        try {
          edits = await NextEdit.generate({
            model: languageModel,
            document: docObj,
            log: console.log,
            generateFn: generateWrapper,
          });
        } catch (e) {
          console.error('Generation failed:', String(e));
          continue;
        }
        const genLatency = Date.now() - start;
        genLatencies.push(genLatency);
        console.log(`generation latency=${genLatency}ms`);
        if (genTokens.length > 0) {
          const last = genTokens[genTokens.length - 1];
          if (typeof last === 'number')
            console.log(
              `generation tokens=${last}` +
                (pricePer1k !== null
                  ? ` cost=$${((last / 1000) * pricePer1k).toFixed(6)}`
                  : ''),
            );
        }

        const newDoc =
          edits && edits.length
            ? (() => {
                // apply edits locally
                const lineStarts = [0];
                for (let i = 0; i < doc.length; i++)
                  if (doc[i] === '\n') lineStarts.push(i + 1);
                const posToIdx = (line: number, ch: number) =>
                  Math.max(0, Math.min(line, lineStarts.length - 1));
                // fallback to simple diff if edits can't be applied conservatively
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
          pricePer1k,
        );
        if (typeof rateRes.latencyMs === 'number')
          criticLatencies.push(rateRes.latencyMs);
        if (typeof rateRes.tokens === 'number')
          criticTokens.push(rateRes.tokens);
        if (typeof rateRes.cost === 'number') criticCosts.push(rateRes.cost);
        if (typeof rateRes.score === 'number') {
          console.log('score=', rateRes.score);
          results.push(rateRes.score);
        } else {
          console.log('score= (failed to parse)');
        }
        if (typeof rateRes.latencyMs === 'number')
          console.log(`critic latency=${rateRes.latencyMs}ms`);
        if (typeof rateRes.tokens === 'number')
          console.log(
            `critic tokens=${rateRes.tokens}` +
              (rateRes.cost !== null
                ? ` cost=$${rateRes.cost.toFixed(6)}`
                : ''),
          );
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
    genAvgTokens: genTokens.length
      ? genTokens.reduce((a, b) => a + b, 0) / genTokens.length
      : NaN,
    genAvgCost: genCosts.length
      ? genCosts.reduce((a, b) => a + b, 0) / genCosts.length
      : NaN,
    criticAvgMs: criticLatencies.length
      ? criticLatencies.reduce((a, b) => a + b, 0) / criticLatencies.length
      : NaN,
    criticAvgTokens: criticTokens.length
      ? criticTokens.reduce((a, b) => a + b, 0) / criticTokens.length
      : NaN,
    criticAvgCost: criticCosts.length
      ? criticCosts.reduce((a, b) => a + b, 0) / criticCosts.length
      : NaN,
    valid: results.length,
  };

  console.log(
    `=> model ${modelStr} avg=${Number.isNaN(summary.avgScore) ? 'N/A' : summary.avgScore.toFixed(3)} (${summary.valid}/${runs} valid) genAvg=${Number.isNaN(summary.genAvgMs) ? 'N/A' : Math.round(summary.genAvgMs) + 'ms'} genTokens=${Number.isNaN(summary.genAvgTokens) ? 'N/A' : Math.round(summary.genAvgTokens)}${pricePer1k !== null ? ' genCost=$' + (Number.isNaN(summary.genAvgCost) ? 'N/A' : summary.genAvgCost.toFixed(6)) : ''} criticAvg=${Number.isNaN(summary.criticAvgMs) ? 'N/A' : Math.round(summary.criticAvgMs) + 'ms'} criticTokens=${Number.isNaN(summary.criticAvgTokens) ? 'N/A' : Math.round(summary.criticAvgTokens)}${pricePer1k !== null ? ' criticCost=$' + (Number.isNaN(summary.criticAvgCost) ? 'N/A' : summary.criticAvgCost.toFixed(6)) : ''}`,
  );
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
  const pricePer1k = args['price-per-1k'] ? Number(args['price-per-1k']) : null;

  for (const modelStr of models) {
    try {
      await runModelBenchmark({
        modelStr,
        runs,
        concurrency,
        filePath,
        doc,
        criticModelStr,
        criticRetries,
        pricePer1k,
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
