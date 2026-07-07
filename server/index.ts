import { buildApp } from './app.js';
import { bootstrap, resolveHome } from './bootstrap.js';

/** Default dashboard/ingest port (overridable via GLASSRAY_PORT or PORT). */
const DEFAULT_PORT = 5899;

/** Parses a port from the environment, falling back to the default on absence or garbage. */
const resolvePort = (): number => {
  const raw = process.env.GLASSRAY_PORT ?? process.env.PORT;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : DEFAULT_PORT;
};

const home = resolveHome();
const port = resolvePort();
const runtime = await bootstrap(home);
const app = await buildApp({ runtime, port });

// Loopback only — never expose the coach beyond this machine.
await app.listen({ port, host: '127.0.0.1' });

console.log('glassray is running');
console.log(`  dashboard  http://127.0.0.1:${port}/`);
console.log(`  ingest     http://127.0.0.1:${port}/v1/traces`);
console.log(`  data dir   ${home}`);

/** Graceful shutdown: close HTTP (which also closes PGlite via the app's onClose hook). */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
