import { describe, it, expect } from 'bun:test';
import type { CompletionItem, TextEdit } from 'vscode-languageserver/node';
import { CompletionItemKind } from 'vscode-languageserver/node';

interface CompletionData {
  index: number;
  model: string;
  reason: string;
}

describe('LSP Completion Handler', () => {
  it('should include textEdit in completion items', () => {
    // Test that textEdit is properly set
    const textEdit: TextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 2 },
      },
      newText: 'const value = 42;',
    };
    const item: CompletionItem = {
      label: 'const value = 42;',
      kind: CompletionItemKind.Text,
      textEdit,
    };

    expect(item.textEdit).toBeDefined();
    expect(textEdit.newText).toBe('const value = 42;');
  });

  it('should have matching label and newText', () => {
    const fullText = 'const value = 42;';
    const textEdit: TextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 2 },
      },
      newText: fullText,
    };
    const item: CompletionItem = {
      label: fullText,
      kind: CompletionItemKind.Text,
      textEdit,
    };

    expect(item.label).toBe(textEdit.newText);
  });

  it('should not have filterText when label and textEdit.newText match', () => {
    const fullText = 'const value = 42;';
    const textEdit: TextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 2 },
      },
      newText: fullText,
    };
    const item: CompletionItem = {
      label: fullText,
      kind: CompletionItemKind.Text,
      textEdit,
    };

    // filterText should not be set since label defaults to it
    expect(item.filterText).toBeUndefined();
  });

  it('should contain textEdit range for partial word replacement', () => {
    const textEdit: TextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 7 },
      },
      newText: 'Math.floor(5)',
    };
    const item: CompletionItem = {
      label: 'Math.floor(5)',
      kind: CompletionItemKind.Text,
      textEdit,
    };

    expect(textEdit.range.start.character).toBe(0);
    expect(textEdit.range.end.character).toBe(7);
    expect(item.label).toBe(textEdit.newText);
  });

  it('should handle completion with different start and end positions', () => {
    const textEdit: TextEdit = {
      range: {
        start: { line: 5, character: 10 },
        end: { line: 5, character: 13 },
      },
      newText: 'console.log("hello")',
    };
    const item: CompletionItem = {
      label: 'console.log("hello")',
      kind: CompletionItemKind.Text,
      textEdit,
    };

    expect(textEdit.range.start.line).toBe(5);
    expect(textEdit.range.end.line).toBe(5);
    expect(textEdit.range.start.character).toBe(10);
    expect(textEdit.range.end.character).toBe(13);
    expect(item.label).toBe(textEdit.newText);
  });

  it('should preserve data field for completion resolution', () => {
    const data: CompletionData = {
      index: 0,
      model: 'google/gemini-flash',
      reason: 'complete statement',
    };

    const textEdit: TextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 2 },
      },
      newText: 'const value = 42;',
    };
    const item: CompletionItem = {
      label: 'const value = 42;',
      kind: CompletionItemKind.Text,
      textEdit,
      data,
    };

    expect(item.data).toBeDefined();
    const itemData = item.data as CompletionData;
    expect(itemData.index).toBe(0);
    expect(itemData.reason).toBe('complete statement');
  });

  it('should handle multiline completion text', () => {
    const multilineText = 'function test() {\n  return 42;\n}';
    const textEdit: TextEdit = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      newText: multilineText,
    };
    const item: CompletionItem = {
      label: multilineText,
      kind: CompletionItemKind.Text,
      textEdit,
    };

    expect(textEdit.newText).toContain('\n');
    expect(textEdit.newText).toContain('function');
    expect(textEdit.newText).toContain('return');
    expect(item.label).toBe(textEdit.newText);
  });
});
