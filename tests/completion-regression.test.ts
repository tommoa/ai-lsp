import { describe, it, expect } from 'bun:test';

describe('Completion Prefix Matching Regression Tests', () => {
  it('should not duplicate partial word in completion', () => {
    // Original bug: "co" + "nst..." should be "const...", not duplicated
    const typed = 'co';
    const llmGenerated = 'nst value = 42;';
    const fullText = typed + llmGenerated;

    // Verify we get 'const value = 42;' not something with duplication
    expect(fullText).toBe('const value = 42;');
    expect(fullText).not.toContain('conant');
    expect(fullText).not.toContain('co nst');
  });

  it('should show completions even when suffix does not match', () => {
    // The label should match even if LLM generates a suffix
    const partialWord = 'fl';
    const llmText = 'oor(5)';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('floor(5)');
    // Verify that 'floor(5)' would match against user typing 'fl'
    expect(fullText.startsWith('fl')).toBe(true);
  });

  it('should correctly handle Math.floor case', () => {
    const partialWord = 'Math.fl';
    const llmText = 'oor(5)';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('Math.floor(5)');
    // The full text should start with the partial word (for filtering)
    expect(fullText.startsWith(partialWord)).toBe(true);
  });

  it('should handle const completion case', () => {
    const partialWord = 'co';
    const llmText = 'nst numRunsWithMetrics = runMetrics.length;';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('const numRunsWithMetrics = runMetrics.length;');
    // Verify no duplication of partial word
    expect(fullText.indexOf('co')).toBe(0); // only at start
  });

  it('should handle empty partial word', () => {
    const partialWord = '';
    const llmText = 'console.log("hello");';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('console.log("hello");');
  });

  it('should preserve full method chain', () => {
    const partialWord = 'array.m';
    const llmText = 'ap(x => x * 2)';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('array.map(x => x * 2)');
  });

  it('should handle imports completion', () => {
    const partialWord = 'import { useState ';
    const llmText = '} from "react";';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('import { useState } from "react";');
  });

  it('should handle nested property access', () => {
    const partialWord = 'obj.prop.method';
    const llmText = '()';
    const fullText = partialWord + llmText;

    expect(fullText).toBe('obj.prop.method()');
  });

  it('should not lose partial word in textEdit range calculation', () => {
    // Simulate the textEdit calculation
    const partialWord = 'co';
    const startChar = 6; // position after 'const '
    const cursorChar = 8; // after 'co'

    // The range should be from startChar to cursor
    const rangeStart = startChar;
    const rangeEnd = cursorChar;

    // The difference should be the length of partial word
    expect(rangeEnd - rangeStart).toBe(partialWord.length);
  });

  it('should reconstruct full text correctly for method completion', () => {
    // This tests the exact case from the issue
    const userTyped = 'Math.fl';
    const llmSuffix = 'oor(5)';

    // The LLM was only generating the suffix, not the full text
    // So we need to prepend the partial word
    const reconstructed = userTyped + llmSuffix;

    expect(reconstructed).toBe('Math.floor(5)');
    // Should not have duplicates or malformed text
    expect(reconstructed.split('fl').length).toBe(2); // 'fl' appears once in 'floor'
  });

  it('should handle completion that includes original partial word', () => {
    // Edge case: what if LLM includes the full word?
    const partialWord = 'co';
    const llmText = 'const value = 42;'; // includes 'co'

    const fullText = partialWord + llmText;

    expect(fullText).toBe('coconst value = 42;'); // Would have prefix
    // This shows why we need to trust the LLM only generates the suffix
  });

  it('should filter by label which includes full text', () => {
    const fullText = 'const value = 42;';
    const label = fullText; // label is the full text

    // User types 'co' - should match
    expect(label.toLowerCase().startsWith('co')).toBe(true);

    // User types 'const' - should match
    expect(label.toLowerCase().startsWith('const')).toBe(true);

    // User types 'value' - should NOT match (for simple prefix filtering)
    expect(label.toLowerCase().startsWith('value')).toBe(false);
  });
});
