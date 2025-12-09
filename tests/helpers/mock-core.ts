/**
 * Shared mock provider implementation for all tests.
 *
 * This module provides the core mock language model implementation used by:
 * - Unit tests (direct import)
 * - E2E tests (via tests/fixtures/mock-provider/ NPM package wrapper)
 *
 * Features:
 * - Configurable text responses
 * - Error simulation for testing error handling
 * - Streaming support (doStream)
 * - Mock usage statistics
 * - Async delay simulation
 */

import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Usage,
} from '@ai-sdk/provider';

/**
 * Configuration options for creating a mock model
 */
export interface MockModelConfig {
  /**
   * Text response to return from the mock model.
   * This should be the exact text you want the model to return.
   * Typically this will be JSON-stringified data matching your expected
   * response format (inline completions, prefix/suffix edits, etc.)
   */
  response?: string;

  /**
   * If true or a string, throws an error from doGenerate/doStream.
   * If string, uses the string as the error message.
   * Useful for testing error handling.
   */
  throwError?: boolean | string;

  /**
   * Custom usage statistics to return.
   * If not provided, uses MOCK_USAGE defaults.
   */
  usage?: LanguageModelV2Usage;

  /**
   * Optional delay in milliseconds to simulate async behavior.
   * Useful for testing race conditions or timing-sensitive code.
   */
  delay?: number;
}

/**
 * Provider configuration options passed through initialization.
 * Used when creating a provider factory function for E2E tests.
 */
export interface ProviderArgs {
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
export const MOCK_USAGE: LanguageModelV2Usage = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
};

/**
 * Creates a mock language model instance with the specified configuration.
 *
 * This is the core implementation used by both unit tests (direct import)
 * and E2E tests (via provider factory).
 *
 * @param config Configuration options for customizing mock behavior
 * @returns A LanguageModelV2 instance that can be used with @ai-sdk
 *
 * @example
 * ```typescript
 * // Simple success case
 * const model = createMockModel({ response: '{"text": "completion"}' });
 *
 * // Error case
 * const errorModel = createMockModel({ throwError: true });
 *
 * // Custom error message
 * const customError = createMockModel({
 *   throwError: 'Custom error message'
 * });
 * ```
 */
export function createMockModel(config: MockModelConfig = {}): LanguageModelV2 {
  const { response = '', throwError = false, usage = MOCK_USAGE } = config;

  const errorMessage =
    typeof throwError === 'string'
      ? throwError
      : 'completion endpoint not implemented';

  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'test-model',
    supportedUrls: {},

    doGenerate(_options: LanguageModelV2CallOptions) {
      if (throwError) {
        throw new Error(errorMessage);
      }

      return Promise.resolve({
        content: [
          {
            type: 'text' as const,
            text: response,
          },
        ],
        finishReason: 'stop' as const,
        usage,
        warnings: [],
      });
    },
    // NOTE: We cast to LanguageModelV2 so that we don't need to implement
    // `doStream()` here.
  } as unknown as LanguageModelV2;
}

/**
 * Provider factory function for E2E tests.
 *
 * Returns a selector function that maps model IDs to LanguageModelV2
 * instances with the configured response.
 *
 * This is used by the E2E fixture package to create providers that can
 * be loaded via the NPM package system in integration tests.
 *
 * Configuration is passed through ProviderArgs:
 * - response: Required. The text to return from the provider.
 * - throwError: Optional. If true, throws errors from doGenerate/doStream
 *
 * @param args Configuration options for customizing mock responses
 * @returns A provider factory function
 *
 * @example
 * ```typescript
 * // In E2E fixture (tests/fixtures/mock-provider/index.ts):
 * export default createMockProvider;
 *
 * // In E2E test configuration:
 * {
 *   providers: {
 *     test1: {
 *       npm: 'ai-lsp-mock-provider',
 *       response: JSON.stringify([{ text: 'completion' }])
 *     }
 *   }
 * }
 * ```
 */
export function createMockProvider(
  args: ProviderArgs,
): (modelId: string) => LanguageModelV2 {
  const responseText = args.response;
  const shouldThrow = args.throwError ?? false;

  return function selectModel(modelId: string): LanguageModelV2 {
    const model = createMockModel({
      response: responseText,
      throwError: shouldThrow,
    });

    // Override modelId to match the requested one
    return {
      ...model,
      modelId,
    };
  };
}
