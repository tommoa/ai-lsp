import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';

/**
 * Provider configuration options passed through initialization
 */
interface ProviderArgs {
  /**
   * Text response to return from the mock provider.
   * This should be the exact text you want the provider to return.
   * Typically this will be JSON-stringified data matching your expected
   * response format (inline completions, prefix/suffix edits, etc.)
   */
  response: string;
  /**
   * If true or a string, throws an error from doGenerate/doStream.
   * If string, uses the string as the error message.
   * Useful for testing error handling.
   */
  throwError?: boolean | string;
}

/**
 * Standard mock usage data
 */
const MOCK_USAGE: LanguageModelV2Usage = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
};

/**
 * Provider factory function.
 *
 * Returns a selector function that maps model IDs to LanguageModelV2
 * instances with the configured response.
 *
 * Configuration is passed through ProviderArgs:
 * - response: Required. The text to return from the provider.
 * - throwError: Optional. If true, throws errors from doGenerate/doStream
 *
 * @param args Configuration options for customizing mock responses
 */
export default function createMockProvider(
  args: ProviderArgs,
): (modelId: string) => LanguageModelV2 {
  const responseText = args.response;
  const shouldThrow = args.throwError ?? false;
  const errorMessage =
    typeof shouldThrow === 'string' ? shouldThrow : 'Mock provider error';

  return function selectModel(modelId: string): LanguageModelV2 {
    return {
      specificationVersion: 'v2' as const,
      provider: 'mock',
      modelId,
      supportedUrls: {},

      async doGenerate(_options: LanguageModelV2CallOptions) {
        if (shouldThrow) {
          throw new Error(errorMessage);
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: responseText,
            },
          ],
          finishReason: 'stop' as const,
          usage: MOCK_USAGE,
          warnings: [],
        };
      },

      async doStream(_options: LanguageModelV2CallOptions) {
        if (shouldThrow) {
          throw new Error(errorMessage);
        }

        const stream = new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            const id = Math.random().toString(36).substring(7);

            controller.enqueue({
              type: 'text-start' as const,
              id,
            });

            controller.enqueue({
              type: 'text-delta' as const,
              id,
              delta: responseText,
            });

            controller.enqueue({
              type: 'text-end' as const,
              id,
            });

            controller.enqueue({
              type: 'finish' as const,
              finishReason: 'stop' as const,
              usage: MOCK_USAGE,
            });

            controller.close();
          },
        });

        return { stream, warnings: [] };
      },
    };
  };
}
