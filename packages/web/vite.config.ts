import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.ATEM_CROSSPOINT_API ?? 'http://localhost:8533';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
