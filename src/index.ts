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
  type Position,
} from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  create as createProvider,
  parseModelString,
  type Config as ProviderConfig,
  type Selector,
  Model,
} from './provider';
import {
  generateCompletion,
  type Options as InlineCompletionOptions,
} from './inline-completion';
import { generateEdit, type Options as NextEditOptions } from './next-edit';
import { extractPartialWord } from './completion-utils';
import { Level, Log, time } from './util';
import {
  autoDetectFimTemplate,
  BUILTIN_FIM_TEMPLATES,
  type FimTemplate,
} from './inline-completion/fim-formats';

/**
 * Resolve FIM template from configuration.
 *
 * @param configFormat - Template from config (string ID, object, or undefined)
 * @param modelId - Model ID for auto-detection fallback
 * @returns Resolved FIM template
 */
function resolveFimTemplate(
  configFormat: string | FimTemplate | undefined,
  modelId: string,
): FimTemplate {
  if (typeof configFormat === 'object') {
    return configFormat;
  }
  if (typeof configFormat === 'string') {
    return (
      BUILTIN_FIM_TEMPLATES[configFormat] ?? BUILTIN_FIM_TEMPLATES['openai']!
    );
  }
  return autoDetectFimTemplate(modelId);
}

// TODO: Figure out a way to ship these around without needing this horrible
// top-level functions.
// Selected provider selector (resolves model id to a concrete model
// representation for `generateText`). Can be replaced during init.
let provider: Selector = (model: string) => model as any;
let SELECTED_MODEL: string | undefined = undefined;
let WORKSPACE_ROOT_URI: string | null = null;

// Mode-specific configuration.
interface NextEditModeConfig {
  model?: string;
  prompt?: NextEditOptions['prompt'];
}

interface InlineCompletionModeConfig {
  model?: string;
  prompt?: InlineCompletionOptions['prompt'];
  fim_format?: string | FimTemplate;
}

interface InitOptions {
  providers?: Record<string, ProviderConfig>;
  model?: string;
  next_edit?: NextEditModeConfig;
  inline_completion?: InlineCompletionModeConfig;
}

// Mode-specific runtime configuration after initialization.
interface NextEditConfig {
  model: Model;
  modelId: string;
  prompt: NextEditOptions['prompt'];
}

interface InlineCompletionConfig {
  model: Model;
  modelId: string;
  prompt: InlineCompletionOptions['prompt'];
  fimFormat?: FimTemplate;
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
  factory: Selector;
  provider: string;
  model: Model;
  modelId: string;
};

async function initProvider(
  initOpts: InitOptions,
  log: Log,
): Promise<ProviderInitResult> {
  if (initOpts.model === undefined) {
    throw new Error(
      'No model defined. Please define `model` in `initializationOptions`',
    );
  }

  const { provider, modelName } = parseModelString(initOpts.model);

  log('info', `provider=${provider}, model=${modelName}`);

  const factory = await createProvider({
    provider,
    log,
    providers: initOpts.providers,
  });

  try {
    return {
      factory,
      provider,
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
  globalProvider: Selector,
  globalModelId: string,
  log: Log,
): Promise<void> {
  // Initialize next-edit config
  const nextEditOpts = initOpts.next_edit || {};
  const nextEditModelId = nextEditOpts.model || globalModelId;
  const nextEditPrompt = nextEditOpts.prompt || 'prefix-suffix';

  type NextEditPrompt = NextEditOptions['prompt'];

  // Validate next_edit.prompt
  let validatedNextEditPrompt: NextEditPrompt = 'prefix-suffix';
  const nextEditPromptValues: NextEditPrompt[] = [
    'prefix-suffix',
    'line-number',
  ];
  if (nextEditPromptValues.includes(nextEditPrompt)) {
    validatedNextEditPrompt = nextEditPrompt as NextEditPrompt;
  } else {
    log('warn', `Invalid next_edit.prompt: ${nextEditPrompt}, using default`);
  }

  NEXT_EDIT_CONFIG = {
    model: globalProvider(nextEditModelId),
    modelId: nextEditModelId,
    prompt: validatedNextEditPrompt,
  };

  log(
    'info',
    `generateEdit: model=${NEXT_EDIT_CONFIG.modelId}, ` +
      `prompt=${NEXT_EDIT_CONFIG.prompt}`,
  );

  // Initialize inline-completion config
  const inlineCompletionOpts = initOpts.inline_completion || {};
  const inlineCompletionModelId = inlineCompletionOpts.model || globalModelId;
  const inlineCompletionPrompt = inlineCompletionOpts.prompt || 'chat';

  type InlinePrompt = InlineCompletionOptions['prompt'];

  // Validate inline_completion.prompt
  let validatedInlinePrompt: InlinePrompt = 'chat';
  const inlineCompletionPromptValues: InlinePrompt[] = ['chat', 'fim'];
  if (inlineCompletionPromptValues.includes(inlineCompletionPrompt)) {
    validatedInlinePrompt = inlineCompletionPrompt as InlinePrompt;
  } else {
    log(
      'warn',
      `Invalid inline_completion.prompt: ${inlineCompletionPrompt}, ` +
        `using default 'chat'`,
    );
  }

  // Resolve FIM template (only if prompt is 'fim')
  let fimFormat: FimTemplate | undefined;
  if (validatedInlinePrompt === 'fim') {
    fimFormat = resolveFimTemplate(
      inlineCompletionOpts.fim_format,
      inlineCompletionModelId,
    );
    log('info', `FIM template: ${fimFormat.name || 'custom'}`);
  }

  INLINE_COMPLETION_CONFIG = {
    model: globalProvider(inlineCompletionModelId),
    modelId: inlineCompletionModelId,
    prompt: validatedInlinePrompt as InlineCompletionOptions['prompt'],
    fimFormat,
  };

  log(
    'info',
    `generateCompletion: model=${INLINE_COMPLETION_CONFIG.modelId}, ` +
      `prompt=${INLINE_COMPLETION_CONFIG.prompt}`,
  );
}

connection.onInitialize(async (params: InitializeParams) => {
  log('info', 'LSP Server initializing...');
  WORKSPACE_ROOT_URI = params.rootUri;
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
    log(
      'info',
      `inline-completion: ${INLINE_COMPLETION_CONFIG.modelId} ` +
        `(${INLINE_COMPLETION_CONFIG.prompt})`,
    );
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

    const doc = documents.get(pos.textDocument.uri)!;
    let result;
    try {
      const prompt =
        INLINE_COMPLETION_CONFIG.prompt as InlineCompletionOptions['prompt'];

      result = await generateCompletion({
        model: INLINE_COMPLETION_CONFIG.model.model,
        document: doc,
        position: pos,
        log,
        prompt,
        ...(prompt === 'fim' && {
          fimFormat: INLINE_COMPLETION_CONFIG.fimFormat!,
          maxTokens: 256,
          workspaceRootUri: WORKSPACE_ROOT_URI,
        }),
      } as InlineCompletionOptions);
    } catch (err) {
      log('error', `generateCompletion failed: ${String(err)}`);
      throw err;
    }

    const completions = result.completions;
    log('info', `Completions ${JSON.stringify(completions)}`);

    // Extract the partial word at cursor for better filtering
    const { partial: partialWord, startChar } = extractPartialWord(
      doc,
      pos.position,
    );
    log(
      'debug',
      `Partial word at cursor: "${partialWord}" startChar=${startChar}`,
    );

    // `completions` is an array of { text, reason } objects that need to be
    // mapped to CompletionItems.
    const items: CompletionItem[] = (completions || [])
      .map((c, index) => {
        const text = c.text ?? String(c);
        const reason = c.reason ?? '';

        // Reconstruct the full text by prepending the partial word
        const fullText = partialWord + text;

        // Calculate the start position of the partial word on this line
        const partialWordStartPos: Position = {
          line: pos.position.line,
          character: startChar,
        };

        return {
          label: fullText,
          kind: CompletionItemKind.Text,
          textEdit: {
            range: {
              start: partialWordStartPos,
              end: pos.position,
            },
            newText: fullText,
          },
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

// copilotInlineEdit handler
connection.onRequest(
  'textDocument/copilotInlineEdit',
  async (opts: {
    textDocument: { uri: string };
    position: TextDocumentPositionParams;
  }) => {
    using _ = time(log, 'info', 'copilotInlineEdit');
    const uri = opts?.textDocument?.uri;
    if (!uri) return { edits: [] };

    const doc = documents.get(uri);
    if (!doc) return { edits: [] };

    if (!NEXT_EDIT_CONFIG) {
      log('error', 'next-edit config not initialized');
      return { edits: [] };
    }

    try {
      const result = await generateEdit({
        model: NEXT_EDIT_CONFIG.model.model,
        document: doc,
        prompt: NEXT_EDIT_CONFIG.prompt,
        log,
      });
      return { edits: result.edits };
    } catch (err) {
      log('error', `copilotInlineEdit failed: ${String(err)}`);
      return { edits: [] };
    }
  },
);

connection.listen();
