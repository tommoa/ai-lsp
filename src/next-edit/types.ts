/**
 * Some utility types for next-edit completion, which are used elsewhere. Most
 * of these are also exported from the the main `next-edit` file.
 */

import { type LanguageModel } from 'ai';
import { type Range } from 'vscode-languageserver-types';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { Log, type TokenUsage } from '../util';

/**
 * LSP-style edits, with a reason for the edit.
 */
export type LspEdit = {
  range: Range;
  textDocument: { uri: string };
  text: string;
  reason?: string;
};

export type Result = {
  edits: LspEdit[];
  tokenUsage?: TokenUsage;
};

export interface Options {
  model: LanguageModel;
  document: TextDocument;
  log: Log;
}
