/**
 * API + web UI, served on 127.0.0.1:3333 behind CloudPanel's Nginx proxy.
 *
 * Separate process from the gateway: the gateway owns device sockets and must
 * never be blocked by a browser request, and either can be restarted without
 * disturbing the other.
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import { pool, createListener } from '../db.ts';
import { apiRoutes } from './routes.ts';
import { integrationRoutes } from './integration.ts';
import { apiConfig } from './config.ts';
import { seedFromSharedPassword } from './users.ts';
import { fetchDevicesByIds } from './devices-query.ts';
import { evaluationPeriod } from '../evaluation.ts';

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

/**
 * Evaluation-period gate. See src/evaluation.ts and README "Evaluation period".
 *
 * Registered before the routes so it covers the API, the static assets and the
 * WebSocket alike — once the period lapses there is no path through this server
 * that still does work.
 *
 * The process deliberately stays up and inert rather than exiting: both units
 * are Restart=always, so exiting would restart-loop every five seconds and the
 * operator would see a dead port instead of an explanation.
 */
const expiredPage = readFileSync(path.join(publicDir, 'expired.html'), 'utf8');

app.addHook('onRequest', async (req, reply) => {
  if (!evaluationPeriod.isExpired()) return;
  if (req.url.startsWith('/api/')) {
    return reply.code(403).send({
      error: 'evaluation_period_ended',
      expiredAt: evaluationPeriod.expiresAt?.toISOString() ?? null,
    });
  }
  // Sent from memory rather than with sendFile, which sets its own 200 and
  // would drop the 403. This is a refusal, and monitoring should read it as
  // one rather than as a working page.
  return reply.code(403).type('text/html; charset=utf-8').send(expiredPage);
});

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
/*
 * One dirty set, flushed on a single timer.
 *
 * The previous version kept a timer per device. Coalescing was therefore per
 * device, which collapses nothing across a fleet of 3,000 distinct trucks: at
 * ~36 reports a second it ran the device projection — two LATERAL subqueries
 * apiece — 36 times a second against a pool of 15.
 *
 * This is batching, not caching. Every flush reads the rows fresh; it just
 * reads them together.
 */
const dirty = new Map<string, string>(); // deviceId -> kind of the last change
let flushTimer: NodeJS.Timeout | null = null;

const PUSH_FLUSH_MS = 500;
/**
 * Ids per flush. A bigger batch is a longer single query holding a pool
 * connection, and a bigger frame for every browser to parse at once; the
 * remainder is not dropped, it goes out on the next flush 500ms later.
 */
const PUSH_BATCH_MAX = 500;

function pushDeviceUpdate(kind: string, deviceId: string): void {
  if (sockets.size === 0) return; // nobody watching; skip the query entirely

  // Last write wins for the kind: several changes to one vehicle inside the
  // window (a position, then a command status) collapse into one push carrying
  // its final state.
  dirty.set(deviceId, kind);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDeviceUpdates();
  }, PUSH_FLUSH_MS);
  flushTimer.unref();
}

async function flushDeviceUpdates(): Promise<void> {
  if (dirty.size === 0 || sockets.size === 0) {
    dirty.clear();
    return;
  }

  const batch = [...dirty.keys()].slice(0, PUSH_BATCH_MAX);
  const kinds = new Map(batch.map((id) => [id, dirty.get(id) ?? 'state']));
  for (const id of batch) dirty.delete(id);

  // Anything over the cap waits for the next flush rather than being dropped.
  if (dirty.size > 0 && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushDeviceUpdates();
    }, PUSH_FLUSH_MS);
    flushTimer.unref();
  }

  try {
    const devices = (await fetchDevicesByIds(batch)) as { device_id: string }[];

    /*
     * Broadcast as individual frames, which every console already understands.
     *
     * The database saving — the part that matters for capacity — is entirely
     * in the batched read above and needs nothing from the client. The
     * wire-level batch frame is a separate, smaller win and can only be
     * switched on once no console predating it is still open.
     */
    for (const device of devices) {
      broadcast(JSON.stringify({
        kind: kinds.get(device.device_id) ?? 'state',
        deviceId: device.device_id,
        device,
      }));
    }

    // A device that vanished mid-flight still deserves a nudge, so the browser
    // can drop it from the list.
    const returned = new Set(devices.map((d) => d.device_id));
    for (const id of batch) {
      if (!returned.has(id)) broadcast(JSON.stringify({ kind: kinds.get(id) ?? 'state', deviceId: id }));
    }
  } catch (err) {
    app.log.warn({ err, count: batch.length }, 'device push failed, falling back to nudges');
    for (const id of batch) broadcast(JSON.stringify({ kind: kinds.get(id) ?? 'state', deviceId: id }));
  }
}

// A sibling of apiRoutes, never inside it: registering here keeps it clear of
// that plugin's session-cookie hook, since these callers are other systems
// holding a bearer token rather than browsers holding a cookie.
await app.register(integrationRoutes);

await app.register(apiRoutes);

// Serve the single-page UI for any non-API path.
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
  return reply.sendFile('index.html');
});

async function main(): Promise<void> {
  await pool.query('SELECT 1');

  // Carry the old shared credential into a named account, once, so deploying
  // named users does not lock every operator out of a live fleet. It warns
  // loudly and does nothing on any subsequent start. See users.ts.
  if (!apiConfig.authDisabled) {
    await seedFromSharedPassword(apiConfig.sharedPassword).catch((err) => {
      app.log.error({ err }, 'could not seed the initial operator account');
    });
  }

  // Forward device changes straight to the browsers; no polling anywhere.
  await createListener(
    'device_update',
    (payload) => {
      try {
        const { kind, deviceId } = JSON.parse(payload) as { kind?: string; deviceId?: string };
        if (deviceId) return pushDeviceUpdate(kind ?? 'state', deviceId);
      } catch {
        // Malformed payload: fall through and forward it as-is rather than
        // dropping a change the browser needs to know about.
      }
      broadcast(payload);
    },
    {
      /*
       * Everything that changed while the listener was down was missed —
       * NOTIFY has no replay. Every open console is now showing a fleet frozen
       * at the moment the connection dropped, with no indication of it: the
       * map keeps drawing, the rows keep their timestamps, and a truck that
       * has since been unlocked still reads as locked.
       *
       * A bare nudge is enough. The console refetches on a payload it cannot
       * use, which is exactly what is wanted here.
       */
      onReconnect: () => {
        app.log.warn('device_update listener reconnected; nudging consoles to resync');
        broadcast(JSON.stringify({ kind: 'resync' }));
      },
    },
  );

  if (evaluationPeriod.enabled) {
    if (evaluationPeriod.isExpired()) {
      app.log.error(evaluationPeriod.banner());
    } else {
      app.log.info(
        `evaluation period active — ${evaluationPeriod.daysRemaining()} day(s) left, ends ${evaluationPeriod.expiresAt?.toISOString().slice(0, 10)}`,
      );
    }
  }

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
