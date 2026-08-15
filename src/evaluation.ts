/**
 * Evaluation-period check.
 *
 * This platform is deployed for a fixed evaluation period agreed with the
 * client. Continued use past that period depends on approval, which is a
 * documented, disclosed term of the pilot agreement — not a hidden trigger.
 * The check is deliberately plain and readable so the client's own team can
 * find and understand it.
 *
 * How it works:
 *   - An expiry date is written to EVALUATION_EXPIRES_AT in .env at deploy
 *     time (deploy date + the agreed pilot length).
 *   - Before that date the platform runs completely normally — no banners, no
 *     countdown shown to end users.
 *   - After it, the API and the device gateway stop serving and say so. The
 *     locks and all data are untouched.
 *
 * Reversible: updating EVALUATION_EXPIRES_AT (e.g. once the deal is approved,
 * or to remove the limit by leaving it blank) and restarting the two services
 * brings everything back exactly as it was. Nothing is ever deleted.
 *
 * Not hardened against tampering, by design: no remote call, no signing. A
 * plain local date comparison is trivially bypassable by editing .env or the
 * system clock, and for a disclosed pilot that is an accepted trade-off rather
 * than something to engineer around. See README "Evaluation period".
 *
 * To remove the limit entirely: leave EVALUATION_EXPIRES_AT empty (or delete
 * the line) and restart. `enabled` then reads false and every check is inert.
 */

const DAY_MS = 86_400_000;

const raw = (process.env.EVALUATION_EXPIRES_AT ?? '').trim();

function parse(value: string): Date | null {
  if (!value) return null;
  // A bare YYYY-MM-DD means the whole of that day is still inside the pilot,
  // which is what "expires on the 15th" means to everyone who is not a
  // computer. Anything longer is taken as a full ISO instant.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const expiresAt = parse(raw);

// Fail loudly rather than silently granting an unlimited pilot: a typo here
// would otherwise be indistinguishable from a deliberate blank.
if (raw && !expiresAt) {
  throw new Error(
    `EVALUATION_EXPIRES_AT is not a valid date: "${raw}". Use YYYY-MM-DD, or leave it empty for no limit.`,
  );
}

export const evaluationPeriod = {
  /** False when EVALUATION_EXPIRES_AT is unset: an ordinary unlimited deploy. */
  enabled: expiresAt !== null,
  expiresAt,

  /** The one question the gates ask: are we past the agreed date? */
  isExpired(now: number = Date.now()): boolean {
    return expiresAt !== null && now >= expiresAt.getTime();
  },

  /** For the admin-facing startup log only; not surfaced to end users. */
  daysRemaining(now: number = Date.now()): number | null {
    if (expiresAt === null) return null;
    return Math.max(Math.ceil((expiresAt.getTime() - now) / DAY_MS), 0);
  },

  /**
   * Run `onExpiry` the moment the period lapses, or immediately if it already
   * has. Returns a stop function.
   *
   * Polled rather than scheduled with a single setTimeout: a two-month pilot
   * is ~5.2e9 ms and setTimeout overflows past 2^31-1 (~24.8 days), firing
   * immediately instead. That failure mode ends with a fleet losing remote
   * unlocking on day one, so it is worth the interval.
   */
  watch(onExpiry: () => void, intervalMs = 60_000): () => void {
    if (expiresAt === null) return () => {};
    if (this.isExpired()) {
      onExpiry();
      return () => {};
    }
    const timer = setInterval(() => {
      if (evaluationPeriod.isExpired()) {
        clearInterval(timer);
        onExpiry();
      }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },

  /** One line for the service logs, in both languages. */
  banner(): string {
    return (
      `EVALUATION PERIOD ENDED on ${expiresAt?.toISOString().slice(0, 10)} — the platform has ` +
      `stopped serving. Update EVALUATION_EXPIRES_AT and restart to resume. ` +
      `انتهت فترة التقييم — تم إيقاف المنظومة.`
    );
  },
} as const;
