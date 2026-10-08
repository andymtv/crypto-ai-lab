import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The source lives on a bind mount; polling keeps HMR reliable under WSL/Docker.
    watch: { usePolling: true, interval: 300 },
  },
});
