/**
 * Fake JT701D for development.
 *
 * Connects to the gateway and behaves like a real lock: reports position on an
 * interval, sends heartbeats, and responds to unlock commands with a P45
 * report the way real firmware does.
 *
 * Drives a loop around Tripoli so the map has something to show.
 *
 *   npm run simulate <deviceId> [host] [port]
 *
 *   npm run simulate 8000620011
 *   npm run simulate 8000620011 gw.ahmedhammad.page
 *
 * Arguments rather than environment variables, so the same line works in
 * cmd.exe, PowerShell and bash without modification.
 *
 * The behaviour itself lives in simulated-device.ts, shared with the fleet
 * simulator. This file is only the command line around it.
 */

import { SimulatedDevice } from './simulated-device.ts';

const deviceId = process.argv[2] ?? '8000620011';
const host = process.argv[3] ?? process.env.SIM_HOST ?? '127.0.0.1';
const port = Number(process.argv[4] ?? process.env.SIM_PORT ?? process.env.GATEWAY_PORT ?? 10001);
const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 10_000);
const password = process.env.SIM_PASSWORD ?? '888888';

const device = new SimulatedDevice({
  deviceId,
  host,
  port,
  intervalMs,
  password,
  verbose: true,
  onEvent: (e) => {
    // Single-device runs exited when the socket closed; keep that.
    if (e.kind === 'disconnected') process.exit(0);
  },
});

device.connect();
