import { createGameServer } from './app';

const server = createGameServer();
server.listen().then((port) => {
  console.log(`[NULL Protocol] server listening on :${port}`);
  if (server.config.corsOrigins !== true && server.config.corsOrigins.length === 0) {
    console.log('[NULL Protocol] CORS_ORIGIN 未設定：只接受同源連線。前端若部署在不同網域，請設定 CORS_ORIGIN。');
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().finally(() => process.exit(0));
  });
}
