import type { LanguageModel } from 'ai';

/**
 * Cost describes the pricing for a model in dollars per million tokens.
 * Includes input and output costs, with optional caching costs.
 */
export interface Cost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/**
 * Info describes a model with its identifier, name, and cost.
 */
export interface Info {
  id: string;
  name?: string;
  cost?: Cost;
}

/**
 * A wrapper that ensures that the required metadata can be passed around with
 * an `ai.LanguageModel`.
 */
export interface Model {
  model: LanguageModel;
  info?: Info;
}

/**
 * Selector maps a logical model name to a runtime Model instance.
 */
export type Selector = (modelName: string) => Model;
