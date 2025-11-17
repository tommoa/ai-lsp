/**
 * Mock provider fixture for E2E tests.
 *
 * This is an NPM package wrapper that re-exports the shared mock-core
 * implementation. E2E tests load this as 'ai-lsp-mock-provider'.
 *
 * All implementation logic lives in tests/helpers/mock-core.ts.
 */

import { createMockProvider } from '../../helpers/mock-core';

// Re-export everything from the shared core
export default createMockProvider;
export const createMock = createMockProvider;
export type { ProviderArgs, MockModelConfig } from '../../helpers/mock-core';
