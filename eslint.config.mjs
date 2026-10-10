import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const maintainedJavaScript = [
  '*.mjs',
  'scripts/**/*.mjs',
  'examples/**/*.mjs',
  'benchmark/*.mjs',
];
const typescript = ['src/**/*.ts', 'test/*.test.ts'];

export default [
  {
    ...js.configs.recommended,
    files: ['web/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.local/**',
      'coverage/**',
      'benchmark/results/**',
      'benchmark/fixtures/**',
      'benchmark/runs/**',
      'security/fixtures/**',
      'test/.benchmark*',
    ],
  },
  {
    ...js.configs.recommended,
    files: [...maintainedJavaScript, ...typescript],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescript,
  })),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['src/**/*.ts'],
  })),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: typescript,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
