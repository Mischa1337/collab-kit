import { defineConfig } from 'vite';

/** Two ES modules with all else inside, served by CK: v1.js, and manage-v1.js with Lit. */
export default defineConfig({
  build: {
    sourcemap: true,
    lib: {
      entry: { v1: 'src/index.ts', 'manage-v1': 'src/manage/index.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  },
});
