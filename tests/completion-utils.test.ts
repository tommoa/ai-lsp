import { describe, it, expect } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver/node';
import { extractPartialWord } from '../src/completion-utils';
import { cleanFimResponse } from '../src/util';

/**
 * Helper to create test documents with less boilerplate.
 */
function createTestDoc(content: string, language = 'typescript'): TextDocument {
  return TextDocument.create('file:///test.ts', language, 1, content);
}

describe('extractPartialWord', () => {
  it('should extract partial identifier at cursor', () => {
    const doc = createTestDoc('const myVariable');
    const position: Position = { line: 0, character: 16 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('myVariable');
    expect(result.startChar).toBe(6);
  });

  it('should extract partial method call', () => {
    const doc = createTestDoc('Math.fl', 'javascript');
    const position: Position = { line: 0, character: 7 }; // after 'fl'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('Math.fl');
    expect(result.startChar).toBe(0);
  });

  it('should return empty string when no partial word', () => {
    const doc = createTestDoc('const x = ');
    const position: Position = { line: 0, character: 10 }; // after space

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('');
  });

  it('should handle cursor at beginning of line', () => {
    const doc = createTestDoc('hello');
    const position: Position = { line: 0, character: 0 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('');
    expect(result.startChar).toBe(0);
  });

  it('should extract the entire identifier including dots', () => {
    const doc = createTestDoc('foo.bar.baz', 'javascript');
    const position: Position = { line: 0, character: 11 }; // after 'baz'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('foo.bar.baz');
  });

  it('should handle multiline documents correctly', () => {
    const doc = createTestDoc('const x = 5;\nconst co');
    const position: Position = { line: 1, character: 8 }; // line 2, after 'co'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('co');
    expect(result.startChar).toBe(6); // after 'const '
  });

  it('should extract single character identifier', () => {
    const doc = createTestDoc('const x');
    const position: Position = { line: 0, character: 7 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('x');
    expect(result.startChar).toBe(6);
  });

  it('should not include spaces in partial word', () => {
    const doc = createTestDoc('function hello');
    const position: Position = { line: 0, character: 14 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('hello');
  });

  it('should handle underscores in identifier', () => {
    const doc = createTestDoc('const my_var');
    const position: Position = { line: 0, character: 12 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('my_var');
  });

  it('should handle identifiers with numbers', () => {
    const doc = createTestDoc('const var123');
    const position: Position = { line: 0, character: 12 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('var123');
    expect(result.startChar).toBe(6);
  });

  it('should handle cursor immediately after dot', () => {
    const doc = createTestDoc('Math.');
    const position: Position = { line: 0, character: 5 }; // after 'Math.'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('Math.');
    expect(result.startChar).toBe(0);
  });
});

describe('cleanFimResponse', () => {
  it('should remove echoed prefix from response', () => {
    const prefix = "const msg = '";
    const response = "const msg = 'Hello, world!';";
    const result = cleanFimResponse(response, prefix);
    expect(result).toBe("Hello, world!';");
  });

  it('should only strip markdown if no prefix match', () => {
    const prefix = 'y = ';
    const response = '```python\nx = 42\n```';
    const result = cleanFimResponse(response, prefix);
    expect(result).toBe('x = 42');
  });

  it('should handle multiline prefix removal', () => {
    const prefix = 'function test() {\n  return ';
    const response = 'function test() {\n  return 42;\n}';
    const result = cleanFimResponse(response, prefix);
    expect(result).toBe('42;\n}');
  });

  it('should handle markdown with language and echoed prefix', () => {
    const prefix = 'import ';
    const response = '```typescript\nimport { useState } from "react";\n```';
    const result = cleanFimResponse(response, prefix);
    expect(result).toBe('{ useState } from "react";');
  });

  it('should handle prefix with special chars', () => {
    const prefix = 'const x = /(test)/';
    const response = 'const x = /(test)/ && value';
    const result = cleanFimResponse(response, prefix);
    expect(result).toBe(' && value');
  });

  it('should not remove prefix when it appears mid-response', () => {
    const prefix = 'const x = ';
    const response = 'some code\nconst x = 42';
    const result = cleanFimResponse(response, prefix);
    // Should NOT remove the 'const x = ' from line 2
    expect(result).toBe('some code\nconst x = 42');
  });

  it('should handle incomplete markdown fence with echoed prefix', () => {
    const prefix = 'function calculate() {\n  return ';
    const response = '```javascript\nfunction calculate() {\n  return 42;\n}';
    const result = cleanFimResponse(response, prefix);
    expect(result).toBe('42;\n}');
  });
});
