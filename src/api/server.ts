/**
 * API + web UI, served on 127.0.0.1:3333 behind CloudPanel's Nginx proxy.
 *
 * Separate process from the gateway: the gateway owns device sockets and must
 * never be blocked by a browser request, and either can be restarted without
 * disturbing the other.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import { pool, createListener } from '../db.ts';
import { apiRoutes } from './routes.ts';
import { apiConfig } from './config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', '..', 'public');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Nginx terminates TLS and sets X-Forwarded-*; trust it so audit logs
  // record the operator's real IP rather than 127.0.0.1.
  trustProxy: true,
});

await app.register(fastifyCookie, { secret: apiConfig.cookieSecret });
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: publicDir });

/** Browsers subscribed to live updates. */
const sockets = new Set<{ send(data: string): void }>();

app.register(async (scope) => {
  scope.get('/api/ws', { websocket: true }, (socket, req) => {
    if (!apiConfig.isAuthenticated(req)) {
      socket.close(4401, 'unauthorised');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
});

function broadcast(payload: string): void {
  for (const socket of sockets) {
    try {
      socket.send(payload);
    } catch {
      sockets.delete(socket);
    }
  }
}

await app.register(apiRoutes);

// Serve the single-page UI for any non-API path.
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
  return reply.sendFile('index.html');
});

async function main(): Promise<void> {
  await pool.query('SELECT 1');

  // Forward device changes straight to the browsers; no polling anywhere.
  await createListener('device_update', (payload) => broadcast(payload));

  await app.listen({ port: apiConfig.port, host: apiConfig.host });
  app.log.info(`UI available on http://${apiConfig.host}:${apiConfig.port}`);
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  app.log.error(err, 'failed to start');
  process.exit(1);
});
