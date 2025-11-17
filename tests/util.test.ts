import { describe, it, expect } from 'bun:test';
import {
  extractTokenUsage,
  Parser,
  normalizeNewlines,
  clip,
  cleanFimResponse,
} from '../src/util';

describe('extractTokenUsage', () => {
  it('should extract basic token usage', () => {
    const res = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
    });
  });

  it('should extract token usage with reasoning tokens', () => {
    const res = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 25,
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
      reasoning: 25,
    });
  });

  it('should extract token usage with cached input tokens', () => {
    const res = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 30,
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
      cachedInput: 30,
    });
  });

  it('should extract token usage with both reasoning and cached tokens', () => {
    const res = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 25,
        cachedInputTokens: 30,
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
      reasoning: 25,
      cachedInput: 30,
    });
  });

  it('should ignore zero reasoning tokens', () => {
    const res = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
    });
  });

  it('should ignore zero cached input tokens', () => {
    const res = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
    });
  });

  it('should return null for invalid usage data', () => {
    expect(extractTokenUsage(null)).toBeNull();
    expect(extractTokenUsage(undefined)).toBeNull();
    expect(extractTokenUsage({})).toBeNull();
    expect(extractTokenUsage({ usage: {} })).toBeNull();
    expect(extractTokenUsage({ usage: { inputTokens: 'invalid' } })).toBeNull();
  });

  it('should handle usage in nested result property', () => {
    const res = {
      result: {
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      },
    };
    const usage = extractTokenUsage(res);
    expect(usage).toEqual({
      input: 100,
      output: 50,
    });
  });
});

describe('Parser.parseJSONObject', () => {
  it('should parse valid JSON object', () => {
    const json = '{"key": "value", "num": 42}';
    const result = Parser.parseJSONObject(json);
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  it('should extract JSON object from wrapped text', () => {
    const json = 'Here is the result: {"key": "value"} and some more text';
    const result = Parser.parseJSONObject(json);
    expect(result).toEqual({ key: 'value' });
  });

  it('should return null for invalid JSON', () => {
    const json = 'This is not JSON at all';
    const result = Parser.parseJSONObject(json);
    expect(result).toBeNull();
  });

  it('should return null when no braces found', () => {
    const json = 'No braces here';
    const result = Parser.parseJSONObject(json);
    expect(result).toBeNull();
  });

  it('should handle nested objects', () => {
    const json = '{"outer": {"inner": "value"}}';
    const result = Parser.parseJSONObject(json);
    expect(result).toEqual({ outer: { inner: 'value' } });
  });
});

describe('Parser.parseResponse', () => {
  it('should parse valid JSON array', () => {
    const json = '[{"a": 1}, {"b": 2}]';
    const result = Parser.parseResponse(json);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('should extract JSON array from wrapped text', () => {
    const json = 'Here is the array: [{"a": 1}] done';
    const result = Parser.parseResponse(json);
    expect(result).toEqual([{ a: 1 }]);
  });

  it('should throw on non-array JSON', () => {
    const json = '{"key": "value"}';
    expect(() => Parser.parseResponse(json)).toThrow('not an array');
  });

  it('should throw on invalid JSON', () => {
    const json = 'This is not JSON';
    expect(() => Parser.parseResponse(json)).toThrow('not an array');
  });

  it('should throw when no brackets found', () => {
    const json = 'No brackets here';
    expect(() => Parser.parseResponse(json)).toThrow('not an array');
  });

  it('should handle empty array', () => {
    const json = '[]';
    const result = Parser.parseResponse(json);
    expect(result).toEqual([]);
  });
});

describe('normalizeNewlines', () => {
  it('should normalize CRLF to LF', () => {
    expect(normalizeNewlines('line1\r\nline2\r\nline3')).toBe(
      'line1\nline2\nline3',
    );
  });

  it('should normalize CR to LF', () => {
    expect(normalizeNewlines('line1\rline2\rline3')).toBe(
      'line1\nline2\nline3',
    );
  });

  it('should leave LF unchanged', () => {
    expect(normalizeNewlines('line1\nline2\nline3')).toBe(
      'line1\nline2\nline3',
    );
  });

  it('should handle mixed newlines', () => {
    expect(normalizeNewlines('line1\r\nline2\nline3\rline4')).toBe(
      'line1\nline2\nline3\nline4',
    );
  });
});

describe('clip', () => {
  it('should return original string if shorter than limit', () => {
    expect(clip('short', 10)).toBe('short');
  });

  it('should clip long strings to default 200 chars', () => {
    const long = 'a'.repeat(300);
    const result = clip(long);
    expect(result).toBe('a'.repeat(200) + '...');
  });

  it('should clip to custom length', () => {
    const long = 'a'.repeat(100);
    const result = clip(long, 50);
    expect(result).toBe('a'.repeat(50) + '...');
  });

  it('should handle exact length match', () => {
    const text = 'a'.repeat(200);
    const result = clip(text, 200);
    expect(result).toBe(text);
  });
});

describe('cleanFimResponse', () => {
  it('should remove markdown fences', () => {
    const text = '```javascript\nconst x = 1;\n```';
    expect(cleanFimResponse(text, '')).toBe('const x = 1;');
  });

  it('should remove incomplete markdown fences', () => {
    const text = '```javascript\nconst x = 1;';
    expect(cleanFimResponse(text, '')).toBe('const x = 1;');
  });

  it('should remove echoed prefix', () => {
    const text = 'const x = 1;\nconst y = 2;';
    const prefix = 'const x = 1;\n';
    expect(cleanFimResponse(text, prefix)).toBe('const y = 2;');
  });

  it('should remove both fences and prefix', () => {
    const text = '```javascript\nconst x = 1;\nconst y = 2;\n```';
    const prefix = 'const x = 1;\n';
    expect(cleanFimResponse(text, prefix)).toBe('const y = 2;');
  });

  it('should handle empty prefix', () => {
    const text = 'const x = 1;';
    expect(cleanFimResponse(text, '')).toBe('const x = 1;');
  });

  it('should not remove prefix if it appears mid-response', () => {
    const text = 'const y = 2;\nconst x = 1;';
    const prefix = 'const x = 1;';
    expect(cleanFimResponse(text, prefix)).toBe('const y = 2;\nconst x = 1;');
  });
});
