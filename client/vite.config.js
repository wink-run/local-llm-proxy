import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_API_PROXY_PREFIX = '/__tokenbank_api__';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 构建时 TOKEN_SERVER_URL → 前端默认服务地址
  const tokenServerUrl = env.TOKEN_SERVER_URL || env.VITE_TOKEN_SERVER_URL || 'https://tokenbank.wink.run';

  return {
    plugins: [react()],
    base: './',
    build: { outDir: 'dist' },
    server: {
      port: 5173,
      // 浏览器 dev 直连远程 API 会触发 CORS，经同源代理转发
      proxy: {
        [DEV_API_PROXY_PREFIX]: {
          target: tokenServerUrl,
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(new RegExp(`^${DEV_API_PROXY_PREFIX}`), ''),
        },
      },
    },
    define: {
      'import.meta.env.VITE_TOKEN_SERVER_URL': JSON.stringify(tokenServerUrl),
    },
  };
});
