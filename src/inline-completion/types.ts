/**
 * Some utility types for inline completion, which are used elsewhere. Most of
 * these are also exported from the the main `inline-completion` file.
 */

import type { TextDocumentPositionParams } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { type Log, type TokenUsage } from '../util';
import { type LanguageModel } from 'ai';

export interface Completion {
  /**
   * The actual completion text that has been returned. Will only be the text
   * from the point of the cursor.
   */
  text: string;
  /**
   * The reason why the text has been returned, according to the LLM (if any).
   */
  reason?: string;
}

/**
 * The Result type of the inline-completion endpoint. This
 */
export interface Result {
  /**
   * The list of potential completions that the LLM has suggested.
   */
  completions: Completion[];
  /**
   * The total number of tokens used to generate these completions.
   */
  tokenUsage?: TokenUsage;
}

/**
 * Generation options for the inline-completion endpoint.
 */
export interface GenerateOptions {
  /**
   * The language model being used.
   */
  model: LanguageModel;
  /**
   * The text document that a completion has been requested for.
   */
  document: TextDocument;
  /**
   * The position of the cursor within the document for a completion request.
   */
  position: TextDocumentPositionParams;
  /**
   * An endpoint to log to.
   */
  log: Log;
}
