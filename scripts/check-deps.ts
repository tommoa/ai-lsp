#!/usr/bin/env bun

import pkg from '../package.json';

const deps = Object.keys({
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {}),
});

const providerDeps = deps.filter(d => d.startsWith('@ai-sdk/'));

if (providerDeps.length) {
  console.error('ERROR: Provider packages found:', providerDeps.join(', '));
  console.error(
    'Provider packages @ai-sdk/* should not be installed in this package.',
  );
  process.exit(1);
} else {
  console.log('✓ No @ai-sdk/* packages found');
}
