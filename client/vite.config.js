import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 构建时 TOKEN_SERVER_URL → 前端默认服务地址
  const tokenServerUrl = env.TOKEN_SERVER_URL || env.VITE_TOKEN_SERVER_URL || '';

  return {
    plugins: [react()],
    base: './',
    build: { outDir: 'dist' },
    server: { port: 5173 },
    define: {
      'import.meta.env.VITE_TOKEN_SERVER_URL': JSON.stringify(tokenServerUrl),
    },
  };
});
