import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-node';

export default [
  // Configuration de base pour JavaScript
  js.configs.recommended,

  // Configuration pour tous les fichiers TypeScript
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
      import: importPlugin,
      node: nodePlugin,
    },
    rules: {
      // Règles TypeScript recommandées
      ...tseslint.configs.recommended.rules,
      ...tseslint.configs['recommended-requiring-type-checking'].rules,

      // Règles Prettier
      ...prettierConfig.rules,
      'prettier/prettier': 'error',

      // Règles personnalisées
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'error', // Règle ESLint de base, pas TypeScript
      '@typescript-eslint/no-var-requires': 'error',

      // Règles Node.js
      'node/no-missing-import': 'off',
      'node/no-unsupported-features/es-syntax': 'off',
      'node/no-unpublished-import': 'off',

      // Règles import
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

      // Règles générales
      // 'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Configuration spécifique pour les fichiers JavaScript
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

  // Fichiers à ignorer (remplace .eslintignore)
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
      'eslint.config.js', // S'ignorer lui-même si besoin
    ],
  },
];
