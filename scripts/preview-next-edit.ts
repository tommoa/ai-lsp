#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { NextEdit } from '../src/next-edit';
import { createProvider } from '../src/provider/provider';
import { generateText } from 'ai';
import { TextDocument } from 'vscode-languageserver-textdocument';

function usage(): void {
  console.log(
    'Usage: bun run scripts/preview-next-edit.ts --file <path> [--uri <uri>]',
  );
  console.log('[--model <provider/model>] [--context N] [--no-color]');
  console.log('( --edits-file <path> | --edits-json <json> | --stdin )');
  process.exit(1);
}

function parseArgs(): Record<string, string | undefined> {
  const argv = process.argv.slice(2);
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--uri') out.uri = argv[++i];
    else if (a === '--edits-file') out.editsFile = argv[++i];
    else if (a === '--edits-json') out.editsJson = argv[++i];
    else if (a === '--stdin') out.stdin = '1';
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--context') out.context = argv[++i];
    else if (a === '--no-color') out.noColor = '1';
    else if (a === '--rate' || a === '--critic') out.rate = '1';
    else if (a === '--critic-model') out['critic-model'] = argv[++i];
    else if (a === '--critic-retries') out['critic-retries'] = argv[++i];
    else if (a === '--run-tests') out['run-tests'] = '1';
    else usage();
  }
  return out;
}

function computeLineStarts(doc: string): number[] {
  const res = [0];
  for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') res.push(i + 1);
  return res;
}

function positionToIndex(
  lineStarts: number[],
  line: number,
  ch: number,
): number {
  const l = Math.max(0, Math.min(line, lineStarts.length - 1));
  return (lineStarts[l] ?? 0) + Math.max(0, ch);
}

function applyEdits(doc: string, edits: NextEdit.LspEdit[]): string {
  if (!edits || edits.length === 0) return doc;
  const lineStarts = computeLineStarts(doc);
  type M = { start: number; end: number; text: string };
  const mapped: M[] = edits.map(e => ({
    start: positionToIndex(
      lineStarts,
      e.range.start.line,
      e.range.start.character,
    ),
    end: positionToIndex(lineStarts, e.range.end.line, e.range.end.character),
    text: e.text,
  }));

  mapped.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < mapped.length; i++) {
    const cur = mapped[i]!;
    const prev = mapped[i - 1]!;
    if (cur.end > prev.start) {
      console.error('Overlapping edits detected; refusing to apply');
      process.exit(2);
    }
  }

  let out = doc;
  for (const m of mapped)
    out = out.slice(0, m.start) + m.text + out.slice(m.end);
  return out;
}

function colorizeUnifiedDiff(diffText: string, noColor = false): string {
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

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.file) usage();
  const filePath = path.resolve(args.file as string);
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }

  const doc = fs.readFileSync(filePath, 'utf8');
  const uri = args.uri ?? `file://${filePath}`;

  let edits: NextEdit.LspEdit[] | undefined = undefined;

  if (args['editsFile']) {
    const ef = path.resolve(args['editsFile'] as string);
    if (!fs.existsSync(ef)) {
      console.error('Edits file not found:', ef);
      process.exit(1);
    }
    const raw = fs.readFileSync(ef, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not array');
      edits = parsed as NextEdit.LspEdit[];
    } catch (e) {
      console.error('Failed to parse edits file as JSON:', String(e));
      process.exit(1);
    }
  } else if (args['editsJson']) {
    try {
      const parsed = JSON.parse(args['editsJson'] as string);
      if (!Array.isArray(parsed)) throw new Error('not array');
      edits = parsed as NextEdit.LspEdit[];
    } catch (e) {
      console.error('Failed to parse --edits-json:', String(e));
      process.exit(1);
    }
  } else if (args.stdin) {
    const stdin = fs.readFileSync(0, 'utf8');
    try {
      const parsed = JSON.parse(stdin);
      if (!Array.isArray(parsed)) throw new Error('not array');
      edits = parsed as NextEdit.LspEdit[];
    } catch (e) {
      console.error('Failed to parse JSON from stdin as edits:', String(e));
      process.exit(1);
    }
  } else {
    // generate edits from model
    const modelStr = args.model || process.env.AI_MODEL;
    if (!modelStr) {
      console.error('No model specified. Pass --model or set AI_MODEL env var');
      process.exit(1);
    }

    const logWrapper = (
      level: any,
      message: string,
      extra?: Record<string, any>,
    ) =>
      console.error(
        `[${level}]: ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`,
      );

    let factory: any;
    try {
      const providerId = String(modelStr.split('/')[0]);
      factory = await createProvider({ provider: providerId, log: logWrapper });
    } catch (e) {
      console.error('Failed to initialize provider:', String(e));
      process.exit(1);
    }

    const modelName = modelStr.includes('/')
      ? modelStr.split('/').slice(1).join('/')
      : '';
    const languageModel = factory(modelName);

    try {
      const docObj = TextDocument.create(
        uri,
        path.extname(filePath).slice(1) || 'text',
        1,
        doc,
      );

      // Provide a wrapper generateFn that captures and prints raw output,
      // then forwards to the real generateText implementation.
      const generateWrapper = async (params: any) => {
        const res = await generateText(params);
        const rawOutput = (res as any)?.text ?? JSON.stringify(res);
        console.log('\n--- LLM RAW OUTPUT ---\n');
        console.log(String(rawOutput));
        try {
          const genDir = path.resolve(process.cwd(), 'generated');
          fs.mkdirSync(genDir, { recursive: true });
          const outPath = path.join(genDir, `preview-raw-${Date.now()}.txt`);
          fs.writeFileSync(outPath, String(rawOutput), 'utf8');
        } catch {}
        return res;
      };

      edits = await NextEdit.generate({
        model: languageModel,
        document: docObj,
        log: logWrapper,
        // pass our wrapper so the next-edit internals will call it
        // instead of calling generateText directly
        // @ts-ignore permissive: generateNextEdit accepts generateFn
        generateFn: generateWrapper,
      });
    } catch (e) {
      console.error('LLM call failed:', String(e));
      process.exit(1);
    }
  }

  if (!edits || edits.length === 0) {
    console.log('(no edits returned)');
    process.exit(0);
  }

  const newDoc = applyEdits(doc, edits);

  const context = Math.max(0, Number(args.context ?? '3'));
  const noColor = Boolean(args.noColor);

  // Print unified diff with context and colorization
  let unifiedDiff = '';
  try {
    const tmpA = path.join(os.tmpdir(), `preview-a-${Date.now()}.txt`);
    const tmpB = path.join(os.tmpdir(), `preview-b-${Date.now()}.txt`);
    fs.writeFileSync(tmpA, doc, 'utf8');
    fs.writeFileSync(tmpB, newDoc, 'utf8');
    const proc = spawnSync('diff', ['-u', `-U${context}`, tmpA, tmpB], {
      encoding: 'utf8',
    });
    if (proc.error) {
      unifiedDiff =
        '\n--- DIFF (simple) ---\n' + simpleUnifiedDiff(doc, newDoc);
    } else {
      unifiedDiff = proc.stdout || proc.stderr || '';
    }
    if (unifiedDiff.trim().length === 0) unifiedDiff = '\n(no differences)\n';
    console.log(colorizeUnifiedDiff(unifiedDiff, noColor));
    try {
      fs.unlinkSync(tmpA);
    } catch {}
    try {
      fs.unlinkSync(tmpB);
    } catch {}
  } catch (e) {
    unifiedDiff = '\n--- DIFF (simple) ---\n' + simpleUnifiedDiff(doc, newDoc);
    console.log(unifiedDiff);
  }

  // Optionally run the critic (rater) for test/debug purposes only.
  if (args.rate || args.critic) {
    const criticModelStr =
      (args['critic-model'] as string) ||
      (args.model as string) ||
      'openrouter/openai/gpt-5-nano';
    const criticRetries = Math.max(1, Number(args['critic-retries'] ?? 1));
    const runTests = Boolean(args['run-tests']);

    // Gather quick automated checks
    const checks: Record<string, any> = {};

    try {
      const tsc = spawnSync('npx', ['tsc', '--noEmit'], { encoding: 'utf8' });
      checks.tsc = { code: tsc.status, stdout: tsc.stdout, stderr: tsc.stderr };
    } catch (e) {
      checks.tsc = { error: String(e) };
    }

    try {
      const eslint = spawnSync('npx', ['eslint', filePath, '--ext', '.ts'], {
        encoding: 'utf8',
      });
      checks.eslint = {
        code: eslint.status,
        stdout: eslint.stdout,
        stderr: eslint.stderr,
      };
    } catch (e) {
      checks.eslint = { error: String(e) };
    }

    if (runTests) {
      try {
        const bt = spawnSync('bun', ['test', filePath], { encoding: 'utf8' });
        checks.tests = {
          code: bt.status,
          stdout: bt.stdout,
          stderr: bt.stderr,
        };
      } catch (e) {
        checks.tests = { error: String(e) };
      }
    }

    const ratingPayload = {
      metadata: {
        language: path.extname(filePath).slice(1) || 'text',
        file: filePath,
        model_used: criticModelStr,
      },
      quickChecks: checks,
      diff: unifiedDiff,
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

      /* eslint-disable max-len */
      const CRITIC_PROMPT = `You are a strict code reviewer. Return ONLY a JSON object with the following schema:\n{\n  "overall": number,\n  "scores": {"parseConfidence":number,"tests":number,"correctness":number,"readability":number,"risk":number},\n  "confidence": number,\n  "applySafely": "auto-accept"|"human-review"|"reject",\n  "explanations": [{"kind":"correctness"|"style"|"risk"|"other","text":"..."}],\n  "suggestedFixes": ["..."]\n}\nUse the quickChecks and diff below to rate the change. Be concise. All scores are out of 100\n`;
      /* eslint-enable max-len */

      const promptText =
        CRITIC_PROMPT + '\n' + JSON.stringify(ratingPayload, null, 2);

      let criticRaw: string | null = null;
      for (let attempt = 0; attempt < criticRetries; attempt++) {
        try {
          const res = await generateText({
            model: criticModelObj,
            prompt: promptText,
          });
          criticRaw = (res as any)?.text ?? String(res ?? '');
          const genDir = path.resolve(process.cwd(), 'generated');
          try {
            fs.mkdirSync(genDir, { recursive: true });
          } catch {}
          const outPath = path.join(genDir, `critic-raw-${Date.now()}.txt`);
          fs.writeFileSync(outPath, criticRaw ?? '', 'utf8');

          let parsedCritic: any = null;
          const rawStr = criticRaw ?? '';
          try {
            parsedCritic = JSON.parse(rawStr);
          } catch (e) {
            const s = rawStr.indexOf('{');
            const eidx = rawStr.lastIndexOf('}');
            if (s !== -1 && eidx !== -1) {
              try {
                parsedCritic = JSON.parse(rawStr.slice(s, eidx + 1));
              } catch (e2) {
                parsedCritic = null;
              }
            }
          }

          if (!parsedCritic) {
            console.error(
              'Critic returned non-JSON or unparsable output. Saved raw to',
              outPath,
            );
            console.log('Raw critic output:\n', rawStr);
            break;
          }

          if (
            typeof parsedCritic.overall !== 'number' ||
            !parsedCritic.scores
          ) {
            console.error(
              'Critic JSON missing required fields. Saved raw to',
              outPath,
            );
            console.log('Parsed critic output:', parsedCritic);
            break;
          }

          console.log('\n--- CRITIC JSON ---\n');
          console.log(JSON.stringify(parsedCritic, null, 2));
          console.log('\n--- CRITIC SUMMARY ---\n');
          console.log(
            `overall=${parsedCritic.overall} ` +
              `applySafely=${parsedCritic.applySafely} ` +
              `confidence=${parsedCritic.confidence}`,
          );
          if (
            parsedCritic.explanations &&
            Array.isArray(parsedCritic.explanations)
          ) {
            for (const ex of parsedCritic.explanations.slice(0, 5))
              console.log(`- ${ex.kind}: ${ex.text}`);
          }

          break;
        } catch (err) {
          console.error('Critic call failed attempt', attempt + 1, String(err));
        }
      }
    } catch (err) {
      console.error('Failed to run critic:', String(err));
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
