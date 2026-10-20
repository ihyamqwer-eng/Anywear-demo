import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const configuredPort = Number(loadEnv(mode, projectRoot, '').PORT);
  const backendPort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 1111;

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': `http://127.0.0.1:${backendPort}`,
        '/ws': {
          target: `ws://127.0.0.1:${backendPort}`,
          ws: true,
        },
      },
    },
  };
});
