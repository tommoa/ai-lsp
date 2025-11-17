/**
 * Error types for inline completion operations.
 */

/**
 * Error thrown when a prompt type (e.g., FIM) is requested but not supported
 * by the model or provider.
 *
 * This error is thrown by the inline completion implementation when it detects
 * that the requested prompt type cannot be fulfilled. It includes context about
 * which prompt was requested and why it's not supported.
 */
export class UnsupportedPromptError extends Error {
  /**
   * The prompt type that was requested but not supported
   */
  public readonly prompt: string;

  /**
   * Detailed reason why the prompt type is not supported
   */
  public readonly reason: string;

  /**
   * The model name that doesn't support this prompt (optional)
   */
  public readonly modelName?: string;

  /**
   * Creates a new UnsupportedPromptError
   *
   * @param prompt - The prompt type that was requested
   * @param reason - Detailed reason for lack of support
   * @param modelName - Optional model name for context
   */
  constructor(prompt: string, reason: string, modelName?: string) {
    const message =
      `Prompt type '${prompt}' is not supported` +
      (modelName ? ` by model '${modelName}'` : '') +
      `: ${reason}`;

    super(message);
    this.name = 'UnsupportedPromptError';
    this.prompt = prompt;
    this.reason = reason;
    this.modelName = modelName;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, UnsupportedPromptError.prototype);
  }
}
