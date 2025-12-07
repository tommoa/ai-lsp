/**
 * An error to indicate that configuration for this provider was not found.
 */
export class ProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`Provider not found: ${provider}`);
    this.name = 'ProviderNotFoundError';
  }
}

/**
 * An error to indicate that the NPM package to use for this provider was
 * not found or not configured.
 */
export class NoProviderNpmError extends Error {
  constructor(provider: string) {
    super(`No npm package found for provider: ${provider}`);
    this.name = 'NoProviderNpmError';
  }
}

/**
 * An error to indicate that loading the provider package failed for some
 * reason.
 */
export class ProviderPackageError extends Error {
  constructor(provider: string, message?: string) {
    super(`The loading of the package for ${provider} failed: ${message}`);
    this.name = 'ProviderPackageError';
  }
}
