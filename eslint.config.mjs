import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'vendor/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // The protocol boundary intentionally accepts a few opaque payloads;
      // keep those visible without making the historical surface block CI.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
)
