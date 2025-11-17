import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { LSPTestClient } from './helpers/lsp-test-client';
import { createTestClient } from './helpers/lsp-test-client';
import { pos, setupTestDocument } from './helpers/test-utils';
import { mockResponses } from '../helpers/mock-responses';

describe('E2E: Inline Completion with FIM', () => {
  let client: LSPTestClient;

  beforeEach(async () => {
    client = createTestClient({
      debug: false,
      timeout: 10000,
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  it('should return completions using FIM prompt', async () => {
    await client.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: mockResponses.fim(),
          },
        },
        model: 'mock/deepseek-coder',
        inline_completion: {
          prompt: 'fim',
        },
      },
    });

    const uri = await setupTestDocument(client, 'const x = ');

    const completions = await client.requestCompletion(uri, pos(0, 10));

    expect(completions).toBeArray();
    expect(completions.length).toBeGreaterThan(0);

    // FIM returns raw text completion
    const firstCompletion = completions[0]!;
    expect(firstCompletion.label).toBeDefined();
    expect(firstCompletion.label).toContain('complete_text');
  });

  it('should switch between chat and FIM prompts via config', async () => {
    // Start with chat prompt
    await client.start({
      initializationOptions: {
        providers: {
          mock: {
            npm: 'ai-lsp-mock-provider',
            response: JSON.stringify([
              { text: 'chat_completion', reason: 'chat' },
            ]),
          },
        },
        model: 'mock/deepseek-coder',
        inline_completion: {
          prompt: 'chat',
        },
      },
    });

    const uri = await setupTestDocument(client, 'const x = ');

    // Get completion with chat prompt
    const chatCompletions = await client.requestCompletion(uri, pos(0, 10));
    expect(chatCompletions).toBeArray();
    expect(chatCompletions.length).toBeGreaterThan(0);

    // Change configuration to FIM prompt
    await client.changeConfiguration({
      providers: {
        mock: {
          npm: 'ai-lsp-mock-provider',
          response: 'fim_completion',
        },
      },
      model: 'mock/deepseek-coder',
      inline_completion: {
        prompt: 'fim',
      },
    });

    // Wait for config to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get completion with FIM prompt
    const fimCompletions = await client.requestCompletion(uri, pos(0, 10));
    expect(fimCompletions).toBeArray();
    expect(fimCompletions.length).toBeGreaterThan(0);
  });
});
