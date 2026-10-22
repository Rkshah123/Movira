import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../shared-core/src'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
