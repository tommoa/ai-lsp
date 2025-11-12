/**
 * FIM (Fill-in-the-Middle) template system for different model families.
 *
 * Different models use different special tokens to delimit the prefix,
 * suffix, and middle (gap to fill) sections. This module provides:
 * - Template definitions for common model families
 * - Template builder with ${placeholder} syntax
 * - Helpers to build FIM prompts
 */

/**
 * FIM template with ${placeholder} syntax for content injection
 */
export interface FimTemplate {
  /** Template string using ${placeholder} syntax for context variables */
  template: string;

  /** Stop sequences to halt generation */
  stop: string[];

  /** Optional: default values for placeholders */
  defaults?: Record<string, string>;

  /** Optional: human-readable name for debugging */
  name?: string;
}

/**
 * Context variables for FIM prompt generation.
 *
 * Core fields are prefix and suffix. Additional fields can be provided
 * for templates that use extended context (e.g., Qwen uses repo_name
 * and file_path).
 */
export interface FimContext {
  /** Text before cursor position (required) */
  prefix: string;

  /** Text after cursor position (required) */
  suffix: string;

  /** Repository name (optional, used by some templates like Qwen) */
  repo_name?: string;

  /** File path (optional, used by some templates like Qwen) */
  file_path?: string;
}

/**
 * Built-in FIM templates for common model families.
 * Each template can be selected by ID or auto-detected from model name.
 */
export const BUILTIN_FIM_TEMPLATES: Record<string, FimTemplate> = {
  openai: {
    name: 'OpenAI Format',
    template: '<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>',
    stop: ['<fim_suffix>', '<fim_prefix>', '\n\n'],
  },

  codellama: {
    name: 'CodeLlama Format',
    template: '▁<PRE>${prefix}▁<SUF>${suffix}▁<MID>',
    stop: ['▁<SUF>', '▁<PRE>', '▁<EOT>', '\n\n'],
  },

  deepseek: {
    name: 'DeepSeek Coder Format',
    template: '<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>',
    stop: ['<｜fim▁end｜>', '\n\n'],
  },

  qwen: {
    name: 'Qwen Coder Format',
    template:
      '<|repo_name|>${repo_name}<|file_path|>${file_path}<|fim_prefix|>' +
      '${prefix}<|fim_suffix|>${suffix}<|fim_middle|>',
    stop: ['<|fim_suffix>', '<|fim_prefix>', '<|endoftext|>'],
    defaults: {
      repo_name: 'unknown',
      file_path: '',
    },
  },
};

/**
 * Get a built-in FIM template by ID with type safety.
 *
 * @param templateId - The template ID to retrieve
 * @returns The FIM template, or undefined if not found
 */
export function getBuiltinTemplate(
  templateId: string,
): FimTemplate | undefined {
  return BUILTIN_FIM_TEMPLATES[templateId];
}

/**
 * Auto-detect FIM template from model name.
 *
 * Uses heuristic matching on the model name to select an appropriate
 * FIM template. Falls back to OpenAI format if no match is found.
 *
 * @param modelName - Model name to detect template for
 * @returns The detected FIM template
 */
export function autoDetectFimTemplate(modelName: string): FimTemplate {
  const modelLower = modelName.toLowerCase();

  // Model name patterns checked in order, first match wins
  const patterns = ['codellama', 'deepseek', 'qwen'];

  for (const pattern of patterns) {
    if (modelLower.includes(pattern)) {
      return BUILTIN_FIM_TEMPLATES[pattern]!;
    }
  }

  // Default to OpenAI format (most common)
  return BUILTIN_FIM_TEMPLATES['openai']!;
}

/**
 * Build a FIM prompt from a template and context.
 *
 * Replaces ${placeholder} with values from context, falling back to
 * template defaults if a value is not provided.
 *
 * @param template - FIM template with placeholders
 * @param context - Context variables to inject
 * @returns Complete FIM prompt string
 */
export function buildFimPrompt(
  template: FimTemplate,
  context: FimContext,
): string {
  // Merge context with defaults (context takes precedence)
  const fullContext: Record<string, string | undefined> = {
    ...template.defaults,
    ...context,
  };

  // Replace ${placeholder} with values from context
  return template.template.replace(
    /\$\{(\w+)\}/g,
    (_, key: string) => fullContext[key] ?? '',
  );
}
