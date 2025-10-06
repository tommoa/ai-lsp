#!/usr/bin/env bun
// TODO: Extract out completion and improve prompt.
import {
  createConnection,
  CompletionItem,
  CompletionItemKind,
  ProposedFeatures,
  type TextDocumentPositionParams,
  type InitializeParams,
  type InitializeResult,
  type InitializedParams,
} from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { generateText, LanguageModel } from 'ai';
import {
  createProvider,
  ProviderInitOptions,
  type ModelSelector,
} from './provider';

// Selected provider selector (resolves model id to a concrete model
// representation for `generateText`). Can be replaced during init.
let provider: ModelSelector = (model: string) => model as any;
let SELECTED_MODEL: string | undefined = undefined;

interface CompletionData {
  index: number;
  text: string;
  model: string;
}

const MAX_CONTEXT = 32_000;
const SUGGESTION_COUNT = 5;

const languageFenceMap: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  markdown: 'md',
  html: 'html',
  shell: 'bash',
  plaintext: 'text',
};

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
documents.listen(connection);

function logInfo(msg: string) {
  connection.console.log(msg);
}
function logError(msg: string) {
  connection.console.error(msg);
}

const notify = (level: 'info' | 'warn' | 'error', message: string) => {
  switch (level) {
    case 'info':
      connection.window.showInformationMessage(message);
      break;
    case 'warn':
      connection.window.showWarningMessage(message);
      break;
    case 'error':
      connection.window.showErrorMessage(message);
      break;
  }
};

// Helper: generate a cursor token reasonably guaranteed to avoid
// collisions with surrounding content.
function makeCursorToken(before: string, after: string): string {
  const gen = () => {
    try {
      // bun/node: crypto.randomUUID available in modern runtimes

      if (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
        return (crypto as any).randomUUID();
    } catch (_) {
      // fallthrough
    }
    return Math.random().toString(36).slice(2, 12);
  };

  for (let i = 0; i < 10; i++) {
    const token = `__CURSOR_${gen()}__`;
    if (!before.includes(token) && !after.includes(token)) return token;
  }
  return `__CURSORESCAPED__${gen()}`;
}

function truncateContext(
  before: string,
  after: string,
  maxContext = MAX_CONTEXT,
) {
  const half = Math.floor(maxContext / 2);
  const beforeContext = before.length > half ? before.slice(-half) : before;
  const afterContext =
    after.length > maxContext - half
      ? after.slice(0, maxContext - half)
      : after;
  return {
    beforeContext,
    afterContext,
    truncatedLeft: before.length > beforeContext.length,
    truncatedRight: after.length > afterContext.length,
  };
}

function buildPrompt(
  instruction: string,
  combined: string,
  token: string,
  fenceLang: string,
  truncatedLeft: boolean,
  truncatedRight: boolean,
) {
  let full = `${instruction}\n\n`;
  if (truncatedLeft) full += '[...content before cursor truncated...]\n';
  if (truncatedRight) full += '[...content after cursor truncated...]\n';

  full +=
    'File content (cursor marked by token):\n```' +
    fenceLang +
    '\n' +
    combined +
    '\n```\n';
  full +=
    '\nCursor token: ' +
    token +
    ' (preserve any whitespace immediately following this token)';

  return (
    'Generate ' +
    SUGGESTION_COUNT +
    ' completion suggestions based on the following context:\n\n' +
    full +
    '\n\nReturn only the suggestions, one per line,' +
    ' without numbering or extra text.'
  );
}

function parseCompletions(text: string) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, SUGGESTION_COUNT);
}

async function callModel(prompt: string): Promise<string> {
  const t0 = Date.now();
  try {
    const tCallStart = Date.now();
    const { text } = await generateText({ model: SELECTED_MODEL!, prompt });
    const tAfterCall = Date.now();
    logInfo(
      `callModel timings (ms): generateText=${tAfterCall - tCallStart} ` +
        `total=${tAfterCall - t0}`,
    );
    return text;
  } catch (err) {
    const tErr = Date.now();
    logError(`callModel error after ${tErr - t0}ms: ${String(err)}`);
    throw err;
  }
}

async function getInlineCompletions(
  instruction: string,
  beforeText = '',
  afterText = '',
  languageId = 'text',
): Promise<string[]> {
  logInfo(`getAICompletions called with instruction: "${instruction}"`);
  logInfo(`Using model: ${SELECTED_MODEL}`);

  const tStart = Date.now();
  const tTruncStart = Date.now();
  const { beforeContext, afterContext, truncatedLeft, truncatedRight } =
    truncateContext(beforeText, afterText);
  const tTruncEnd = Date.now();

  const fenceLang =
    (languageId && languageFenceMap[languageId]) ||
    (languageId && languageId.length > 0 ? languageId : 'text');

  const tTokenStart = Date.now();
  const token = makeCursorToken(beforeContext, afterContext);
  const tTokenEnd = Date.now();

  const combined = beforeContext + token + afterContext;

  const tBuildStart = Date.now();
  const requestPrompt = buildPrompt(
    instruction,
    combined,
    token,
    fenceLang,
    truncatedLeft,
    truncatedRight,
  );
  const tBuildEnd = Date.now();

  logInfo(`Final prompt length: ${requestPrompt.length} characters`);

  try {
    const tModelStart = Date.now();
    const text = await callModel(requestPrompt);
    const tModelEnd = Date.now();

    logInfo(`AI response received: ${text.substring(0, 200)}...`);

    const tParseStart = Date.now();
    const completions = parseCompletions(text);
    const tParseEnd = Date.now();

    const tEnd = Date.now();
    logInfo(
      `getAICompletions timings (ms): total=${tEnd - tStart} ` +
        `truncate=${tTruncEnd - tTruncStart} token=${tTokenEnd - tTokenStart}` +
        ` build=${tBuildEnd - tBuildStart} model=${tModelEnd - tModelStart} ` +
        `parse=${tParseEnd - tParseStart}`,
    );

    logInfo(`Parsed ${completions.length} completions`);
    return completions;
  } catch (err) {
    logError(`AI completion error: ${String(err)}`);
    return [];
  }
}

type ProviderInitResult = {
  provider: ModelSelector;
  providerId: string;
  model: LanguageModel;
  modelId: string;
};

async function initProvider(
  initOpts: Record<string, any>,
  notify: (level: 'info' | 'warn' | 'error', message: string) => void,
): Promise<ProviderInitResult> {
  const providers =
    (initOpts.providers as Record<string, ProviderInitOptions>) || undefined;
  const model = (initOpts.model as string) || undefined;

  if (model === undefined) {
    throw new Error(
      'No model defined. Please define `model` in `initializationOptions`',
    );
  }

  const parts = model.split('/', 2).filter(Boolean);
  if (parts.length < 2)
    throw new Error('Invalid model identifier. Did you include the provider?');

  const provider = parts[0]!;
  const selectedModel = parts[1]!;

  const p = await createProvider({ provider, notify, providers });

  try {
    const instantiatedModel = p(selectedModel);
    return {
      provider: p,
      providerId: provider,
      model: instantiatedModel,
      modelId: selectedModel,
    };
  } catch (err) {
    logError(`Could not instantiate model ${selectedModel}: ${String(err)}`);
    throw err;
  }
}

connection.onInitialize(async (params: InitializeParams) => {
  logInfo('LSP Server initializing...');
  const initOpts = (params.initializationOptions || {}) as Record<string, any>;

  const result = await (async () => {
    try {
      const res = await initProvider(initOpts, notify);
      provider = res.provider;
      SELECTED_MODEL = res.modelId;
      logInfo('Provider initialized. model=' + SELECTED_MODEL);
    } catch (err) {
      logError(`Provider init failed: ${String(err)}`);
      throw err;
    }

    const r: InitializeResult = {
      capabilities: {
        completionProvider: { resolveProvider: true },
      },
    };
    return r;
  })();

  return result;
});

connection.onInitialized((_params: InitializedParams) => {
  logInfo('LSP Server initialized successfully');
  logInfo(`Using AI model: ${SELECTED_MODEL}`);

  connection.onDidChangeConfiguration(async change => {
    try {
      const config = (change.settings || {}) as Record<string, any>;
      const res = await initProvider(config, notify);
      provider = res.provider;
      SELECTED_MODEL = res.modelId;
      logInfo('Provider initialized. model=' + SELECTED_MODEL);
    } catch (err) {
      logError('Error handling configuration change: ' + String(err));
    }
  });
});

connection.onCompletion(
  async (pos: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    logInfo('onCompletion called');

    const doc = documents.get(pos.textDocument.uri);
    const docText = doc ? doc.getText() : undefined;
    const languageId = doc ? (doc.languageId ?? 'text') : 'text';

    let beforeText: string | undefined;
    let afterText: string | undefined;
    if (docText && doc) {
      const offset = doc.offsetAt(pos.position);
      beforeText = docText.slice(0, offset);
      afterText = docText.slice(offset);
    }

    const completions = await getInlineCompletions(
      'code completion',
      beforeText ?? '',
      afterText ?? '',
      languageId,
    );

    const items: CompletionItem[] = completions!.map((text, index) => ({
      label: text,
      kind: CompletionItemKind.Text,
      data: { index, text, model: SELECTED_MODEL } as CompletionData,
    }));

    logInfo(`Returning ${items.length} completion items`);
    if (items.length > 0)
      logInfo(`Items: ${items.map(i => i.label).join(', ')}`);
    return items;
  },
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  logInfo(`onCompletionResolve called for item: ${item.label}`);
  const data = item.data as CompletionData;
  if (data && data.model) {
    item.detail = 'AI Generated';
    item.documentation = `Generated by model: ${data.model}`;
  }
  return item;
});

connection.listen();
