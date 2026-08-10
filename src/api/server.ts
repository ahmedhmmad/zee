/**
 * API + web UI, served on 127.0.0.1:3333 behind CloudPanel's Nginx proxy.
 *
 * Separate process from the gateway: the gateway owns device sockets and must
 * never be blocked by a browser request, and either can be restarted without
 * disturbing the other.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import { pool, createListener } from '../db.ts';
import { apiRoutes } from './routes.ts';
import { apiConfig } from './config.ts';
import { fetchDevice } from './devices-query.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', '..', 'public');

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Nginx terminates TLS and sets X-Forwarded-*; trust it so audit logs
  // record the operator's real IP rather than 127.0.0.1.
  trustProxy: true,
});

/**
 * Treat an empty body as an empty object.
 *
 * Fastify's default JSON parser rejects a zero-length body with 400, so any
 * client that sets Content-Type on a bodyless DELETE gets a confusing "Bad
 * Request" for a perfectly valid call. Being tolerant here means one careless
 * header cannot break an endpoint.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body || (body as string).trim() === '') return done(null, {});
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error);
  }
});

await app.register(fastifyCookie, { secret: apiConfig.cookieSecret });
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: publicDir });

/**
 * Self-hosted vector basemap.
 *
 * Served with byte-range support because that is how PMTiles works: the client
 * reads small ranges out of one large file rather than fetching thousands of
 * tiles. @fastify/static handles Range headers for us.
 *
 * Optional — the map falls back to proxied raster tiles when the file is
 * absent, so a fresh checkout still shows a map before the basemap is built.
 */
const basemapDir = process.env.BASEMAP_DIR ?? path.join(here, '..', '..', '.cache', 'basemap');
if (existsSync(path.join(basemapDir, 'libya.pmtiles'))) {
  await app.register(fastifyStatic, {
    root: basemapDir,
    prefix: '/basemap/',
    decorateReply: false,
    // Immutable for a week: the basemap only changes when it is rebuilt.
    maxAge: '7d',
  });
  app.log.info('vector basemap available at /basemap/libya.pmtiles');
} else {
  app.log.warn(`no vector basemap at ${basemapDir} — falling back to raster tiles`);
}

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

/**
 * Attach the changed vehicle's row to the notification.
 *
 * The trigger only tells us *that* something changed. Sending that alone makes
 * every browser refetch the whole fleet, which at a five-second reporting
 * interval is hundreds of full list queries a minute. Reading one row here
 * costs a fraction of that and it is read once for all connected browsers,
 * not once per browser.
 *
 * Coalesced per device: several changes to the same vehicle inside the window
 * (a position, then a command status) collapse into one push carrying the
 * final state.
 */
const pendingPushes = new Map<string, NodeJS.Timeout>();
const PUSH_COALESCE_MS = 200;

function pushDeviceUpdate(kind: string, deviceId: string): void {
  if (sockets.size === 0) return; // nobody watching; skip the query entirely
  if (pendingPushes.has(deviceId)) return;

  pendingPushes.set(
    deviceId,
    setTimeout(() => {
      pendingPushes.delete(deviceId);
      void fetchDevice(deviceId)
        .then((device) => {
          // A device that vanished mid-flight still deserves a nudge, so the
          // browser can drop it from the list.
          broadcast(JSON.stringify({ kind, deviceId, device }));
        })
        .catch((err) => {
          app.log.warn({ err, deviceId }, 'device push failed, falling back to nudge');
          broadcast(JSON.stringify({ kind, deviceId }));
        });
    }, PUSH_COALESCE_MS).unref(),
  );
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
  await createListener('device_update', (payload) => {
    try {
      const { kind, deviceId } = JSON.parse(payload) as { kind?: string; deviceId?: string };
      if (deviceId) return pushDeviceUpdate(kind ?? 'state', deviceId);
    } catch {
      // Malformed payload: fall through and forward it as-is rather than
      // dropping a change the browser needs to know about.
    }
    broadcast(payload);
  });

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
