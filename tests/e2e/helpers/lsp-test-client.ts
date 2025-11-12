import { spawn, type ChildProcess } from 'child_process';
import {
  type MessageConnection,
  createMessageConnection,
} from 'vscode-jsonrpc/node';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type {
  InitializeParams,
  InitializeResult,
  CompletionItem,
  Position,
  DidOpenTextDocumentParams,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
} from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Configuration options for initializing the LSP test client
 */
export interface LSPTestClientOptions {
  /** Path to the LSP server executable (defaults to 'bun') */
  serverCommand?: string;
  /** Arguments to pass to server (defaults to ['run', 'src/index.ts']) */
  serverArgs?: string[];
  /** Working directory for the server process */
  cwd?: string;
  /** Initialization options to pass to the server */
  initializationOptions?: any;
  /** Timeout for requests in milliseconds (default: 5000) */
  timeout?: number;
  /** Whether to log LSP messages for debugging */
  debug?: boolean;
}

/**
 * Individual edit from copilotInlineEdit request
 */
export interface CopilotInlineEdit {
  textDocument: { uri: string; version?: number };
  range: { start: Position; end: Position };
  text: string;
  reason?: string;
  command?: any;
  uuid?: string;
}

/**
 * Response from copilotInlineEdit request
 */
export interface CopilotInlineEditResult {
  edits: CopilotInlineEdit[];
}

/**
 * Default configuration options for LSP test client
 */
const DEFAULT_OPTIONS: Required<LSPTestClientOptions> = {
  serverCommand: 'bun',
  serverArgs: ['run', 'src/index.ts', '--stdio'],
  cwd: process.cwd(),
  initializationOptions: {},
  timeout: 5000,
  debug: false,
};

/**
 * LSP Test Client for end-to-end testing
 *
 * Provides a programmatic interface to start an LSP server,
 * send requests, and verify responses. Manages the server
 * lifecycle and handles JSON-RPC communication.
 *
 * @example
 * ```typescript
 * const client = new LSPTestClient();
 * await client.start({
 *   initializationOptions: {
 *     providers: { google: {} },
 *     model: 'google/gemini-flash-latest'
 *   }
 * });
 *
 * const uri = 'file:///test.ts';
 * await client.openDocument(uri, 'const co');
 * const completions = await client.requestCompletion(uri, {
 *   line: 0, character: 8
 * });
 *
 * await client.shutdown();
 * ```
 */
export class LSPTestClient {
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private documents = new Map<string, TextDocument>();
  private messageLog: Array<{ direction: string; method: string; data: any }> =
    [];
  private options: Required<LSPTestClientOptions>;

  constructor(options: LSPTestClientOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Ensure connection is established, throws if not
   */
  private ensureConnection(): MessageConnection {
    if (!this.connection) {
      throw new Error('LSP server not started. Call start() first.');
    }
    return this.connection;
  }

  /**
   * Set up connection logging for debug mode
   */
  private setupConnectionLogging(debug: boolean): void {
    if (!this.connection || !debug) {
      return;
    }

    this.connection.onNotification((method, params) => {
      this.log('receive', method, params);
    });
  }

  /**
   * Create a reusable request with document context
   */
  private async requestWithDocumentContext<T>(
    method: string,
    uri: string,
    position: Position,
    extraParams?: Record<string, any>,
  ): Promise<T> {
    const params = {
      textDocument: { uri, version: 1 },
      position,
      ...extraParams,
    };

    this.log('send', method, params);

    return this.sendRequest<T>(method, params);
  }

  /**
   * Start the LSP server and initialize the connection
   */
  async start(
    overrideOptions?: Partial<LSPTestClientOptions>,
  ): Promise<InitializeResult> {
    if (this.process) {
      throw new Error('LSP server already started. Call shutdown() first.');
    }

    // Merge with runtime overrides
    const opts = overrideOptions
      ? { ...this.options, ...overrideOptions }
      : this.options;

    // Spawn the LSP server process
    this.process = spawn(opts.serverCommand, opts.serverArgs, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
      throw new Error('Failed to create LSP server process streams');
    }

    // Set up JSON-RPC message connection
    const reader = new StreamMessageReader(this.process.stdout);
    const writer = new StreamMessageWriter(this.process.stdin);
    this.connection = createMessageConnection(reader, writer);

    // Set up logging for debug mode
    this.setupConnectionLogging(opts.debug);

    // Collect stderr for debugging
    const stderrChunks: Buffer[] = [];
    this.process.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (opts.debug) {
        console.error('[LSP stderr]', chunk.toString());
      }
    });

    // Handle process errors
    this.process.on('error', err => {
      throw new Error(`LSP server process error: ${err.message}`);
    });

    this.process.on('exit', code => {
      if (code !== 0 && code !== null) {
        const stderr = Buffer.concat(stderrChunks).toString();
        if (opts.debug) {
          console.error(`LSP server exited with code ${code}`);
          if (stderr) console.error('stderr:', stderr);
        }
      }
    });

    // Start listening for messages
    this.connection.listen();

    // Send initialize request
    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri: null,
      capabilities: {
        textDocument: {
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: false,
            },
          },
        },
      },
      initializationOptions: opts.initializationOptions,
    };

    this.log('send', 'initialize', initParams);

    const initResult = await this.sendRequest<InitializeResult>(
      'initialize',
      initParams,
    );

    // Send initialized notification
    await this.sendNotification('initialized', {});

    return initResult;
  }

  /**
   * Gracefully shutdown the LSP server
   */
  async shutdown(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      // Send shutdown request
      await this.sendRequest('shutdown', null);
      // Send exit notification
      await this.sendNotification('exit', null);
    } catch {
      // Server might already be dead
    }

    // Close connection
    this.connection.dispose();
    this.connection = null;

    // Kill process if still alive
    if (this.process && !this.process.killed) {
      const proc = this.process;
      proc.kill();
      // Wait for process to exit
      await new Promise<void>(resolve => {
        proc.on('exit', () => resolve());
        setTimeout(() => {
          if (proc && !proc.killed) {
            proc.kill('SIGKILL');
          }
          resolve();
        }, 1000);
      });
    }

    this.process = null;
    this.documents.clear();
  }

  /**
   * Open a text document in the LSP server
   */
  async openDocument(
    uri: string,
    content: string,
    languageId = 'typescript',
  ): Promise<void> {
    const document = TextDocument.create(uri, languageId, 1, content);
    this.documents.set(uri, document);

    const params: DidOpenTextDocumentParams = {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    };

    await this.sendNotification('textDocument/didOpen', params);
  }

  /**
   * Update the content of an already-opened document
   */
  async changeDocument(uri: string, newContent: string): Promise<void> {
    const doc = this.documents.get(uri);
    if (!doc) {
      throw new Error(`Document ${uri} not opened. Call openDocument first.`);
    }

    const newVersion = doc.version + 1;
    const updated = TextDocument.create(
      uri,
      doc.languageId,
      newVersion,
      newContent,
    );
    this.documents.set(uri, updated);

    const params: DidChangeTextDocumentParams = {
      textDocument: {
        uri,
        version: newVersion,
      },
      contentChanges: [{ text: newContent }],
    };

    await this.sendNotification('textDocument/didChange', params);
  }

  /**
   * Close a document
   */
  async closeDocument(uri: string): Promise<void> {
    this.documents.delete(uri);

    const params: DidCloseTextDocumentParams = {
      textDocument: { uri },
    };

    await this.sendNotification('textDocument/didClose', params);
  }

  /**
   * Request inline completions at a position
   */
  async requestCompletion(
    uri: string,
    position: Position,
  ): Promise<CompletionItem[]> {
    return this.requestWithDocumentContext<CompletionItem[]>(
      'textDocument/completion',
      uri,
      position,
    );
  }

  /**
   * Resolve additional details for a completion item
   */
  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    this.log('send', 'completionItem/resolve', item);
    return this.sendRequest<CompletionItem>('completionItem/resolve', item);
  }

  /**
   * Request next-edit suggestions (copilotInlineEdit)
   */
  async requestNextEdit(
    uri: string,
    position: Position,
  ): Promise<CopilotInlineEditResult> {
    return this.requestWithDocumentContext<CopilotInlineEditResult>(
      'textDocument/copilotInlineEdit',
      uri,
      position,
    );
  }

  /**
   * Update server configuration dynamically
   */
  async changeConfiguration(settings: any): Promise<void> {
    await this.sendNotification('workspace/didChangeConfiguration', {
      settings,
    });
  }

  /**
   * Wrap a promise with a timeout
   */
  private withTimeout<T>(operation: Promise<T>, method: string): Promise<T> {
    return Promise.race([
      operation,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(
            new Error(
              `Request ${method} timed out after ${this.options.timeout}ms`,
            ),
          );
        }, this.options.timeout),
      ),
    ]);
  }

  /**
   * Send a custom request to the server
   */
  async sendRequest<T = any>(method: string, params: any): Promise<T> {
    const connection = this.ensureConnection();

    return this.withTimeout<T>(
      connection.sendRequest(method, params).then(result => {
        this.log('receive', method, result);
        return result as T;
      }),
      method,
    );
  }

  /**
   * Send a notification to the server (no response expected)
   */
  async sendNotification(method: string, params: any): Promise<void> {
    const connection = this.ensureConnection();

    this.log('send', method, params);
    await connection.sendNotification(method, params);
  }

  /**
   * Wait for a notification from the server
   */
  async waitForNotification(method: string, _timeoutMs?: number): Promise<any> {
    const connection = this.ensureConnection();

    return this.withTimeout<any>(
      new Promise(resolve => {
        const disposable = connection.onNotification(method, (params: any) => {
          disposable.dispose();
          resolve(params);
        });
      }),
      `notification:${method}`,
    );
  }

  /**
   * Get a document by URI
   */
  getDocument(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  /**
   * Get all message logs (useful for debugging)
   */
  getMessageLog(): Array<{ direction: string; method: string; data: any }> {
    return [...this.messageLog];
  }

  /**
   * Clear message log
   */
  clearMessageLog(): void {
    this.messageLog = [];
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Internal logging method
   */
  private log(direction: 'send' | 'receive', method: string, data: any): void {
    if (this.options.debug) {
      const truncated =
        JSON.stringify(data).length > 200
          ? JSON.stringify(data).slice(0, 200) + '...'
          : JSON.stringify(data);
      console.log(`[${direction}] ${method}:`, truncated);
    }
    this.messageLog.push({ direction, method, data });
  }
}

/**
 * Helper to create a test client with common options
 */
export function createTestClient(
  options?: LSPTestClientOptions,
): LSPTestClient {
  return new LSPTestClient(options);
}
