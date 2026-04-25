import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), react(), cloudflare()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 8000,
  },
});
