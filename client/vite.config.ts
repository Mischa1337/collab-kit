import { defineConfig } from 'vite';

/** One ES module with Yjs and all else inside, served by CK as /client/v1.js. */
export default defineConfig({
  build: {
    sourcemap: true,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'v1.js' },
  },
});
