import { configs, plugins } from 'eslint-config-airbnb-extended';

/**
 * ESLint flat configuration.
 *
 * The Airbnb JavaScript Style Guide is the project standard; it is applied here
 * through its maintained flat-config distribution, extended with the TypeScript
 * and Node rule sets.
 */
export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'examples/**'],
  },
  plugins.stylistic,
  plugins.importX,
  plugins.node,
  plugins.typescriptEslint,
  ...configs.base.typescript,
  ...configs.node.recommended,
  {
    settings: {
      'import-x/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      // The SDK is native ESM: explicit `.js` specifiers are required at runtime.
      'import-x/extensions': 'off',
      // Modules export named building blocks on purpose; a default export would
      // make the public API harder to grow.
      'import-x/prefer-default-export': 'off',
      // The WHATWG fetch types have been present and working since Node 18 and
      // are formally stable from 21. The SDK supports Node 20 LTS, where they
      // work — declaring 21 as the floor would exclude a supported LTS for a
      // labelling technicality.
      'n/no-unsupported-features/node-builtins': ['error', {
        ignores: ['fetch', 'Response', 'Request', 'Headers'],
      }],
      // A library never writes to the host application's console. Errors are
      // thrown, and diagnostics go to the caller's own handlers.
      'no-console': 'error',
      'max-len': ['error', { code: 100, ignoreUrls: true, ignoreTemplateLiterals: true }],
    },
  },
  {
    /**
     * The evaluation engine, carried over from the 1.x SDK.
     *
     * It is the one part of this package whose behaviour must not change: the
     * CLI's `govplane simulate` asserts runtime parity against it, so a
     * "tidy-up" here silently changes what simulate reports to users. It is
     * therefore ported as-is, with its original formatting and its liberal use
     * of `any`, and guarded by the tests carried over with it.
     *
     * Tightening these rules is worthwhile follow-up work, but it is a
     * behaviour-risk change that deserves its own pass with the engine tests in
     * front of you — not a drive-by reformat.
     */
    files: ['src/engine/**/*.ts'],
    rules: {
      'max-len': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
      'no-plusplus': 'off',
      'no-continue': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests build fixtures on disk and generate key material. Synchronous
      // calls keep each test readable and ordered.
      'n/no-sync': 'off',
    },
  },
  {
    files: ['*.config.js', '*.config.mjs'],
    rules: {
      'import-x/no-extraneous-dependencies': 'off',
    },
  },
];
