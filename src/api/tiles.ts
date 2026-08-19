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

/**
 * Upstreams, as templates.
 *
 * A template rather than a base URL because providers disagree on both the
 * axis order and the extension: OpenStreetMap serves {z}/{x}/{y}.png, Esri
 * serves {z}/{y}/{x} with no extension. Swapping only the host would fetch
 * transposed tiles - a map that renders perfectly and shows the wrong place.
 *
 * A fixed table, never a URL from the request, so this cannot be turned into
 * an open proxy for fetching arbitrary hosts through our server.
 */
export const PROVIDERS: Record<string, { url: string; attribution: string }> = {
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
  },
  // Esri World Imagery: satellite, free, no API key. Labels are not baked in -
  // it is imagery only - which is the trade against Google's street data.
  esri: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, Maxar, Earthstar Geographics',
  },
  // Boundaries and settlement names, transparent, to overlay the imagery.
  //
  // Sparse on its own: over Tripoli this returns roughly 2.6 KB at zoom 15
  // against 16 KB from the transportation layer below, because it carries
  // administrative boundaries and major place names rather than streets. Used
  // alone it reads as "the satellite view has no labels".
  'esri-labels': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri',
  },
  // Street and road names. This is the layer that makes imagery navigable:
  // without it an operator can see a depot but cannot say which road it is on.
  'esri-transport': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri',
  },
};

const DEFAULT_PROVIDER = process.env.TILE_PROVIDER ?? 'osm';

export function upstreamUrl(provider: string, z: number, x: number, y: number): string | null {
  const entry = PROVIDERS[provider];
  if (!entry) return null;
  return entry.url
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * OSM's policy requires a User-Agent identifying the application. Anonymous
 * or default agents get blocked.
 */
const USER_AGENT =
  process.env.TILE_USER_AGENT ?? 'ZeeLockPlatform/0.1 (fleet monitoring; +https://locks.ahmedhammad.page)';

/**
 * Content type from the magic bytes, not from a hardcoded assumption.
 *
 * Providers disagree: OpenStreetMap serves PNG, Esri's World Imagery serves
 * JPEG despite a URL that looks nothing like it, and Esri's labels layer is
 * PNG again because it needs transparency. Declaring everything image/png
 * leaves browsers to sniff their way out of it, which they mostly do - until
 * one does not, and the map is blank for that user only.
 */
export function imageType(buf: Buffer): string {
  return buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
}

const MAX_ZOOM = 19;
/** Tiles are effectively immutable; refetch monthly to pick up map edits. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function tileRoutes(app: FastifyInstance): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  /** Which basemaps the console may offer, so the UI does not hardcode them. */
  app.get('/api/tiles/providers', async () => ({
    default: DEFAULT_PROVIDER,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, attribution: p.attribution })),
  }));

  const serveTile = async (req: any, reply: any) => {
    const { provider = DEFAULT_PROVIDER, z, x, y } = req.params as {
      provider?: string; z: string; x: string; y: string;
    };

    if (!PROVIDERS[provider]) return reply.code(404).send({ error: 'unknown_tile_provider' });

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

    // Cached per provider: the same z/x/y means a different image for each,
    // and sharing one directory would serve satellite tiles to the street map.
    // The .png suffix here is only a filename - the bytes may be JPEG, and the
    // type sent to the browser is read back from them.
    const file = path.join(CACHE_DIR, provider, String(zoom), String(tileX), `${tileY}.png`);

    const cached = await readIfFresh(file);
    if (cached) {
      return reply
        .header('Content-Type', imageType(cached))
        .header('Cache-Control', 'public, max-age=604800')
        .header('X-Tile-Cache', 'hit')
        .send(cached);
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl(provider, zoom, tileX, tileY)!, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      req.log.warn({ err, zoom, tileX, tileY }, 'tile fetch failed');
      // Serve a stale tile rather than a hole in the map if we have one.
      const stale = await fs.readFile(file).catch(() => null);
      if (stale) {
        return reply.header('Content-Type', imageType(stale)).header('X-Tile-Cache', 'stale').send(stale);
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
      .header('Content-Type', imageType(body))
      .header('Cache-Control', 'public, max-age=604800')
      .header('X-Tile-Cache', 'miss')
      .send(body);
  };

  // Provider-qualified, plus the original unqualified path kept as an alias so
  // consoles cached in a browser from before this change keep working.
  app.get('/api/tiles/:provider/:z/:x/:y.png', serveTile);
  app.get('/api/tiles/:z/:x/:y.png', serveTile);
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
