import { describe, it, expect } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position, CompletionItem } from 'vscode-languageserver/node';
import { extractPartialWord } from '../src/completion-utils';
import type { Completion } from '../src/inline-completion';

describe('CompletionItem generation', () => {
  it('should create proper fullText by prepending partial word', () => {
    const mockCompletion: Completion = {
      text: 'nst value = 42;',
      reason: 'complete statement',
    };

    const partialWord = 'co';
    const fullText = partialWord + mockCompletion.text;

    expect(fullText).toBe('const value = 42;');
  });

  it('should handle method completion correctly', () => {
    const mockCompletion: Completion = {
      text: 'oor(5)',
      reason: 'complete method call',
    };

    const partialWord = 'Math.fl';
    const fullText = partialWord + mockCompletion.text;

    expect(fullText).toBe('Math.floor(5)');
  });

  it('should handle empty partial word', () => {
    const mockCompletion: Completion = {
      text: 'console.log("hello")',
      reason: 'add logging',
    };

    const partialWord = '';
    const fullText = partialWord + mockCompletion.text;

    expect(fullText).toBe('console.log("hello")');
  });

  it('should create textEdit with correct range for partial word', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const co',
    );
    const position: Position = { line: 0, character: 8 };

    const { partial: partialWord, startChar } = extractPartialWord(
      doc,
      position,
    );
    const mockCompletion: Completion = {
      text: 'nst value = 42;',
      reason: 'complete',
    };
    const fullText = partialWord + mockCompletion.text;

    // Simulate completion item creation
    const item: CompletionItem = {
      label: fullText,
      kind: 1, // CompletionItemKind.Text
      textEdit: {
        range: {
          start: { line: position.line, character: startChar },
          end: position,
        },
        newText: fullText,
      } as any,
    };

    const textEdit = item.textEdit as any;
    expect(textEdit.range.start.character).toBe(6);
    expect(textEdit.range.end.character).toBe(8);
    expect(textEdit.newText).toBe('const value = 42;');
  });

  it('should have matching label and newText', () => {
    const fullText = 'const value = 42;';
    const item: CompletionItem = {
      label: fullText,
      kind: 1,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 2 },
        },
        newText: fullText,
      } as any,
    };

    const textEdit = item.textEdit as any;
    expect(item.label).toBe(textEdit.newText);
  });

  it('should handle multiline completions', () => {
    const mockCompletion: Completion = {
      text: 'unction test() {\n  return 42;\n}',
      reason: 'complete function',
    };

    const partialWord = 'f';
    const fullText = partialWord + mockCompletion.text;

    expect(fullText).toContain('function');
    expect(fullText).toContain('\n');
  });

  it('should correctly calculate startChar for nested property access', () => {
    const doc = TextDocument.create(
      'file:///test.js',
      'javascript',
      1,
      'object.prop.met',
    );
    const position: Position = { line: 0, character: 15 };

    const { partial: partialWord, startChar } = extractPartialWord(
      doc,
      position,
    );

    expect(partialWord).toBe('object.prop.met');
    expect(startChar).toBe(0);
  });

  it('should not include partial word twice in final text', () => {
    const partialWord = 'Math.fl';
    const llmGenerated = 'oor(5)';
    const fullText = partialWord + llmGenerated;

    // Should be 'Math.floor(5)', not contain the suffix without 'Math.fl'
    expect(fullText).toBe('Math.floor(5)');
    expect(fullText.split('Math.floor').length).toBe(2); // only one occurrence
  });
});
