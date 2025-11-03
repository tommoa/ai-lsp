import path from 'path';
import { createProvider } from '../src/provider/provider';
import { generateText, type ModelMessage } from 'ai';
import type { ModelCost } from '../src/provider/module-resolver';

export type TokenUsage = {
  input: number;
  output: number;
  reasoning?: number;
  cachedInput?: number;
};

export type CostBreakdown = {
  cost: number;
  costWithoutCache: number;
};

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

export function extractTokenUsage(res: any): TokenUsage | null {
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

export function calculateCost(
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

export function simpleUnifiedDiff(a: string, b: string): string {
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
      if (!parsed) return null;
      if (typeof parsed.overall === 'number') return parsed.overall;
      return null;
    } catch (err) {
      // fallthrough
    }
  } catch (err) {
    // fallthrough
  }
  return null;
}
