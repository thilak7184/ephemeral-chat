import 'dotenv/config';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';
import { loadConfig } from './config/index.js';
import { RoomManager } from './rooms/RoomManager.js';
import { RateLimiter } from './security/RateLimiter.js';
import { registerSocketHandlers } from './sockets/registerSocketHandlers.js';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientBuildDirectory = path.resolve(serverDirectory, '../../client/dist');

export function isEntrypoint(moduleUrl, entryPath) {
  return Boolean(entryPath && path.resolve(entryPath) === fileURLToPath(moduleUrl));
}

export function createApplication({ config = loadConfig(), roomManager: suppliedManager } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.get('/api/healthz', (_request, response) =>
    response.json({ ok: true, service: 'ephemeral-chat', storage: 'in-memory-only' }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        const allowed = origin
          ? config.clientOrigins.includes(origin.replace(/\/$/, ''))
          : !config.isProduction;
        callback(allowed ? null : new Error('Origin is not allowed.'), allowed);
      },
      methods: ['GET', 'POST'],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: '16kb', strict: true }));
  if (config.serveClient && existsSync(clientBuildDirectory)) {
    app.use(express.static(clientBuildDirectory, { index: false }));
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api/') || request.path.startsWith('/socket.io')) return next();
      return response.sendFile(path.join(clientBuildDirectory, 'index.html'), (error) => {
        if (error) next(error);
      });
    });
  }
  app.use((error, _request, response, next) => {
    if (error?.type === 'entity.too.large')
      return response.status(413).json({ error: 'Payload too large.' });
    if (error instanceof SyntaxError && 'body' in error)
      return response.status(400).json({ error: 'Malformed JSON.' });
    if (error?.message === 'Origin is not allowed.')
      return response.status(403).json({ error: 'Origin is not allowed.' });
    console.error('HTTP request failed:', error?.message ?? 'Unknown error');
    void next;
    return response.status(500).json({ error: 'The request could not be completed.' });
  });

  const httpServer = http.createServer(app);
  const io = new SocketServer(httpServer, {
    cors: {
      origin(origin, callback) {
        const allowed = origin
          ? config.clientOrigins.includes(origin.replace(/\/$/, ''))
          : !config.isProduction;
        callback(allowed ? null : new Error('Origin is not allowed.'), allowed);
      },
      methods: ['GET', 'POST'],
      credentials: false,
    },
    maxHttpBufferSize: config.maxHttpBufferSize,
    pingInterval: config.heartbeatIntervalMs,
    pingTimeout: config.heartbeatTimeoutMs,
    serveClient: false,
  });

  const roomManager =
    suppliedManager ??
    new RoomManager({
      waitingRoomTtlMs: config.waitingRoomTtlMs,
      activeRoomIdleTtlMs: config.activeRoomIdleTtlMs,
      disconnectGraceMs: config.disconnectGraceMs,
      maxRooms: config.maxRooms,
    });
  const rateLimiter = new RateLimiter({
    limit: config.messageRateLimit,
    windowMs: config.messageRateWindowMs,
  });
  const roomActionRateLimiter = new RateLimiter({
    limit: config.roomActionRateLimit,
    windowMs: config.roomActionRateWindowMs,
  });
  const limiterPruneTimer = setInterval(() => {
    rateLimiter.prune();
    roomActionRateLimiter.prune();
  }, 60_000);
  limiterPruneTimer.unref?.();
  let connectionCount = 0;
  io.use((socket, next) => {
    if (connectionCount >= config.maxConnections) {
      const error = new Error('Server is at connection capacity.');
      error.data = { code: 'SERVER_BUSY' };
      next(error);
      return;
    }
    connectionCount += 1;
    socket.once('disconnect', () => {
      connectionCount = Math.max(0, connectionCount - 1);
    });
    next();
  });
  registerSocketHandlers(io, { roomManager, rateLimiter, roomActionRateLimiter, config });

  return {
    app,
    httpServer,
    io,
    roomManager,
    async close() {
      clearInterval(limiterPruneTimer);
      for (const room of roomManager.rooms.values()) {
        if (room.expiryTimer) clearTimeout(room.expiryTimer);
        for (const participant of room.participants.values()) {
          if (participant.graceTimer) clearTimeout(participant.graceTimer);
        }
      }
      await new Promise((resolve) => io.close(() => resolve()));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const config = loadConfig();
  const application = createApplication({ config });
  application.httpServer.listen(config.port, '0.0.0.0', () => {
    console.info(`Ephemeral Chat server listening on port ${config.port} (${config.nodeEnv}).`);
    console.info(
      'Messages and rooms are held in memory only; do not run multiple instances without shared coordination.',
    );
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info('Shutting down chat server.');
    const forceExitTimer = setTimeout(() => process.exit(1), 5000);
    try {
      await application.close();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      console.error('Server shutdown failed:', error?.message ?? 'Unknown error');
      process.exit(1);
    }
  };
  process.on('unhandledRejection', (reason) => {
    console.error(
      'Unhandled promise rejection:',
      reason instanceof Error ? reason.message : String(reason),
    );
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
