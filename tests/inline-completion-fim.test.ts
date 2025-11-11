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
import { UnsupportedPromptError } from '../src/inline-completion/errors';
import { NOOP_LOG } from '../src/util';

/**
 * Create a mock language model that returns specified completion text
 */
function createMockFimModel(completionText: string) {
  const mockModel = {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'test-fim-model',
    supportedUrls: {},

    async doGenerate() {
      return {
        content: [
          {
            type: 'text' as const,
            text: completionText,
          },
        ],
        finishReason: 'stop' as const,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        warnings: [],
      };
    },

    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          const id = Math.random().toString(36).substring(7);
          controller.enqueue({
            type: 'text-start' as const,
            id,
          });
          controller.enqueue({
            type: 'text-delta' as const,
            id,
            delta: completionText,
          });
          controller.enqueue({
            type: 'text-end' as const,
            id,
          });
          controller.enqueue({
            type: 'finish' as const,
            finishReason: 'stop' as const,
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
            },
          });
          controller.close();
        },
      });
      return { stream, warnings: [] };
    },
  } as any;

  return mockModel;
}

/**
 * Create a mock model that throws an unsupported error
 */
function createUnsupportedModel() {
  const mockModel = {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'unsupported-model',
    supportedUrls: {},

    async doGenerate() {
      throw new Error('completion endpoint not implemented for this model');
    },

    async doStream() {
      throw new Error('Streaming not supported');
    },
  } as any;

  return mockModel;
}

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

      const model = createMockFimModel(' sum');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'deepseek-coder',
        maxTokens: 256,
      });

      expect(result.completions).not.toBeNull();
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

      const model = createMockFimModel('pass');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'codellama-34b',
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

      const model = createMockFimModel(' b;');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'qwen-coder',
      });

      expect(result.completions).not.toBeNull();
      expect(result.completions![0]!.text).toBe(' b;');
    });
  });

  describe('empty and edge case responses', () => {
    it('should return null completions for empty response', async () => {
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

      const model = createMockFimModel('');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'starcoder',
      });

      expect(result.completions).toBeNull();
    });

    it('should return null for whitespace-only response', async () => {
      const doc = TextDocument.create('file:///test.py', 'python', 1, 'x = y');
      const position: TextDocumentPositionParams = {
        textDocument: { uri: 'file:///test.py' },
        position: { line: 0, character: 4 },
      };

      const model = createMockFimModel('   \n\t  ');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'codellama',
      });

      expect(result.completions).toBeNull();
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

      const model = createMockFimModel('// comment\n');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'deepseek-coder',
      });

      expect(result.completions).not.toBeNull();
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

      const model = createMockFimModel('');
      const result = await FIM.generate({
        model,
        document: doc,
        position,
        log: NOOP_LOG,
        modelName: 'qwen-coder',
      });

      expect(result.completions).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should throw UnsupportedPromptError for errors', async () => {
      const errorPatterns = [
        {
          name: 'generic unsupported model',
          error: 'completion endpoint not implemented for this model',
          modelName: 'gpt-4-turbo',
        },
        {
          name: 'endpoint not found',
          error: '404: endpoint not found',
          modelName: 'claude-3',
        },
        {
          name: 'does not support pattern',
          error: 'Model does not support completion',
          modelName: 'claude-opus',
        },
      ];

      for (const pattern of errorPatterns) {
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
            throw new Error(pattern.error);
          },
          async doStream() {
            throw new Error(pattern.error);
          },
        } as any;

        try {
          await FIM.generate({
            model: badModel,
            document: doc,
            position,
            modelName: pattern.modelName,
          });
          expect.unreachable(
            `Should have thrown UnsupportedPromptError for: ${pattern.name}`,
          );
        } catch (err) {
          expect(err).toBeInstanceOf(UnsupportedPromptError);
          const typedErr = err as UnsupportedPromptError;
          expect(typedErr.prompt).toBe('fim');
        }
      }
    });
  });
});
