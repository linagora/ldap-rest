import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-node';
import globals from 'globals';

export default [
  // Node.js config
  js.configs.recommended,

  // TypeScript config (except browser)
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/browser/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      // The published lists rather than a hand-kept one: every name missing
      // from it surfaces as a `no-undef` error on correct code, which is how
      // `crypto`, `setInterval` and `clearInterval` ended up reported
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
      import: importPlugin,
      node: nodePlugin,
    },
    rules: {
      // TS rules
      ...tseslint.configs.recommended.rules,
      ...tseslint.configs['recommended-requiring-type-checking'].rules,

      // Prettier
      ...prettierConfig.rules,
      'prettier/prettier': 'error',

      // Custom
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-var-requires': 'error',

      // Node.js rules
      'node/no-missing-import': 'off',
      'node/no-unsupported-features/es-syntax': 'off',
      'node/no-unpublished-import': 'off',

      // Import rules
      'import/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
          ],
          'newlines-between': 'always',
        },
      ],

      // General rules
      // 'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Browser-specific config
  {
    files: ['src/browser/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: globals.browser,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // JavaScript-specific config
  {
    files: ['*.js', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },

  // Every directory operation says whose it is (#385): the request it is
  // made for, or `ldap.system` for the server's own work, with the reason.
  // An operation naming neither is judged as the request being served, if
  // any — but which one was meant is for the code to say, not the context.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/browser/**', 'src/lib/ldapActions.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='ldap'][callee.property.name=/^(search|add|modify|rename|move)$/][arguments.length<3]",
          message:
            'Name the request this operation is made for, or make it as the server through ldap.system and say why.',
        },
        {
          selector:
            "CallExpression[callee.object.property.name='ldap'][callee.property.name='delete'][arguments.length<2]",
          message:
            'Name the request this operation is made for, or make it as the server through ldap.system and say why.',
        },
        {
          selector:
            "CallExpression[callee.object.property.name=/^(ldap|system)$/][callee.property.name='move']",
          message:
            'ldap.move is never judged, request or not: it is the trash moving what a judged delete removed. Move for a caller with ldap.rename.',
        },
      ],
    },
  },

  // The SCIM plugin serves identity providers, and every operation it makes
  // must reach the authorization hooks. `ldapActions`'s own methods take the
  // request as a trailing optional argument, so forgetting it silently skips
  // authorization — three such bugs have shipped here. Bind the request once
  // with `ldap.forRequest(req)` and the omission stops being expressible.
  {
    files: ['src/plugins/scim/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.property.name='ldap'][callee.property.name=/^(search|add|modify|delete|rename)$/]",
          message:
            'Use ldap.forRequest(req).<method>() so the authorization hooks see the request.',
        },
      ],
    },
  },

  // Ignored files
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      '*.min.js',
      '*.map',
      '*.d.ts',
      'coverage/**',
      '.nyc_output/**',
      'logs/**',
      '*.log',
      'eslint.config.js',
    ],
  },
];
