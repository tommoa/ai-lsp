#!/usr/bin/env bun
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
import { type LanguageModel } from 'ai';
import {
  createProvider,
  ProviderInitOptions,
  type ModelSelector,
} from './provider/provider';
import { InlineCompletion } from './inline-completion';
import { NextEdit } from './next-edit';
import { Level, Log, time } from './util';

// TODO: Figure out a way to ship these aruond without needing this horrible
// top-levl functions.
// Selected provider selector (resolves model id to a concrete model
// representation for `generateText`). Can be replaced during init.
let provider: ModelSelector = (model: string) => model as any;
let SELECTED_MODEL: string | undefined = undefined;

interface CompletionData {
  index: number;
  model: string;
  reason: string;
}

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
documents.listen(connection);

const log: Log = (
  level: Level,
  message: string,
  extra?: Record<string, any>,
) => {
  const postfix = extra ? ` ${JSON.stringify(extra)}` : '';
  switch (level) {
    case 'debug':
      connection.console.debug(message + postfix);
      break;
    case 'info':
      connection.console.log(message + postfix);
      break;
    case 'warn':
      connection.console.warn(message + postfix);
      break;
    case 'error':
      connection.console.error(message + postfix);
      break;
  }
};

type ProviderInitResult = {
  factory: ModelSelector;
  provider: string;
  model: LanguageModel;
  modelId: string;
};

async function initProvider(
  initOpts: Record<string, any>,
  log: Log,
): Promise<ProviderInitResult> {
  const providers =
    (initOpts.providers as Record<string, ProviderInitOptions>) || undefined;
  const optModel = (initOpts.model as string) || undefined;

  if (optModel === undefined) {
    throw new Error(
      'No model defined. Please define `model` in `initializationOptions`',
    );
  }

  const [providerId, ...parts] = optModel.split('/').filter(Boolean);
  const modelId = parts.join('/');
  const provider = providerId!;

  log('info', `provider=${providerId}, model=${modelId}`);

  const factory = await createProvider({ provider, log: log, providers });

  try {
    return {
      factory,
      provider,
      model: factory(modelId),
      modelId,
    };
  } catch (err) {
    log('error', `Could not instantiate model ${modelId}: ${String(err)}`);
    throw err;
  }
}

connection.onInitialize(async (params: InitializeParams) => {
  log('info', 'LSP Server initializing...');
  const initOpts = (params.initializationOptions || {}) as Record<string, any>;

  const result = await (async () => {
    try {
      const res = await initProvider(initOpts, log);
      provider = res.factory;
      SELECTED_MODEL = res.modelId;
    } catch (err) {
      log('error', `Provider init failed: ${String(err)}`);
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
  log('info', 'LSP Server initialized successfully');
  log('info', `Using AI model: ${SELECTED_MODEL}`);

  connection.onDidChangeConfiguration(async change => {
    try {
      const config = (change.settings || {}) as Record<string, any>;
      const res = await initProvider(config, log);
      provider = res.factory;
      SELECTED_MODEL = res.modelId;
      log('info', 'Provider initialized. model=' + SELECTED_MODEL);
    } catch (err) {
      log('error', 'Error handling configuration change: ' + String(err));
    }
  });
});

connection.onCompletion(
  async (pos: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    using _ = time(log, 'info', 'onCompletion');

    const completions = await InlineCompletion.generate(
      provider(SELECTED_MODEL!)!,
      documents.get(pos.textDocument.uri)!,
      pos,
      5,
      log,
    );

    log('info', `Completions ${JSON.stringify(completions)}`);

    // `completions` is now an array of { text, reason } objects. Map them to
    // CompletionItems. Use the first line of the text as the label so items
    // remain concise. Put the model reason into `detail` (fall back to the
    // previous model label when reason is empty).
    const items: CompletionItem[] = (completions || [])
      .map((c, index) => {
        const text = (c as any).text ?? String(c);
        const reason = (c as any).reason ?? '';
        const label = String(text).split('\n')[0];
        return {
          label,
          kind: CompletionItemKind.Text,
          text,
          data: { index, model: SELECTED_MODEL, reason } as CompletionData,
        } as CompletionItem;
      })
      .filter(Boolean);

    log('info', `Returning ${items.length} completion items`);
    if (items.length > 0)
      log('info', `Items: ${items.map(i => i.label).join(', ')}`);
    return items;
  },
);

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  using _ = time(
    log,
    'info',
    `onCompletionResolve called for item: ${item.label}`,
  );
  const data = item.data as CompletionData;
  if (data && data.model) {
    item.detail = `${data.reason} (${data.model})`;
  }
  return item;
});

// copilotInlineCompletion handler
connection.onRequest(
  'textDocument/copilotInlineCompletion',
  async (params: { textDocument: { uri: string } }) => {
    using _ = time(log, 'info', 'copilotInlineCompletion');
    const uri = params?.textDocument?.uri;
    if (!uri) return { edits: [] };

    const doc = documents.get(uri);
    if (!doc) return { edits: [] };

    // Lazy import to avoid circular deps during startup
    const model = provider(SELECTED_MODEL!)!;

    try {
      const edits = await NextEdit.generate({ model, document: doc, log });
      return { edits };
    } catch (err) {
      log('error', `copilotInlineCompletion failed: ${String(err)}`);
      return { edits: [] };
    }
  },
);

connection.listen();
