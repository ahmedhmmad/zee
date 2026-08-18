import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const COOKIE_NAME = 'zee_session';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/**
 * Test-box escape hatch: with AUTH_DISABLED=true there is no login at all.
 * Intended for development against the simulator, where there is nothing to
 * protect. Must not be set once real vehicles are connected.
 */
const authDisabled = process.env.AUTH_DISABLED === 'true';

/** Single shared operator password. Not required when auth is disabled. */
const password = authDisabled ? '' : required('AUTH_PASSWORD');
const cookieSecret = process.env.COOKIE_SECRET ?? crypto.randomBytes(32).toString('hex');

if (authDisabled) {
  console.warn('[api] AUTH_DISABLED=true — the UI and unlock endpoint are OPEN. Development only.');
}

export const apiConfig = {
  /**
   * Google Maps browser key. Optional — without it the UI falls back to the
   * proxied OpenStreetMap basemap.
   *
   * Google's terms forbid proxying or caching their tiles, so unlike OSM this
   * cannot be served through our own gateway: each browser talks to Google
   * directly. Restrict the key by HTTP referrer in the Cloud console, since a
   * browser key is by nature public.
   */
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',

  /**
   * ArcGIS Maps SDK key, from the client's own Esri licence.
   *
   * Like the Google key this is a browser key and therefore public by nature:
   * it is sent to every console that loads the map. Restrict it in the ArcGIS
   * Location Platform console by referrer, and note that Esri keys carry
   * per-service scopes - a key without the basemap scope authenticates fine
   * and then serves no tiles, which looks like a broken map rather than a
   * misconfigured key.
   */
  arcgisApiKey: process.env.ARCGIS_API_KEY ?? '',

  /**
   * Which SDK release to load from Esri's CDN.
   *
   * Configurable because Esri retires CDN versions on their own schedule, and
   * when one goes the console breaks for everyone at once. Bumping an .env
   * value and restarting is a five-minute fix; a code release is not.
   */
  arcgisVersion: process.env.ARCGIS_VERSION || '4.31',

  port: Number(process.env.API_PORT ?? 3333),
  // Bind loopback only: Nginx is the sole ingress, so the app must not be
  // reachable directly even if a firewall rule is wrong.
  host: process.env.API_HOST ?? '127.0.0.1',
  cookieSecret,
  cookieName: COOKIE_NAME,

  /** Constant-time comparison, so the password can't be probed by timing. */
  checkPassword(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(password);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },

  authDisabled,

  isAuthenticated(req: FastifyRequest): boolean {
    if (authDisabled) return true;
    const raw = req.cookies[COOKIE_NAME];
    if (!raw) return false;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value === 'ok';
  },
} as const;
