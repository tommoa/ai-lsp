import { describe, test, expect } from 'bun:test';
import {
  buildFimPrompt,
  BUILTIN_FIM_TEMPLATES,
  autoDetectFimTemplate,
  type FimTemplate,
  type FimContext,
} from '../src/inline-completion/fim-formats';

describe('FIM Templates', () => {
  describe('buildFimPrompt', () => {
    test('builds prompts for all built-in templates', () => {
      // OpenAI format
      const openai = BUILTIN_FIM_TEMPLATES.openai!;
      expect(
        buildFimPrompt(openai, { prefix: 'const x = ', suffix: ';' }),
      ).toBe('<fim_prefix>const x = <fim_suffix>;<fim_middle>');

      // CodeLlama format
      const codellama = BUILTIN_FIM_TEMPLATES.codellama!;
      expect(
        buildFimPrompt(codellama, { prefix: 'def foo(', suffix: '):' }),
      ).toBe('▁<PRE>def foo(▁<SUF>):▁<MID>');

      // Qwen format with metadata
      const qwen = BUILTIN_FIM_TEMPLATES.qwen!;
      const qwenPrompt = buildFimPrompt(qwen, {
        prefix: 'x = ',
        suffix: '\n',
        repo_name: 'my-repo',
        file_path: 'src/main.py',
      });
      expect(qwenPrompt).toContain('<|repo_name|>my-repo');
      expect(qwenPrompt).toContain('<|file_path|>src/main.py');

      // DeepSeek format
      const deepseek = BUILTIN_FIM_TEMPLATES.deepseek!;
      expect(
        buildFimPrompt(deepseek, {
          prefix: 'def add(a, b):',
          suffix: 'return a + b',
        }),
      ).toBe(
        '<｜fim▁begin｜>def add(a, b):<｜fim▁hole｜>return a + b<｜fim▁end｜>',
      );
    });

    test('all built-in templates have required fields', () => {
      for (const template of Object.values(BUILTIN_FIM_TEMPLATES)) {
        expect(template.name).toBeDefined();
        expect(template.name!).toContain('Format');
        expect(template.template).toMatch(/\$\{prefix\}.*\$\{suffix\}/);
        expect(template.stop.length).toBeGreaterThan(0);
      }
    });
  });

  describe('template edge cases and validation', () => {
    test('handles missing placeholders and defaults system', () => {
      // Template missing suffix placeholder
      const template1: FimTemplate = {
        template: '<BEGIN>${prefix}<END>',
        stop: ['<END>'],
      };
      expect(
        buildFimPrompt(template1, { prefix: 'code', suffix: 'more' }),
      ).toBe('<BEGIN>code<END>');

      // Template defaults system
      const template2: FimTemplate = {
        template: '${name}: ${prefix}',
        stop: [],
        defaults: { name: 'default' },
      };

      // Defaults are used when context missing
      expect(buildFimPrompt(template2, { prefix: 'code', suffix: '' })).toBe(
        'default: code',
      );

      // Defaults are overridden by context
      expect(
        buildFimPrompt(template2, {
          prefix: 'code',
          suffix: '',
          name: 'override',
        } as FimContext & { name: string }),
      ).toBe('override: code');
    });

    test('preserves special characters in context values', () => {
      const template: FimTemplate = {
        template: '${prefix}',
        stop: [],
      };

      expect(buildFimPrompt(template, { prefix: 'x.*+?[]', suffix: '' })).toBe(
        'x.*+?[]',
      );
      expect(
        buildFimPrompt(template, { prefix: 'const x = ${foo}', suffix: '' }),
      ).toBe('const x = ${foo}');
    });
  });
});

describe('Template Auto-Detection', () => {
  const testCases = [
    { model: 'codellama-7b', expected: 'codellama' },
    { model: 'CodeLlama-13B-Instruct', expected: 'codellama' },
    { model: 'qwen-coder-1.5b', expected: 'qwen' },
    { model: 'Qwen2.5-Coder-7B', expected: 'qwen' },
    { model: 'starcoder-7b', expected: 'openai' },
    { model: 'StarCoder2-3b', expected: 'openai' },
    { model: 'deepseek-coder-6.7b', expected: 'deepseek' },
    { model: 'DeepSeek-Coder-33B', expected: 'deepseek' },
    { model: 'unknown-model', expected: 'openai' },
    { model: 'gpt-4', expected: 'openai' },
    { model: 'CODELLAMA-7B', expected: 'codellama' },
    { model: 'qWEN-coder', expected: 'qwen' },
  ];

  test.each(testCases)(
    'detects $model as $expected template',
    ({ model, expected }) => {
      expect(autoDetectFimTemplate(model)).toBe(
        BUILTIN_FIM_TEMPLATES[expected]!,
      );
    },
  );
});
