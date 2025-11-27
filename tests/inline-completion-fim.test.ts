/**
 * Unit tests for FIM (Fill-in-the-Middle) based inline completion
 *
 * Tests the core FIM.generate() function with mock models.
 * Covers:
 * - Basic FIM completion generation
 * - Error handling (unsupported models, empty responses)
 * - Token usage tracking
 * - Edge cases (empty/whitespace responses, cursor positions)
 */

import { describe, it, expect } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';
import { FIM } from '../src/inline-completion/fim';
import { InlineCompletion } from '../src/inline-completion';
import { UnsupportedPromptError } from '../src/inline-completion/errors';
import {
  BUILTIN_FIM_TEMPLATES,
  type FimTemplate,
} from '../src/inline-completion/fim-formats';
import { NOOP_LOG } from '../src/util';
import { createMockModel } from './helpers/mock-core';
import { mockResponses } from './helpers/mock-responses';

describe('FIM.generate', () => {
  describe('basic completion generation', () => {
    it('should generate completion from prefix and suffix', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const x = hello + world',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 13 }, // after 'hello + '
      };

      const model = createMockModel({ response: ' sum' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['deepseek']!,
        maxTokens: 256,
      });

      expect(result.completions).not.toBeEmpty();
      expect(result.completions![0]!.text).toBe(' sum');
      expect(result.completions![0]!.reason).toBe('fim');
    });

    it('should include token usage in result', async () => {
      const doc = TextDocument.create(
        'file:///test.py',
        'python',
        1,
        'def hello():\n    print("hi")',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.py' },
        position: { line: 0, character: 11 },
      };

      const model = createMockModel({ response: 'pass' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['codellama']!,
      });

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.input).toBe(100);
      expect(result.tokenUsage!.output).toBe(50);
    });

    it('should handle multiline prefix and suffix', async () => {
      const code = `function add(a, b) {
    return a +
  }`;

      const doc = TextDocument.create('file:///test.js', 'javascript', 1, code);
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.js' },
        position: { line: 1, character: 12 }, // after 'a +'
      };

      const model = createMockModel({ response: ' b;' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['qwen']!,
      });

      expect(result.completions).not.toBeEmpty();
      expect(result.completions![0]!.text).toBe(' b;');
    });
  });

  describe('empty and edge case responses', () => {
    it('should return empty completions for empty response', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const a = b',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 10 },
      };

      const model = createMockModel({ response: mockResponses.empty() });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['openai']!,
      });

      expect(result.completions).toBeEmpty();
    });

    it('should return empty for whitespace-only response', async () => {
      const doc = TextDocument.create('file:///test.py', 'python', 1, 'x = y');
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.py' },
        position: { line: 0, character: 4 },
      };

      const model = createMockModel({ response: '   \n\t  ' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['codellama']!,
      });

      expect(result.completions).toBeEmpty();
    });

    it('should handle cursor at beginning of file', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const x = 5;',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      };

      const model = createMockModel({ response: '// comment\n' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['deepseek']!,
      });

      expect(result.completions).not.toBeEmpty();
      expect(result.completions?.[0]!.text).toBe('// comment\n');
    });

    it('should handle cursor at end of file', async () => {
      const doc = TextDocument.create(
        'file:///test.js',
        'javascript',
        1,
        'function test() {\n  return 42;\n}',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.js' },
        position: { line: 2, character: 1 }, // after '}'
      };

      const model = createMockModel({ response: mockResponses.empty() });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['qwen']!,
      });

      expect(result.completions).toBeEmpty();
    });
  });

  describe('error handling', () => {
    it('should throw UnsupportedPromptError on unsupported model', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const x = ',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 10 },
      };

      const badModel = {
        specificationVersion: 'v2' as const,
        provider: 'mock',
        modelId: 'test',
        supportedUrls: {},
        async doGenerate() {
          throw new Error('completion endpoint not implemented for this model');
        },
        async doStream() {
          throw new Error('completion endpoint not implemented for this model');
        },
      } as any;

      try {
        await FIM.generate({
          prompt: 'fim',
          model: badModel,
          document: doc,
          position,
          fimFormat: BUILTIN_FIM_TEMPLATES['openai']!,
          log: NOOP_LOG,
        });
        expect.unreachable('Should have thrown UnsupportedPromptError');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedPromptError);
        const typedErr = err as UnsupportedPromptError;
        expect(typedErr.prompt).toBe('fim');
      }
    });

    it('should re-throw non-FIM errors', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const x = ',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 10 },
      };

      const errorModel = {
        specificationVersion: 'v2' as const,
        provider: 'mock',
        modelId: 'test',
        supportedUrls: {},
        async doGenerate() {
          throw new Error('Network timeout occurred');
        },
        async doStream() {
          throw new Error('Network timeout occurred');
        },
      } as any;

      try {
        await FIM.generate({
          prompt: 'fim',
          model: errorModel,
          document: doc,
          position,
          fimFormat: BUILTIN_FIM_TEMPLATES['openai']!,
          log: NOOP_LOG,
        });
        expect.unreachable('Should have thrown error');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(String(err)).toContain('Network timeout');
      }
    });
  });

  describe('custom FIM templates', () => {
    it('should work with custom template definition', async () => {
      const doc = TextDocument.create(
        'file:///test.rs',
        'rust',
        1,
        'fn main() { println!() }',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.rs' },
        position: { line: 0, character: 20 }, // inside println!()
      };

      const customTemplate: FimTemplate = {
        name: 'Custom Rust Format',
        template: '[PREFIX]${prefix}[SUFFIX]${suffix}[INFILL]',
        stop: ['[SUFFIX]', '[PREFIX]', '\n\n'],
      };

      const model = createMockModel({ response: '"Hello, world!"' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: customTemplate,
      });

      expect(result.completions).not.toBeEmpty();
      expect(result.completions![0]!.text).toBe('"Hello, world!"');
    });

    it('should use custom template defaults', async () => {
      const doc = TextDocument.create('file:///test.py', 'python', 1, 'x = ');
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.py' },
        position: { line: 0, character: 4 },
      };

      const customTemplate: FimTemplate = {
        name: 'Template With Metadata',
        template: '<lang:${language}>${prefix}<|FILL|>${suffix}',
        stop: ['<|FILL|>'],
        defaults: {
          language: 'python',
        },
      };

      const model = createMockModel({ response: '42' });
      const result = await FIM.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: customTemplate,
      });

      expect(result.completions).not.toBeEmpty();
      expect(result.completions![0]!.text).toBe('42');
    });
  });

  describe('InlineCompletion routing to FIM', () => {
    it('should route to FIM when prompt="fim"', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const x = hello',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 10 },
      };

      const model = createMockModel({ response: ' fim_completion' });
      const result = await InlineCompletion.generate({
        prompt: 'fim',
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        fimFormat: BUILTIN_FIM_TEMPLATES['deepseek']!,
      });

      expect(result.completions).not.toBeEmpty();
      expect(result.completions?.[0]?.text).toBe(' fim_completion');
    });

    it('should throw UnsupportedPromptError when FIM unsupported', async () => {
      const doc = TextDocument.create(
        'file:///test.ts',
        'typescript',
        1,
        'const x = hello',
      );
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 10 },
      };

      const badModel = {
        specificationVersion: 'v2' as const,
        provider: 'mock',
        modelId: 'test',
        supportedUrls: {},
        async doGenerate() {
          throw new Error('completion endpoint not implemented');
        },
        async doStream() {
          throw new Error('completion endpoint not implemented');
        },
      } as any;

      try {
        await InlineCompletion.generate({
          prompt: 'fim',
          model: badModel,
          document: doc,
          position,
          log: NOOP_LOG,
          fimFormat: BUILTIN_FIM_TEMPLATES['openai']!,
        });
        expect.unreachable('Should have thrown UnsupportedPromptError');
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedPromptError);
        const typedErr = err as UnsupportedPromptError;
        expect(typedErr.prompt).toBe('fim');
      }
    });
  });
});
