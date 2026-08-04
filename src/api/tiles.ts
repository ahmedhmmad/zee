/**
 * Map tile proxy with an on-disk cache.
 *
 * Browsers in Libya cannot reach tile.openstreetmap.org reliably - requests
 * are closed mid-connection - so tiles are fetched server-side from Oracle
 * Cloud, which has no such problem, and served from our own origin.
 *
 * Two further benefits: the cache means a tile is fetched from OSM at most
 * once regardless of how many operators view the same area, which respects
 * their tile usage policy; and the map keeps working if OSM is unreachable
 * for anything already cached.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.TILE_CACHE_DIR ?? path.join(here, '..', '..', '.cache', 'tiles');

const UPSTREAM = process.env.TILE_UPSTREAM ?? 'https://tile.openstreetmap.org';

/**
 * OSM's policy requires a User-Agent identifying the application. Anonymous
 * or default agents get blocked.
 */
const USER_AGENT =
  process.env.TILE_USER_AGENT ?? 'ZeeLockPlatform/0.1 (fleet monitoring; +https://locks.ahmedhammad.page)';

const MAX_ZOOM = 19;
/** Tiles are effectively immutable; refetch monthly to pick up map edits. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function tileRoutes(app: FastifyInstance): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  app.get('/api/tiles/:z/:x/:y.png', async (req, reply) => {
    const { z, x, y } = req.params as { z: string; x: string; y: string };

    const zoom = Number(z);
    const tileX = Number(x);
    const tileY = Number(y);

    // Validate before touching the filesystem: these values become a path.
    const limit = 2 ** zoom;
    const valid =
      Number.isInteger(zoom) &&
      Number.isInteger(tileX) &&
      Number.isInteger(tileY) &&
      zoom >= 0 &&
      zoom <= MAX_ZOOM &&
      tileX >= 0 &&
      tileX < limit &&
      tileY >= 0 &&
      tileY < limit;

    if (!valid) return reply.code(400).send({ error: 'invalid_tile' });

    const file = path.join(CACHE_DIR, String(zoom), String(tileX), `${tileY}.png`);

    const cached = await readIfFresh(file);
    if (cached) {
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'public, max-age=604800')
        .header('X-Tile-Cache', 'hit')
        .send(cached);
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM}/${zoom}/${tileX}/${tileY}.png`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      req.log.warn({ err, zoom, tileX, tileY }, 'tile fetch failed');
      // Serve a stale tile rather than a hole in the map if we have one.
      const stale = await fs.readFile(file).catch(() => null);
      if (stale) {
        return reply.header('Content-Type', 'image/png').header('X-Tile-Cache', 'stale').send(stale);
      }
      return reply.code(502).send({ error: 'tile_upstream_unavailable' });
    }

    if (!upstream.ok) {
      req.log.warn({ status: upstream.status, zoom, tileX, tileY }, 'tile upstream error');
      return reply.code(502).send({ error: 'tile_upstream_error' });
    }

    const body = Buffer.from(await upstream.arrayBuffer());

    // Write via a temp file so a crash mid-write cannot leave a truncated
    // PNG that would then be served from cache forever.
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);

    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=604800')
      .header('X-Tile-Cache', 'miss')
      .send(body);
  });
}

async function readIfFresh(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > MAX_AGE_MS) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}
