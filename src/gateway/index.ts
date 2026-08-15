/**
 * Device TCP gateway.
 *
 * Listens on a bare port for JT701D/E locks. This is deliberately NOT behind
 * Nginx: the devices speak a binary/ASCII protocol over raw TCP with no HTTP
 * involved anywhere, so a reverse proxy has nothing to contribute.
 */

import net from 'node:net';
import { config } from '../config.ts';
import { createListener, pool } from '../db.ts';
import { DeviceSession } from './session.ts';
import { clearAllConnections, requeueUnansweredCommands } from './store.ts';
import { evaluationPeriod } from '../evaluation.ts';

/**
 * Live sockets by device ID. In-memory is correct at single-instance scale;
 * running multiple gateway processes would need a shared registry so the API
 * can route a command to whichever instance holds the socket.
 */
const sessions = new Map<string, DeviceSession>();

const server = net.createServer((socket) => {
  socket.setNoDelay(true);

  new DeviceSession(socket, {
    onIdentified(deviceId, session) {
      // A device reconnecting before the old socket's FIN arrives is routine
      // on cellular. Newest socket wins; drop the stale one.
      const existing = sessions.get(deviceId);
      if (existing && existing !== session) {
        existing.log('superseded by a new connection');
        existing.socket.destroy();
      }
      sessions.set(deviceId, session);

      // Devices sleep, so this is usually the only moment we can reach them.
      void session.drainCommands();
    },
    onClosed(deviceId, session) {
      if (deviceId && sessions.get(deviceId) === session) sessions.delete(deviceId);
    },
  });
});

server.on('error', (err) => {
  console.error('[gateway] server error', err);
  process.exit(1);
});

async function main(): Promise<void> {
  await pool.query('SELECT 1');
  console.log('[gateway] database connection ok');

  // No sockets exist yet, so any surviving "connected" flag is stale.
  const cleared = await clearAllConnections();
  if (cleared > 0) console.log(`[gateway] cleared ${cleared} stale connection flag(s)`);

  // Dispatch the instant a command is queued, instead of polling.
  const listener = await createListener('command_queued', (deviceId) => {
    const session = sessions.get(deviceId);
    if (session) {
      void session.drainCommands();
    } else {
      console.log(`[gateway] ${deviceId} command queued but device is offline; will send on connect`);
    }
  });
  console.log('[gateway] listening for command_queued notifications');

  // A command held by not_before becomes due while the device may already be
  // connected, and NOTIFY only fires on insert. Sweep the live sessions so
  // scheduled work is not stranded until the next reconnect.
  setInterval(() => {
    void (async () => {
      // A command written into a dying socket is lost with no error. Put
      // unanswered ones back in the queue before draining, so the retry goes
      // out on this pass rather than the next.
      const requeued = await requeueUnansweredCommands().catch(() => 0);
      if (requeued > 0) console.log(`[gateway] re-queued ${requeued} unanswered command(s)`);
      for (const session of sessions.values()) await session.drainCommands();
    })();
  }, 60_000).unref();

  /**
   * Evaluation-period expiry: stop accepting devices and drop the connected
   * ones. See src/evaluation.ts and README "Evaluation period".
   *
   * Closing the listener is what stops arrival unlocks too. They are evaluated
   * from incoming positions, so with no positions arriving there is no path
   * left that can open a lock on its own — which is the behaviour we want, and
   * not something to leave to a second check somewhere else.
   *
   * The process stays alive and inert. Restart=always means exiting here would
   * restart-loop every five seconds and bury the reason in the log.
   */
  const stopWatching = evaluationPeriod.watch(() => {
    console.error(`[gateway] ${evaluationPeriod.banner()}`);
    server.close();
    for (const session of sessions.values()) session.socket.destroy();
    sessions.clear();
    void clearAllConnections().catch(() => {});
  });

  if (evaluationPeriod.isExpired()) {
    // Already lapsed at boot: never open the port in the first place.
    console.error(`[gateway] ${evaluationPeriod.banner()}`);
  } else {
    if (evaluationPeriod.enabled) {
      console.log(
        `[gateway] evaluation period active — ${evaluationPeriod.daysRemaining()} day(s) left, ends ${evaluationPeriod.expiresAt?.toISOString().slice(0, 10)}`,
      );
    }
    server.listen(config.gateway.port, config.gateway.host, () => {
      console.log(`[gateway] listening on ${config.gateway.host}:${config.gateway.port}`);
      console.log(`[gateway] device allowlist ${config.requireKnownDevice ? 'ENFORCED' : 'DISABLED (dev only)'}`);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[gateway] ${signal} received, shutting down`);
    stopWatching();
    server.close();
    for (const session of sessions.values()) session.socket.destroy();
    await listener.end().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[gateway] failed to start', err);
  process.exit(1);
});
