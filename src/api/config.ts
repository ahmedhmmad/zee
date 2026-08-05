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
