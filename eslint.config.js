import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['test/fake-agent/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
      },
    },
    rules: {
      'no-fallthrough': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'max-lines': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // Backlog de extracción: ficheros heredados que superan el límite.
    // Se van partiendo en PRs separados (uno por fichero, con tests en
    // verde) hasta poder borrar esta entrada y dejar la regla sin excepciones.
    files: [
      'src/cli/main.ts',
      'src/store/store.ts',
      'src/app/pipeline.ts',
      'src/app/workspace.ts',
      'src/config/config.ts',
      'src/brief/brief.ts',
      'src/app/role-agents.ts',
      'src/app/merge.ts',
      'src/app/service.ts',
      'src/app/daemon.ts',
      'src/app/session/herdr.ts',
      'src/app/run-stage.ts',
      'src/app/intake.ts',
      'src/adapters/backend/process.ts',
      'src/core/types.ts',
      'test/fake-agent/index.mjs',
      'test/e2e/phase0.test.ts',
      'test/unit/daemon.test.ts',
      'test/e2e/pipeline-pr.test.ts',
      'test/unit/merge.test.ts',
      'test/e2e/captain.test.ts',
      'test/unit/workspace.test.ts',
      'test/unit/store.test.ts',
      'test/e2e/review.test.ts',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
);
