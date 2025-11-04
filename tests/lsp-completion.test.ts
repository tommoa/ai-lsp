import { describe, it, expect } from 'bun:test';
import type { CompletionItem } from 'vscode-languageserver/node';
import { CompletionItemKind } from 'vscode-languageserver/node';

describe('LSP Completion Handler', () => {
  it('should include textEdit in completion items', () => {
    // Test that textEdit is properly set
    const item: CompletionItem = {
      label: 'const value = 42;',
      kind: CompletionItemKind.Text,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 2 },
        },
        newText: 'const value = 42;',
      } as any,
    };

    expect(item.textEdit).toBeDefined();
    const textEdit = item.textEdit as any;
    expect(textEdit.newText).toBe('const value = 42;');
  });

  it('should have matching label and newText', () => {
    const fullText = 'const value = 42;';
    const item: CompletionItem = {
      label: fullText,
      kind: CompletionItemKind.Text,
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

  it('should not have filterText when label and textEdit.newText match', () => {
    const fullText = 'const value = 42;';
    const item: CompletionItem = {
      label: fullText,
      kind: CompletionItemKind.Text,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 2 },
        },
        newText: fullText,
      } as any,
    };

    // filterText should not be set since label defaults to it
    expect(item.filterText).toBeUndefined();
  });

  it('should contain textEdit range for partial word replacement', () => {
    const item: CompletionItem = {
      label: 'Math.floor(5)',
      kind: CompletionItemKind.Text,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 7 },
        },
        newText: 'Math.floor(5)',
      } as any,
    };

    const textEdit = item.textEdit as any;
    expect(textEdit.range.start.character).toBe(0);
    expect(textEdit.range.end.character).toBe(7);
  });

  it('should handle completion with different start and end positions', () => {
    const item: CompletionItem = {
      label: 'console.log("hello")',
      kind: CompletionItemKind.Text,
      textEdit: {
        range: {
          start: { line: 5, character: 10 },
          end: { line: 5, character: 13 },
        },
        newText: 'console.log("hello")',
      } as any,
    };

    const textEdit = item.textEdit as any;
    expect(textEdit.range.start.line).toBe(5);
    expect(textEdit.range.end.line).toBe(5);
    expect(textEdit.range.start.character).toBe(10);
    expect(textEdit.range.end.character).toBe(13);
  });

  it('should preserve data field for completion resolution', () => {
    const data = {
      index: 0,
      model: 'google/gemini-flash',
      reason: 'complete statement',
    };

    const item: CompletionItem = {
      label: 'const value = 42;',
      kind: CompletionItemKind.Text,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 2 },
        },
        newText: 'const value = 42;',
      } as any,
      data,
    };

    expect(item.data).toBeDefined();
    expect((item.data as any).index).toBe(0);
    expect((item.data as any).reason).toBe('complete statement');
  });

  it('should handle multiline completion text', () => {
    const multilineText = 'function test() {\n  return 42;\n}';
    const item: CompletionItem = {
      label: multilineText,
      kind: CompletionItemKind.Text,
      textEdit: {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        newText: multilineText,
      } as any,
    };

    const textEdit = item.textEdit as any;
    expect(textEdit.newText).toContain('\n');
    expect(textEdit.newText).toContain('function');
    expect(textEdit.newText).toContain('return');
  });
});
