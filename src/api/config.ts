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
 * protect.
 *
 * It opens the UI *and the unlock endpoint*, on one environment variable. On a
 * platform where an open endpoint means an open valve on a tanker full of
 * petrol, "must not be set in production" written in a comment is not a
 * control. So it is one now: the process refuses to start unless NODE_ENV says
 * development in as many words.
 *
 * Unset NODE_ENV refuses too. Defaulting to "assume this is real" is the only
 * safe direction, and it makes the decision explicit on the one box where it is
 * wanted rather than implicit on every box where it is not.
 */
const authDisabled = process.env.AUTH_DISABLED === 'true';
const nodeEnv = process.env.NODE_ENV ?? '';

if (authDisabled && nodeEnv !== 'development') {
  throw new Error(
    'AUTH_DISABLED=true requires NODE_ENV=development. It opens the console AND the ' +
      `unlock endpoint to anyone who can reach the port; NODE_ENV is ${nodeEnv || 'unset'}. ` +
      'If this really is a development box, set NODE_ENV=development. If it is not, ' +
      'remove AUTH_DISABLED and log in.',
  );
}

/**
 * The legacy shared operator password.
 *
 * No longer an authentication mechanism in its own right: it exists only to be
 * turned into the `operator` account on the first start after named users
 * landed, so a live deployment is not locked out mid-rollout. See
 * seedFromSharedPassword in users.ts.
 */
const sharedPassword = authDisabled ? '' : required('AUTH_PASSWORD');
const cookieSecret = process.env.COOKIE_SECRET ?? crypto.randomBytes(32).toString('hex');

if (authDisabled) {
  console.warn('[api] AUTH_DISABLED=true — the UI and unlock endpoint are OPEN. Development only.');
}

export const apiConfig = {
  /**
   * ArcGIS key, from the client's own Esri licence. Optional.
   *
   * No longer a basemap: the console draws one map, MapLibre over proxied
   * OpenStreetMap. This key buys exactly one thing — the road route drawn to
   * an arrival point, from Esri's routing service. Without it the destination
   * still appears, joined by a straight line.
   *
   * A browser key, and therefore public by nature: it is sent to every console
   * that loads the map. Restrict it by referrer in the ArcGIS Location
   * Platform console.
   */
  arcgisApiKey: process.env.ARCGIS_API_KEY ?? '',

  port: Number(process.env.API_PORT ?? 3333),
  // Bind loopback only: Nginx is the sole ingress, so the app must not be
  // reachable directly even if a firewall rule is wrong.
  host: process.env.API_HOST ?? '127.0.0.1',
  cookieSecret,
  cookieName: COOKIE_NAME,

  /** Seeded into the `operator` account on first start. Not a login path. */
  sharedPassword,

  authDisabled,

  /**
   * The user id in the session cookie, or null.
   *
   * The cookie used to carry the literal string 'ok'. It said that somebody had
   * once known the password and nothing else — not who, not whether they are
   * still allowed in. Now it carries the users.id, so every request can be
   * attributed and a deactivated account stops working at its next request
   * rather than at its next login.
   *
   * With auth disabled there is no session and no identity; callers treat that
   * as the development escape hatch it is.
   */
  sessionUserId(req: FastifyRequest): number | null {
    const raw = req.cookies[COOKIE_NAME];
    if (!raw) return null;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    const id = Number(unsigned.value);
    return Number.isInteger(id) && id > 0 ? id : null;
  },

  isAuthenticated(req: FastifyRequest): boolean {
    if (authDisabled) return true;
    return this.sessionUserId(req) !== null;
  },
} as const;

/**
 * A fixed-window counter, per key.
 *
 * Guards login and unlock. Both are cheap to attempt and expensive to get
 * wrong: five consecutive wrong passwords trips an alarm on the device itself,
 * and an unlock is a valve opening. Counted per user AND per IP, because either
 * on its own is trivially sidestepped — one account from a botnet, or one
 * address trying every username.
 *
 * In-memory, which is the honest scope of it: it is per API process and resets
 * on restart. That is enough to stop a script, and this is not the place to
 * take a dependency or a Redis. Phase 2 can make it shared if it needs to be.
 */
export class RateLimiter {
  #hits = new Map<string, { count: number; resetAt: number }>();
  // Written out rather than declared as constructor parameter properties:
  // Node's type stripping erases types, it does not compile them away, so
  // parameter properties are not available here.
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** True if this attempt is allowed; false if the key is over its limit. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.#hits.get(key);

    if (!entry || now >= entry.resetAt) {
      this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
      // Bounded cleanup: without it a long-running process accumulates one
      // entry per address that ever touched the login page.
      if (this.#hits.size > 10_000) this.#sweep(now);
      return true;
    }

    entry.count++;
    return entry.count <= this.limit;
  }

  /** Forget a key — called on a successful login, so a typo costs nothing. */
  clear(key: string): void {
    this.#hits.delete(key);
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#hits) {
      if (now >= entry.resetAt) this.#hits.delete(key);
    }
  }
}
