import { describe, test, expect } from 'bun:test';
import {
  detectFimFormat,
  buildFimPrompt,
  buildFimStopSequences,
  FIM_FORMATS,
  type FimFormat,
} from '../src/inline-completion/fim-formats';

describe('FIM Token Formats', () => {
  describe('detectFimFormat', () => {
    test('detects CodeLlama models', () => {
      expect(detectFimFormat('codellama-7b')).toBe('codellama');
      expect(detectFimFormat('CodeLlama-13B-Instruct')).toBe('codellama');
      expect(detectFimFormat('codellama-34b')).toBe('codellama');
    });

    test('detects Qwen models', () => {
      expect(detectFimFormat('qwen-coder-1.5b')).toBe('qwen');
      expect(detectFimFormat('Qwen2.5-Coder-7B')).toBe('qwen');
      expect(detectFimFormat('qwen-32b')).toBe('qwen');
    });

    test('detects StarCoder models', () => {
      expect(detectFimFormat('starcoder-7b')).toBe('starcoder');
      expect(detectFimFormat('StarCoder2-3b')).toBe('starcoder');
    });

    test('defaults to openai for unknown models', () => {
      expect(detectFimFormat('deepseek-coder-6.7b')).toBe('openai');
      expect(detectFimFormat('unknown-model')).toBe('openai');
      expect(detectFimFormat('gpt-4')).toBe('openai');
    });

    test('handles case-insensitive detection', () => {
      expect(detectFimFormat('CODELLAMA-7B')).toBe('codellama');
      expect(detectFimFormat('qWEN-coder')).toBe('qwen');
      expect(detectFimFormat('StarCoder-7B')).toBe('starcoder');
    });
  });

  describe('buildFimPrompt', () => {
    test('builds openai format prompt', () => {
      const prompt = buildFimPrompt('const x = ', ';', 'openai');
      expect(prompt).toBe(
        '<fim_prefix>const x = <fim_suffix>;<fim_middle>'
      );
    });

    test('builds codellama format prompt', () => {
      const prompt = buildFimPrompt('def foo(', '):', 'codellama');
      expect(prompt).toBe('<PRE>def foo(<SUF>):<MID>');
    });

    test('builds qwen format prompt', () => {
      const prompt = buildFimPrompt('x = ', '\n', 'qwen');
      expect(prompt).toBe('<|fim_prefix|>x = <|fim_suffix|>\n<|fim_middle|>');
    });

    test('builds starcoder format prompt', () => {
      const prompt = buildFimPrompt('if (', ')', 'starcoder');
      expect(prompt).toBe('<fim_prefix>if (<fim_suffix>)<fim_middle>');
    });

    test('uses openai format by default', () => {
      const prompt = buildFimPrompt('a', 'b');
      expect(prompt).toBe('<fim_prefix>a<fim_suffix>b<fim_middle>');
    });

    test('handles empty prefix and suffix', () => {
      const prompt = buildFimPrompt('', '', 'openai');
      expect(prompt).toBe('<fim_prefix><fim_suffix><fim_middle>');
    });

    test('handles multiline content', () => {
      const prefix = 'function add(a, b) {\n  return ';
      const suffix = ';\n}';
      const prompt = buildFimPrompt(prefix, suffix, 'openai');
      expect(prompt).toContain('<fim_prefix>function add');
      expect(prompt).toContain('return <fim_suffix>');
      expect(prompt).toContain('<fim_middle>');
      // Verify structure: prefix -> tokens -> suffix -> middle
      // Use dotAll flag to match newlines
      expect(prompt).toMatch(
        /<fim_prefix>.*<fim_suffix>.*<fim_middle>/s,
      );
    });
  });

  describe('buildFimStopSequences', () => {
    test('includes format tokens', () => {
      const stops = buildFimStopSequences('openai');
      expect(stops).toContain('<fim_suffix>');
      expect(stops).toContain('<fim_prefix>');
    });

    test('includes double newline', () => {
      const stops = buildFimStopSequences('openai');
      expect(stops).toContain('\n\n');
    });

    test('handles codellama format', () => {
      const stops = buildFimStopSequences('codellama');
      expect(stops).toContain('<SUF>');
      expect(stops).toContain('<PRE>');
      expect(stops).toContain('\n\n');
    });

    test('handles qwen format', () => {
      const stops = buildFimStopSequences('qwen');
      expect(stops).toContain('<|fim_suffix|>');
      expect(stops).toContain('<|fim_prefix|>');
      expect(stops).toContain('\n\n');
    });

    test('adds suffix hint if provided', () => {
      // Need > 3 chars for hint to be added
      const stops = buildFimStopSequences('openai', 'return;');
      expect(stops).toContain('return;');
    });

    test('trims suffix hint', () => {
      // Whitespace is trimmed, then length checked
      const stops = buildFimStopSequences('openai', '  return;  ');
      expect(stops).toContain('return;');
    });

    test('ignores short suffix hints', () => {
      const stops = buildFimStopSequences('openai', 'ab');
      expect(stops).not.toContain('ab');
    });

    test('limits suffix hint length', () => {
      const longSuffix = 'this is a very long suffix that exceeds limit';
      const stops = buildFimStopSequences('openai', longSuffix);
      // Should add hint but trimmed to 20 chars
      const hint = stops.find(s => s.startsWith('this is'));
      expect(hint).toBeDefined();
      expect(hint!.length).toBeLessThanOrEqual(20);
    });

    test('ignores whitespace-only suffix hint', () => {
      const stops = buildFimStopSequences('openai', '   ');
      expect(stops.length).toBe(3); // Only the 3 base stops
    });

    test('uses openai format by default', () => {
      const stops = buildFimStopSequences();
      expect(stops).toContain('<fim_suffix>');
      expect(stops).toContain('<fim_prefix>');
    });
   });
});
