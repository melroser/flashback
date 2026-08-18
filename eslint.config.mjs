// The media store must be unreachable from anywhere except the two modules that
// are allowed to touch bytes. This makes the invariant fail the build instead of
// relying on a reviewer noticing.
import tsParser from '@typescript-eslint/parser';

export default [
  {
    // Flat config has no .eslintignore; ignores live here. Build output and
    // vendored dependencies are not ours to lint, and scripts/tmp/ is scratch.
    ignores: [
      '.next/**',
      '.netlify/**',
      'node_modules/**',
      'scripts/tmp/**',
      'ingest-staging/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    // The default parser (espree) cannot read TypeScript syntax, so without this
    // every .ts file is a parse error and no rule below ever gets to run.
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/blobs/media', '@/lib/blobs/media'],
              message:
                'Only lib/media/serve.ts and lib/media/purge.ts may import the media store. Everything else must go through the authorization gate.',
            },
            {
              group: ['next/image'],
              message:
                'next/image routes through the Netlify Image CDN, which caches transformed bytes outside the authorization gate. Use a plain <img>.',
            },
          ],
        },
      ],
    },
  },
  {
    // The two modules permitted to hold the media store handle.
    files: ['lib/media/serve.ts', 'lib/media/purge.ts', 'scripts/ingest/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
