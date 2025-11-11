/**
 * Shared mock model creation for tests
 */

export interface MockModelConfig {
  response?: string;
  throwError?: boolean;
}

/**
 * Create a mock language model that returns specified text
 */
export function createMockModel(config: MockModelConfig = {}): any {
  const { response = '', throwError = false } = config;

  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'test-model',
    supportedUrls: {},

    async doGenerate() {
      if (throwError) {
        throw new Error('completion endpoint not implemented');
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response,
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
      if (throwError) {
        throw new Error('completion endpoint not implemented');
      }
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
            delta: response,
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
  };
}
