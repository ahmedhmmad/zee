function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  gateway: {
    port: Number(process.env.GATEWAY_PORT ?? 10001),
    host: process.env.GATEWAY_HOST ?? '0.0.0.0',
    /**
     * Devices in standby report at least every 30 minutes and heartbeat when
     * awake. Three minutes of total silence on an open socket means the peer
     * is gone but the FIN never arrived — common on cellular networks.
     */
    idleTimeoutMs: Number(process.env.GATEWAY_IDLE_TIMEOUT_MS ?? 180_000),
    /**
     * A real device sends a frame immediately on connect. An open port on the
     * public internet attracts constant scanning, so anything that connects
     * and says nothing is dropped quickly and logged quietly - otherwise the
     * noise buries the one device you actually care about.
     */
    handshakeTimeoutMs: Number(process.env.GATEWAY_HANDSHAKE_TIMEOUT_MS ?? 30_000),
    /**
     * How many buffered positions one device may replay per second.
     *
     * A truck returning from a four-hour coverage gap dumps ~480 frames, and a
     * regional outage returns two hundred of them together. Uncapped, one
     * backlog takes the connection pool and the trucks reporting live queue
     * behind it. Nothing is dropped — the replay is just paced, which reaches
     * the device as TCP backpressure because the socket stays paused.
     *
     * 20/s clears a four-hour gap in about 25 seconds, which is far faster than
     * anyone needs history to land. Set to 0 to disable the limit.
     */
    replayFramesPerSecond: Number(process.env.GATEWAY_REPLAY_FRAMES_PER_SEC ?? 20),
  },
  databaseUrl: required('DATABASE_URL'),
  /**
   * Reject frames from device IDs not in the devices table. The protocol has
   * no authentication whatsoever, so this allowlist is the only barrier
   * against forged telemetry. Keep it on.
   */
  requireKnownDevice: (process.env.REQUIRE_KNOWN_DEVICE ?? 'true') !== 'false',
  /**
   * Whether valve sub-lock unlocking may be used at all. OFF by default.
   *
   * A JT709 sub-lock unlock currently has no confirmation path. The WLNET,8
   * reply is a bare echo from the master with no success flag, and the only
   * real evidence is the sub-lock reporting itself open — which it does over
   * LoRa only when it is awake. A sleeping sub-lock says nothing, so a queued
   * unlock can sit for hours and then fire on a wake nobody is expecting, with
   * the platform unable to say whether it did.
   *
   * Whether enabling the LoRa heartbeat gives that confirmation path is NOT
   * documented — see the comment on `wlnetSetHeartbeat` in
   * src/protocol/encode.ts. It is plausible and untested, and a bench test on
   * real hardware is what answers it. Until then this stays off: an unlock
   * whose execution cannot be evidenced should not be shipped for a valve on a
   * tanker full of petrol.
   *
   * Master-lock unlocking is unaffected.
   */
  subLockUnlockEnabled: process.env.SUBLOCK_UNLOCK_ENABLED === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
