import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發時由 Vite（5173）代理 socket.io 與 /api 到遊戲伺服器（3001），
// 這樣前端永遠使用同源網址；正式部署則由伺服器直接提供 client/dist。
const target = process.env.VITE_DEV_SERVER_TARGET ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/socket.io': { target, ws: true, changeOrigin: true },
      '/api': { target, changeOrigin: true },
      '/healthz': { target, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
