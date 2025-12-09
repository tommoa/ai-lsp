#!/usr/bin/env bun
/**
 * Check the Nix node_modules hash.
 *
 * This script requires Nix to be installed to compute the hash.
 * Non-Nix users: The hash will be auto-updated by CI when you push changes.
 *
 * Pass --fix to auto-update the hash if it's outdated (requires Nix).
 */

import { $ } from 'bun';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const projectRoot = resolve(import.meta.dir, '..');
const hashesFile = resolve(projectRoot, 'nix/hashes.json');

const shouldFix = process.argv.includes('--fix');
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

// Check if Nix is available
try {
  await $`which nix`.quiet();
} catch {
  console.log('ℹ️  Nix not found, skipping Nix hash check');
  console.log('   (The hash will be auto-updated by CI when you push changes)');
  process.exit(0);
}

// Read current hash
let currentHash: string;
try {
  const hashesData = JSON.parse(readFileSync(hashesFile, 'utf-8')) as {
    nodeModules: string;
  };
  currentHash = hashesData.nodeModules;
} catch {
  console.error('❌ Error: nix/hashes.json not found or invalid');
  process.exit(1);
}

/**
 * Try to build and extract hash from error if mismatch occurs
 */
async function tryBuild(useRebuild: boolean): Promise<string | null> {
  const buildCmd = useRebuild
    ? $`nix build .#default.node_modules --no-link --rebuild`
    : $`nix build .#default.node_modules --no-link`;

  try {
    await buildCmd.cwd(projectRoot).quiet();
    return null; // Build succeeded - hash is correct
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string };
    const output = [err.stderr, err.stdout].filter(Boolean).join('\n');

    // Extract hash from mismatch error
    const hashMatch = /got:\s+(sha256-[A-Za-z0-9+/=]+)/.exec(output);
    if (hashMatch) {
      return hashMatch[1]!;
    }

    // Check if error is recoverable
    const isOutputsNotValid = output.includes(
      'are not valid, so checking is not possible',
    );
    const isHashMismatch =
      output.includes('hash mismatch') || output.includes('outputHashMismatch');

    if (!isOutputsNotValid && !isHashMismatch) {
      throw error; // Unexpected error
    }

    return isOutputsNotValid ? 'retry' : null;
  }
}

/**
 * Compute the Nix FOD hash by attempting a build
 */
async function computeNixHash(): Promise<string | null> {
  // Try --rebuild first (bypasses cache), fall back to regular build if needed
  const result = await tryBuild(true);

  if (result === 'retry') {
    return tryBuild(false);
  }

  return result;
}

try {
  const expectedHash = await computeNixHash();

  if (expectedHash !== null) {
    // Hash is wrong
    if (shouldFix) {
      console.log(
        '⚠️  Nix hash is outdated (package.json or bun.lock changed)',
      );
      writeFileSync(
        hashesFile,
        JSON.stringify({ nodeModules: expectedHash }, null, 2) + '\n',
      );
      console.log(`✓ Updated Nix hash to: ${expectedHash}`);
      process.exit(0);
    }

    console.error('❌ Error: Nix node_modules hash is outdated');
    console.error(
      '\nThe package.json or bun.lock has changed since the last hash update.',
    );
    console.error(`Expected: ${expectedHash}`);
    console.error(`Got:      ${currentHash}`);
    console.error("\nRun 'bun run lint:fix' to update the hash");
    process.exit(1);
  }

  // Hash is correct
  console.log('✓ Nix node_modules hash is up-to-date');
  process.exit(0);
} catch (error: unknown) {
  // For unexpected errors, warn locally but fail in CI
  const err = error as { stderr?: string; stdout?: string; message?: string };
  const output = String(err.stderr ?? err.stdout ?? err.message ?? '');
  const errorLines = output.trim().split('\n').slice(-5).join('\n');

  if (isCI) {
    console.error('❌ Error: Nix hash verification failed in CI');
    console.error(`Reason: ${errorLines}`);
    console.error('\nFull error:', error);
    process.exit(1);
  }

  console.warn('⚠️  Warning: Could not verify Nix hash (non-fatal)');
  console.warn(`Reason: ${errorLines}`);
  process.exit(0);
}
