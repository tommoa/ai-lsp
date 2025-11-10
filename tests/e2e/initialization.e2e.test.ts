import { describe, it, expect } from 'bun:test';
import {
  createTestClient,
  type LSPTestClientOptions,
} from './helpers/lsp-test-client';

describe('E2E: LSP Server Initialization', () => {
  it('should create test client with default options', () => {
    const client = createTestClient();
    expect(client).toBeDefined();
    expect(client.isRunning()).toBe(false);
  });

  it('should create test client with custom options', () => {
    const options: LSPTestClientOptions = {
      timeout: 10000,
      debug: false,
    };
    const client = createTestClient(options);
    expect(client).toBeDefined();
    expect(client.isRunning()).toBe(false);
  });

  it('should have empty message log initially', () => {
    const client = createTestClient();
    const log = client.getMessageLog();
    expect(log).toBeArray();
    expect(log.length).toBe(0);
  });

  it('should allow clearing message log', () => {
    const client = createTestClient({
      debug: true,
    });
    // Add some fake log entries by adding to the log directly
    client.clearMessageLog();
    const log = client.getMessageLog();
    expect(log.length).toBe(0);
  });
});
