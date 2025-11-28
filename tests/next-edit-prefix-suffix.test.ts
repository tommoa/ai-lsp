import { describe, it, expect } from 'bun:test';
import { PrefixSuffix } from '../src/next-edit/prefix-suffix';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { NOOP_LOG } from '../src/util';

describe('PrefixSuffix', () => {
  describe('parseLLMResponse', () => {
    it('should parse valid hints', () => {
      const raw = JSON.stringify([
        {
          prefix: 'const x = ',
          existing: 'old',
          suffix: ';',
          text: 'new',
          reason: 'update',
        },
      ]);
      const hints = PrefixSuffix.parseLLMResponse(raw, NOOP_LOG);
      expect(hints).toHaveLength(1);
      expect(hints[0]!.prefix).toBe('const x = ');
      expect(hints[0]!.existing).toBe('old');
      expect(hints[0]!.suffix).toBe(';');
      expect(hints[0]!.text).toBe('new');
      expect(hints[0]!.reason).toBe('update');
    });

    it('should normalize newlines', () => {
      const raw = JSON.stringify([
        {
          prefix: 'line1\r\n',
          existing: 'old\r\n',
          suffix: '\r\nline2',
          text: 'new\r\n',
        },
      ]);
      const hints = PrefixSuffix.parseLLMResponse(raw, NOOP_LOG);
      expect(hints[0]!.prefix).toBe('line1\n');
      expect(hints[0]!.existing).toBe('old\n');
      expect(hints[0]!.suffix).toBe('\nline2');
      expect(hints[0]!.text).toBe('new\n');
    });

    it('should throw on invalid hint shape - non-object', () => {
      const raw = JSON.stringify([null]);
      expect(() => PrefixSuffix.parseLLMResponse(raw, NOOP_LOG)).toThrow(
        'Invalid hint shape',
      );
    });

    it('should throw on invalid hint shape - missing fields', () => {
      const raw = JSON.stringify([{ prefix: 'test' }]);
      expect(() => PrefixSuffix.parseLLMResponse(raw, NOOP_LOG)).toThrow(
        'Invalid hint shape',
      );
    });

    it('should throw on invalid hint shape - wrong types', () => {
      const raw = JSON.stringify([
        {
          prefix: 123,
          existing: 'old',
          suffix: ';',
          text: 'new',
        },
      ]);
      expect(() => PrefixSuffix.parseLLMResponse(raw, NOOP_LOG)).toThrow(
        'Invalid hint shape',
      );
    });

    it('should extract JSON from wrapped response', () => {
      const raw =
        'Here are the edits: ' +
        JSON.stringify([
          { prefix: 'x = ', existing: 'old', suffix: ';', text: 'new' },
        ]) +
        ' Done.';
      const hints = PrefixSuffix.parseLLMResponse(raw, NOOP_LOG);
      expect(hints).toHaveLength(1);
      expect(hints[0]!.text).toBe('new');
    });
  });

  describe('convertLLMHintsToEdits - edge cases', () => {
    it('should handle insertion with empty existing field', () => {
      const docText = 'const x = ;';
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        docText,
      );

      const hints: PrefixSuffix.LLMHint[] = [
        {
          prefix: 'const x = ',
          existing: '',
          suffix: ';',
          text: '10',
          reason: 'insert',
        },
      ];

      const edits = PrefixSuffix.convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe('10');
    });

    it('should insert at first prefix match with multiple occurrences', () => {
      const docText = 'x = 1;\ny = 2;\nx = 3;';
      const doc = TextDocument.create(
        'file:///test.js',
        'javascript',
        1,
        docText,
      );

      const hints: PrefixSuffix.LLMHint[] = [
        {
          prefix: 'x = ',
          existing: '1',
          suffix: ';',
          text: '100',
          reason: 'insert at first x',
        },
      ];

      const edits = PrefixSuffix.convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe('100');
    });

    it('should skip unresolved hints', () => {
      const docText = 'const x = 5;\nconst y = 10;';
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        docText,
      );

      const hints: PrefixSuffix.LLMHint[] = [
        {
          prefix: 'const z = ', // doesn't exist
          existing: '99',
          suffix: ';',
          text: '100',
          reason: 'update',
        },
      ];

      const edits = PrefixSuffix.convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(0);
    });

    it('should handle exact anchor match', () => {
      const docText = 'function test() { return 42; }';
      const doc = TextDocument.create(
        'file:///test.js',
        'javascript',
        1,
        docText,
      );

      const hints: PrefixSuffix.LLMHint[] = [
        {
          prefix: 'function test() { return ',
          existing: '42',
          suffix: '; }',
          text: '100',
          reason: 'update',
        },
      ];

      const edits = PrefixSuffix.convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe('100');
    });

    it('should handle unique prefix match', () => {
      const docText = 'const x = 5;\nconst y = 10;';
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        docText,
      );

      const hints: PrefixSuffix.LLMHint[] = [
        {
          prefix: 'const y = ',
          existing: '10',
          suffix: ';',
          text: '20',
          reason: 'update',
        },
      ];

      const edits = PrefixSuffix.convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]!.text).toBe('20');
    });

    it('should preserve reason field', () => {
      const docText = 'x = 1;';
      const doc = TextDocument.create(
        'file:///test.js',
        'javascript',
        1,
        docText,
      );

      const hints: PrefixSuffix.LLMHint[] = [
        {
          prefix: 'x = ',
          existing: '1',
          suffix: ';',
          text: '2',
          reason: 'fix bug',
        },
      ];

      const edits = PrefixSuffix.convertLLMHintsToEdits(
        {
          document: doc,
          hints,
        },
        NOOP_LOG,
      );
      expect(edits[0]!.reason).toBe('fix bug');
    });
  });
});
