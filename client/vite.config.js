import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      allowedHosts: env.DEV_PREVIEW_HOST ? [env.DEV_PREVIEW_HOST] : [],
      proxy: {
        '/socket.io': {
          target: 'http://127.0.0.1:5000',
          ws: true,
        },
        '/api': 'http://127.0.0.1:5000',
      },
    },
  };
});
