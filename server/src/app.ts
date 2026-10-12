import compression from 'compression';
import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@null-protocol/shared';
import { loadConfig, type ServerConfig } from './config';
import { RoomManager } from './rooms/manager';

export interface GameServer {
  http: HttpServer;
  manager: RoomManager;
  config: ServerConfig;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createGameServer(overrides: Partial<ServerConfig> = {}): GameServer {
  const config: ServerConfig = { ...loadConfig(), ...overrides };
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, rooms: manager.rooms.size });
  });

  // 語音用的 ICE 伺服器設定。TURN 憑證只放在伺服器環境變數，不寫進前端程式碼。
  app.get('/api/ice-servers', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers: config.ice });
  });

  // 同源部署時，由伺服器一併提供前端靜態檔
  const candidates = [
    config.clientDist,
    path.resolve(process.cwd(), '../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
  ].filter((p): p is string => !!p);
  const dist = candidates.find((p) => existsSync(path.join(p, 'index.html')));
  if (dist) {
    // gzip：角色模型（GLB）與 JS 套件壓縮後約只剩 1/4；Socket.IO 不經過這裡
    app.use(compression({ filter: (req, res) => /\.(glb|js|css|json|html|svg)$/.test(req.path) || compression.filter(req, res) }));
    // 角色模型：檔名固定，快取 1 天；更新模型後重新部署即可（Render 每次部署都是新的程序）
    app.use(
      '/models',
      express.static(path.join(dist, 'models'), {
        maxAge: '1d',
        index: false,
        fallthrough: false, // 找不到模型就回 404，不要回傳網頁（前端會改用備用模型）
        // manifest 決定要載入哪個模型（含正式模型的替換設定），每次都向伺服器確認
        setHeaders: (res, file) => {
          if (file.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get(/^(?!\/(socket\.io|api|healthz)).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  const http = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
    cors: { origin: config.corsOrigins === true ? true : config.corsOrigins },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10_000,
    pingTimeout: 15_000,
  });

  const manager = new RoomManager(io, {
    syncWindowMs: config.syncWindowMs,
    hintCooldownMs: config.hintCooldownMs,
    moveSpeedMultiplier: config.moveSpeedMultiplier,
    debugTools: config.debugTools,
    lockBaseMs: config.lockBaseMs,
    maxRooms: config.maxRooms,
    roomIdleMs: config.roomIdleMs,
    lobbyGraceMs: 20_000,
    hostGraceMs: 30_000,
  });
  manager.attach();

  return {
    http,
    manager,
    config,
    listen: (port = config.port) =>
      new Promise<number>((resolve) => {
        http.listen(port, () => {
          const addr = http.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        manager.close();
        void io.close(() => resolve());
      }),
  };
}
