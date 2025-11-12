/**
 * Unit tests for Chat-based inline completion
 *
 * Tests the Chat.generate() function with mock models.
 * Covers:
 * - Basic chat completion generation
 * - JSON parsing and validation
 * - Token usage tracking
 * - Error handling (invalid JSON, empty responses)
 */

import { describe, it, expect } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';
import { Chat } from '../src/inline-completion/chat';
import { InlineCompletion } from '../src/inline-completion';
import { NOOP_LOG } from '../src/util';
import { createMockModel } from './helpers/mock-model';

describe('Chat.generate', () => {
  const testDoc = TextDocument.create(
    'file:///test.ts',
    'typescript',
    1,
    'const x = hello + world',
  );

  const testPosition: TextDocumentPositionParams = {
    textDocument: { uri: 'file:///test.ts' },
    position: { line: 0, character: 13 }, // after 'hello + '
  };

  describe('basic completion generation', () => {
    it('should generate completions from chat model', async () => {
      const response = JSON.stringify([
        { text: 'sum', reason: 'variable name' },
        { text: 'result', reason: 'alternative name' },
      ]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).not.toBeNull();
      expect(result.completions).toHaveLength(2);
      expect(result.completions![0]!.text).toBe('sum');
      expect(result.completions![0]!.reason).toBe('variable name');
      expect(result.completions![1]!.text).toBe('result');
    });

    it('should include token usage in result', async () => {
      const response = JSON.stringify([{ text: 'completion' }]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.input).toBe(100);
      expect(result.tokenUsage!.output).toBe(50);
    });

    it('should handle completions without reason field', async () => {
      const response = JSON.stringify([
        { text: 'completion1' },
        { text: 'completion2', reason: 'has reason' },
      ]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
      });

      expect(result.completions).toHaveLength(2);
      expect(result.completions![0]!.text).toBe('completion1');
      expect(result.completions![0]!.reason).toBe('');
      expect(result.completions![1]!.reason).toBe('has reason');
    });

  });

  describe('validation and filtering', () => {
    it('should filter out invalid completions', async () => {
      const response = JSON.stringify([
        { text: 'valid' },
        { text: null }, // invalid: null text
        { reason: 'no text field' }, // invalid: missing text
        { text: '' }, // invalid: empty text
        { text: 42 }, // invalid: non-string text
        { text: 'also valid', reason: 'good' },
      ]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      // Only 2 valid completions should remain
      expect(result.completions).toHaveLength(2);
      expect(result.completions![0]!.text).toBe('valid');
      expect(result.completions![1]!.text).toBe('also valid');
    });

    it('should return null when all completions are invalid', async () => {
      const response = JSON.stringify([
        { text: null },
        { text: '' },
        { reason: 'no text' },
      ]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).toBeNull();
    });

    it('should return null for empty array response', async () => {
      const response = JSON.stringify([]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should handle malformed JSON gracefully', async () => {
      const response = 'this is not valid JSON {[}';
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).toBeNull();
    });

    it('should handle non-array JSON', async () => {
      const response = JSON.stringify({ text: 'not an array' });
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).toBeNull();
    });

    it('should handle empty response text', async () => {
      const model = createMockModel({ response: '' });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).toBeNull();
    });

    it('should handle model errors gracefully', async () => {
      const model = createMockModel({ throwError: true });

      const result = await Chat.generate({
        model,
        document: testDoc,
        position: testPosition,
        log: NOOP_LOG,
      });

      expect(result.completions).toBeNull();
      expect(result.tokenUsage).toBeUndefined();
    });
  });

  describe('context handling', () => {
    it('should split context at cursor position', async () => {
      const doc = TextDocument.create(
        'file:///test.py',
        'python',
        1,
        'def add(a, b):\n    return ',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.py' },
        position: { line: 1, character: 11 }, // after 'return '
      };

      const response = JSON.stringify([{ text: 'a + b' }]);
      const model = createMockModel({ response });

      const result = await Chat.generate({
        model,
        document: doc,
        position,
      });

      expect(result.completions).not.toBeNull();
      expect(result.completions![0]!.text).toBe('a + b');
    });
  });

  describe('InlineCompletion routing', () => {
    it('should route to Chat by default and when prompt="chat"', async () => {
      const chatResponse = JSON.stringify([
        { text: 'chat_completion', reason: 'contextual' },
      ]);
      const model = createMockModel({ response: chatResponse });

      // Test default (no prompt specified)
      const result1 = await InlineCompletion.generate({
        model,
        document: testDoc,
        position: testPosition,
      });
      expect(result1.completions).not.toBeNull();
      expect(result1.completions?.[0]?.text).toBe('chat_completion');

      // Test explicit prompt="chat"
      const result2 = await InlineCompletion.generate({
        model,
        document: testDoc,
        position: testPosition,
        prompt: InlineCompletion.PromptType.Chat,
      });
      expect(result2.completions).not.toBeNull();
      expect(result2.completions?.[0]?.text).toBe('chat_completion');
    });
  });
});
