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
  parseModelString,
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

// Mode-specific configuration
interface ModeConfig {
  model?: string;
  prompt?: 'prefix_suffix' | 'line_number';
}

interface InitOptions {
  providers?: Record<string, ProviderInitOptions>;
  model?: string;
  next_edit?: ModeConfig;
  inline_completion?: ModeConfig;
}

interface NextEditConfig {
  model: LanguageModel;
  modelId: string;
  prompt: 'prefix_suffix' | 'line_number';
}

interface InlineCompletionConfig {
  model: LanguageModel;
  modelId: string;
}

let NEXT_EDIT_CONFIG: NextEditConfig | null = null;
let INLINE_COMPLETION_CONFIG: InlineCompletionConfig | null = null;

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
  initOpts: InitOptions,
  log: Log,
): Promise<ProviderInitResult> {
  const providers = initOpts.providers || undefined;
  const optModel = initOpts.model || undefined;

  if (optModel === undefined) {
    throw new Error(
      'No model defined. Please define `model` in `initializationOptions`',
    );
  }

  const { providerId, modelName } = parseModelString(optModel);

  log('info', `provider=${providerId}, model=${modelName}`);

  const factory = await createProvider({
    provider: providerId,
    log,
    providers,
  });

  try {
    return {
      factory,
      provider: providerId,
      model: factory(modelName),
      modelId: modelName,
    };
  } catch (err) {
    log('error', `Could not instantiate model ${modelName}: ${String(err)}`);
    throw err;
  }
}

async function initModeConfigs(
  initOpts: InitOptions,
  globalProvider: ModelSelector,
  globalModelId: string,
  log: Log,
): Promise<void> {
  // Initialize next-edit config
  const nextEditOpts = initOpts.next_edit || {};
  const nextEditModelId = nextEditOpts.model || globalModelId;
  const nextEditPrompt = nextEditOpts.prompt || 'prefix_suffix';

  if (nextEditPrompt !== 'prefix_suffix' && nextEditPrompt !== 'line_number') {
    log('warn', `Invalid next_edit.prompt: ${nextEditPrompt}, using default`);
    NEXT_EDIT_CONFIG = {
      model: globalProvider(nextEditModelId),
      modelId: nextEditModelId,
      prompt: 'prefix_suffix',
    };
  } else {
    NEXT_EDIT_CONFIG = {
      model: globalProvider(nextEditModelId),
      modelId: nextEditModelId,
      prompt: nextEditPrompt,
    };
  }

  log(
    'info',
    `next-edit: model=${NEXT_EDIT_CONFIG.modelId}, ` +
      `prompt=${NEXT_EDIT_CONFIG.prompt}`,
  );

  // Initialize inline-completion config
  const inlineCompletionOpts = initOpts.inline_completion || {};
  const inlineCompletionModelId = inlineCompletionOpts.model || globalModelId;

  INLINE_COMPLETION_CONFIG = {
    model: globalProvider(inlineCompletionModelId),
    modelId: inlineCompletionModelId,
  };

  log('info', `inline-completion: model=${INLINE_COMPLETION_CONFIG.modelId}`);
}

connection.onInitialize(async (params: InitializeParams) => {
  log('info', 'LSP Server initializing...');
  const initOpts = params.initializationOptions || ({} as InitOptions);

  const result = await (async () => {
    try {
      const res = await initProvider(initOpts, log);
      provider = res.factory;
      SELECTED_MODEL = res.modelId;

      // Initialize mode-specific configs
      await initModeConfigs(initOpts, provider, SELECTED_MODEL, log);
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
  log('info', `Global model: ${SELECTED_MODEL}`);
  if (NEXT_EDIT_CONFIG) {
    log(
      'info',
      `next-edit: ${NEXT_EDIT_CONFIG.modelId} (${NEXT_EDIT_CONFIG.prompt})`,
    );
  }
  if (INLINE_COMPLETION_CONFIG) {
    log('info', `inline-completion: ${INLINE_COMPLETION_CONFIG.modelId}`);
  }

  connection.onDidChangeConfiguration(async change => {
    try {
      const config = (change.settings || {}) as InitOptions;

      const res = await initProvider(config, log);
      provider = res.factory;
      SELECTED_MODEL = res.modelId;

      // Re-initialize mode configs
      await initModeConfigs(config, provider, SELECTED_MODEL, log);

      log('info', 'Configuration updated successfully');
    } catch (err) {
      log('error', 'Error handling configuration change: ' + String(err));
    }
  });
});

connection.onCompletion(
  async (pos: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    using _ = time(log, 'info', 'onCompletion');

    if (!INLINE_COMPLETION_CONFIG) {
      log('error', 'Inline completion config not initialized');
      return [];
    }

    const completions = await InlineCompletion.generate({
      model: INLINE_COMPLETION_CONFIG.model,
      document: documents.get(pos.textDocument.uri)!,
      position: pos,
      log,
    });

    log('info', `Completions ${JSON.stringify(completions)}`);

    // `completions` is now an array of { text, reason } objects. Map them to
    // CompletionItems. Use the first line of the text as the label so items
    // remain concise. Put the model reason into `detail` (fall back to the
    // previous model label when reason is empty).
    const items: CompletionItem[] = (completions || [])
      .map((c, index) => {
        const text = c.text ?? String(c);
        const reason = c.reason ?? '';
        const label = String(text).split('\n')[0];
        return {
          label,
          kind: CompletionItemKind.Text,
          text,
          data: {
            index,
            model: INLINE_COMPLETION_CONFIG!.modelId,
            reason,
          } as CompletionData,
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
  async (opts: {
    textDocument: { uri: string };
    position: TextDocumentPositionParams;
  }) => {
    using _ = time(log, 'info', 'copilotInlineCompletion');
    const uri = opts?.textDocument?.uri;
    if (!uri) return { edits: [] };

    const doc = documents.get(uri);
    if (!doc) return { edits: [] };

    if (!NEXT_EDIT_CONFIG) {
      log('error', 'next-edit config not initialized');
      return { edits: [] };
    }

    try {
      const edits = await NextEdit.generate({
        model: NEXT_EDIT_CONFIG.model,
        document: doc,
        prompt: NEXT_EDIT_CONFIG.prompt,
        log,
      });
      return { edits };
    } catch (err) {
      log('error', `copilotInlineCompletion failed: ${String(err)}`);
      return { edits: [] };
    }
  },
);

connection.listen();
