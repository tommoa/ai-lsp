/**
 * Tests for inline completion router
 *
 * Verifies that InlineCompletion.generate() correctly routes to Chat or FIM
 * based on the 'prompt' parameter and handles errors appropriately.
 */

import { describe, it, expect } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocumentPositionParams } from 'vscode-languageserver/node';
import { InlineCompletion } from '../src/inline-completion';
import { UnsupportedPromptError } from '../src/inline-completion/errors';
import { createMockModel } from './helpers/mock-model';

describe('InlineCompletion router', () => {
  const testDoc = TextDocument.create(
    'file:///test.ts',
    'typescript',
    1,
    'const x = hello',
  );

  const testPosition: TextDocumentPositionParams = {
    textDocument: { uri: 'file:///test.ts' },
    position: { line: 0, character: 10 },
  };

  it('should use Chat by default when prompt not specified', async () => {
    const chatResponse = JSON.stringify([
      { text: 'chat_completion', reason: 'contextual' },
    ]);
    const model = createMockModel({ response: chatResponse });
    const result = await InlineCompletion.generate({
      model,
      document: testDoc,
      position: testPosition,
    });

    expect(result.completions).not.toBeNull();
    expect(result.completions?.[0]?.text).toBe('chat_completion');
  });

  it('should route to Chat when prompt="chat"', async () => {
    const chatResponse = JSON.stringify([
      { text: 'chat_completion', reason: 'contextual' },
    ]);
    const model = createMockModel({ response: chatResponse });
    const result = await InlineCompletion.generate({
      model,
      document: testDoc,
      position: testPosition,
      prompt: InlineCompletion.PromptType.Chat,
    });

    expect(result.completions).not.toBeNull();
    expect(result.completions?.[0]?.text).toBe('chat_completion');
  });

  it('should route to FIM when prompt="fim"', async () => {
    const model = createMockModel({ response: ' fim_completion' });
    const result = await InlineCompletion.generate({
      model,
      document: testDoc,
      position: testPosition,
      prompt: InlineCompletion.PromptType.FIM,
      modelName: 'deepseek-coder',
    });

    expect(result.completions).not.toBeNull();
    expect(result.completions?.[0]?.text).toBe(' fim_completion');
  });

  it('should throw UnsupportedPromptError when FIM unsupported', async () => {
    const model = createMockModel({ throwError: true });

    try {
      await InlineCompletion.generate({
        model,
        document: testDoc,
        position: testPosition,
        prompt: InlineCompletion.PromptType.FIM,
        modelName: 'gpt-4',
      });
      expect.unreachable('Should have thrown UnsupportedPromptError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedPromptError);
      const typedErr = err as UnsupportedPromptError;
      expect(typedErr.prompt).toBe('fim');
      expect(typedErr.modelName).toBe('gpt-4');
    }
  });
});
