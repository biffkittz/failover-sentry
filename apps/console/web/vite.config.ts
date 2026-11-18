import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// The console server (Fastify) serves the built app and the API from one origin. In development, Vite serves the
// app and proxies the API to the server, so cookies stay first-party.
const api = process.env.CONSOLE_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/auth': { target: api, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Route-level code splitting keeps the first load small; vendor code changes rarely, so it caches well.
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
});
