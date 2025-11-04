import { describe, it, expect } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver/node';
import { extractPartialWord } from '../src/completion-utils';

describe('extractPartialWord', () => {
  it('should extract partial identifier at cursor', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const co',
    );
    const position: Position = { line: 0, character: 8 }; // after 'co'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('co');
    expect(result.startChar).toBe(6); // after 'const '
  });

  it('should extract partial method call', () => {
    const doc = TextDocument.create(
      'file:///test.js',
      'javascript',
      1,
      'Math.fl',
    );
    const position: Position = { line: 0, character: 7 }; // after 'fl'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('Math.fl');
    expect(result.startChar).toBe(0);
  });

  it('should return empty string when no partial word', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const x = ',
    );
    const position: Position = { line: 0, character: 10 }; // after space

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('');
  });

  it('should handle cursor at beginning of line', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'hello',
    );
    const position: Position = { line: 0, character: 0 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('');
    expect(result.startChar).toBe(0);
  });

  it('should extract the entire identifier including dots', () => {
    const doc = TextDocument.create(
      'file:///test.js',
      'javascript',
      1,
      'foo.bar.baz',
    );
    const position: Position = { line: 0, character: 11 }; // after 'baz'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('foo.bar.baz');
  });

  it('should handle multiline documents correctly', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const x = 5;\nconst co',
    );
    const position: Position = { line: 1, character: 8 }; // line 2, after 'co'

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('co');
    expect(result.startChar).toBe(6); // after 'const '
  });

  it('should extract single character identifier', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const x',
    );
    const position: Position = { line: 0, character: 7 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('x');
    expect(result.startChar).toBe(6);
  });

  it('should not include spaces in partial word', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'function hello',
    );
    const position: Position = { line: 0, character: 14 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('hello');
  });

  it('should handle underscores in identifier', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const my_var',
    );
    const position: Position = { line: 0, character: 12 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('my_var');
  });

  it('should handle camelCase identifiers', () => {
    const doc = TextDocument.create(
      'file:///test.ts',
      'typescript',
      1,
      'const myVariable',
    );
    const position: Position = { line: 0, character: 16 };

    const result = extractPartialWord(doc, position);
    expect(result.partial).toBe('myVariable');
  });
});
