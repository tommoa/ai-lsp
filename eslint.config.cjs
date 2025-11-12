module.exports = [
  // Ignore built artifacts and deps
  {
    ignores: ['dist', 'node_modules'],
  },

  // TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: (function () {
        const p = require('@typescript-eslint/parser');
        return p && (p.default || p);
      })(),
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
      globals: {},
    },
    plugins: {
      '@typescript-eslint': (function () {
        const mod = require('@typescript-eslint/eslint-plugin');
        return mod && (mod.default || mod);
      })(),
      prettier: (function () {
        const mod = require('eslint-plugin-prettier');
        return mod && (mod.default || mod);
      })(),
    },
    rules: {
      'max-len': [
        'error',
        {
          code: 80,
          tabWidth: 2,
          comments: 80,
          ignoreTrailingComments: true,
          ignoreUrls: true,
          ignoreStrings: false,
          ignoreTemplateLiterals: false,
          ignoreRegExpLiterals: true,
        },
      ],
      'prettier/prettier': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
        },
      ],
    },
  },

  // JavaScript files (basic rules)
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
    },
  },
];
