import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

import noConfigCast from './eslint-rules/no-config-cast.mjs';
import noRawRoute from './eslint-rules/no-raw-route.mjs';

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

  // A route is declared with `defineRoute`: see
  // docs/plugin-development/routes.md. The files in
  // eslint-rules/route-allowlist.json have not moved yet.
  {
    files: ['src/plugins/**/*.ts', 'src/abstract/**/*.ts'],
    plugins: {
      local: {
        rules: { 'no-raw-route': noRawRoute, 'no-config-cast': noConfigCast },
      },
    },
    rules: {
      'local/no-raw-route': 'error',
      'local/no-config-cast': 'error',
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

  // Reported as a warning: the rule treats assertions that other rules need
  // as unnecessary, so failing the build on it blocks correct changes.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
    },
  },

  // Tests: the code they exercise, with Mocha's names in scope
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        ...globals.node,
        ...globals.mocha,
        // The namespaces tests name in a type
        Mocha: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
      import: importPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-var-requires': 'error',
      // Chai's assertions are expressions whose value is unused
      '@typescript-eslint/no-unused-expressions': 'off',
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
  // A later block for the same files replaces this rule's options rather
  // than adding to them: the SCIM block below repeats the fetch selector.
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
        {
          selector: "ImportExpression[source.value='node-fetch']",
          message:
            'Call other services through this.fetch (DmPlugin), which times them.',
        },
        {
          selector:
            "CallExpression[callee.name=/^launchHooks/], MemberExpression[property.name='hooks'][object.name='server'], MemberExpression[property.name='hooks'][object.property.name='server'], MemberExpression[property.name='registeredHooks']",
          message:
            'Raise and subscribe to hooks through this.hookBus (chain, notify), typed by Hooks: see docs/plugin-development/hooks.md.',
        },
      ],
    },
  },

  // The bus is the one place that reaches the lists; `index.ts` builds the
  // server's, `plugin.ts` hands them to every plugin, and the two below read
  // what a plugin declared. See docs/plugin-development/hooks.md
  {
    files: [
      'src/lib/hookBus.ts',
      'src/abstract/plugin.ts',
      'src/bin/index.ts',
      'src/lib/authz/composition.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^launchHooks/]',
          message:
            'Raise hooks through this.hookBus (chain, notify): see docs/plugin-development/hooks.md.',
        },
      ],
    },
  },

  // One validator enforces the entity schemas, see
  // docs/client-development/schemas/README.md#what-a-value-must-look-like
  {
    files: ['src/**/*.ts'],
    ignores: ['src/config/schema.ts', 'src/lib/entitySchema/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/config/schema',
                '**/config/schema.js',
                './schema',
                './schema.js',
              ],
              importNames: [
                'schemaAttribute',
                'matchesPattern',
                'checkDnValues',
              ],
              message:
                'Validate through EntityValidator (src/lib/entitySchema/validator.ts); the schema helpers are its own.',
            },
          ],
        },
      ],
    },
  },

  // docs/usage/operations.md#metrics: a call to another service is timed
  // under its caller, which `DmPlugin.fetch` and the instance providers do
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/browser/**',
      'src/abstract/plugin.ts',
      'src/lib/instanceProviders.ts',
    ],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Its own rule key: `no-restricted-imports` above is replaced, not
      // merged, by a later block
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node-fetch',
              message:
                'Call other services through this.fetch (DmPlugin), which times them.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Call other services through this.fetch (DmPlugin), which times them.',
        },
      ],
    },
  },

  // The SCIM plugin serves identity providers, and every operation it makes
  // is judged by the request it is made for. Bind the request once with
  // `ldap.forRequest(req)`, so each operation names the request it means
  // rather than relying on the one being served.
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
        {
          selector: "ImportExpression[source.value='node-fetch']",
          message:
            'Call other services through this.fetch (DmPlugin), which times them.',
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
