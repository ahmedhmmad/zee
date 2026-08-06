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
  },
  databaseUrl: required('DATABASE_URL'),
  /**
   * Reject frames from device IDs not in the devices table. The protocol has
   * no authentication whatsoever, so this allowlist is the only barrier
   * against forged telemetry. Keep it on.
   */
  requireKnownDevice: (process.env.REQUIRE_KNOWN_DEVICE ?? 'true') !== 'false',
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
