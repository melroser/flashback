// The media store must be unreachable from anywhere except the two modules that
// are allowed to touch bytes. This makes the invariant fail the build instead of
// relying on a reviewer noticing.
export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
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
