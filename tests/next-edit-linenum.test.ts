import { describe, it, expect } from 'bun:test';
import {
  type LLMHint,
  parseLLMResponse,
  convertLLMHintsToEdits,
} from '../src/next-edit/line-number';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { NOOP_LOG } from '../src/util';

describe('LineNumber', () => {
  describe('parseLLMResponse', () => {
    it('should parse valid line-number hints', () => {
      const raw = JSON.stringify([
        {
          startLine: 1,
          endLine: 1,
          text: 'console.log("updated");',
          reason: 'update statement',
        },
        { startLine: 3, endLine: 5, text: 'new code here', reason: 'insert' },
      ]);
      const hints = parseLLMResponse(raw, console.log);
      expect(hints).toHaveLength(2);
      expect(hints[0]!.startLine).toBe(1);
      expect(hints[0]!.endLine).toBe(1);
      expect(hints[1]!.startLine).toBe(3);
      expect(hints[1]!.endLine).toBe(5);
    });

    it('should normalize newlines in text', () => {
      const raw = JSON.stringify([
        { startLine: 1, endLine: 1, text: 'line1\r\nline2', reason: 'test' },
      ]);
      const hints = parseLLMResponse(raw, NOOP_LOG);
      expect(hints[0]!.text).toBe('line1\nline2');
    });

    it('should throw on invalid hint shape', () => {
      const raw = JSON.stringify([{ startLine: 1 }]); // missing endLine, text
      expect(() => parseLLMResponse(raw, NOOP_LOG)).toThrow();
    });

    it('should throw on non-object hint', () => {
      const raw = JSON.stringify([null]);
      expect(() => parseLLMResponse(raw, NOOP_LOG)).toThrow(
        'Invalid hint shape',
      );
    });

    it('should throw on hint with wrong field types', () => {
      const raw = JSON.stringify([
        { startLine: '1', endLine: 2, text: 'test' },
      ]);
      expect(() => parseLLMResponse(raw, NOOP_LOG)).toThrow(
        'Invalid hint shape',
      );
    });

    it('should extract JSON from wrapped response', () => {
      const raw =
        'Here is my suggestion: ' +
        JSON.stringify([{ startLine: 1, endLine: 1, text: 'new' }]) +
        ' This is good.';
      const hints = parseLLMResponse(raw, NOOP_LOG);
      expect(hints).toHaveLength(1);
      expect(hints[0]!.text).toBe('new');
    });
  });

  describe('convertLLMHintsToEdits', () => {
    it('should convert valid line ranges to edits', () => {
      const docText = 'line 1\nline 2\nline 3\nline 4\nline 5';
      const doc = TextDocument.create('file:///test.txt', 'text', 1, docText);

      const hints: LLMHint[] = [
        { startLine: 2, endLine: 2, text: 'modified line 2', reason: 'test' },
        {
          startLine: 4,
          endLine: 5,
          text: 'combined line',
          reason: 'test',
        },
      ];

      const edits = convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(2);
      expect(edits[0]!.text).toBe('modified line 2');
      expect(edits[1]!.text).toBe('combined line');
    });

    it('should skip invalid line numbers', () => {
      const docText = 'line 1\nline 2\nline 3';
      const doc = TextDocument.create('file:///test.txt', 'text', 1, docText);

      const hints: LLMHint[] = [
        { startLine: 1, endLine: 1, text: 'ok', reason: 'test' },
        { startLine: 10, endLine: 10, text: 'out of range', reason: 'test' },
        { startLine: 2, endLine: 1, text: 'invalid range', reason: 'test' },
      ];

      const edits = convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe('ok');
    });

    it('should handle single-line documents', () => {
      const docText = 'single line';
      const doc = TextDocument.create('file:///test.txt', 'text', 1, docText);

      const hints: LLMHint[] = [
        { startLine: 1, endLine: 1, text: 'replaced', reason: 'test' },
      ];

      const edits = convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe('replaced');
    });

    it('should preserve reason field', () => {
      const docText = 'line 1\nline 2';
      const doc = TextDocument.create('file:///test.txt', 'text', 1, docText);

      const hints: LLMHint[] = [
        { startLine: 1, endLine: 1, text: 'new', reason: 'fix typo' },
      ];

      const edits = convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits[0]!.reason).toBe('fix typo');
    });
  });
});
