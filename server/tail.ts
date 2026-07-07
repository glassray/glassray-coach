import type { ServerResponse } from 'node:http';

/** SSE heartbeat cadence — comment frames keep idle /api/tail streams from being timed out. */
const HEARTBEAT_MS = 25_000;

/** Hub for /api/tail server-sent events: tracks clients, broadcasts ingested trace ids, heartbeats. */
export type TailHub = {
  register: (res: ServerResponse) => void;
  broadcast: (traceId: string) => void;
  close: () => void;
};

/** Creates the SSE hub used by /api/tail and the ingest handler. */
export const createTailHub = (): TailHub => {
  const clients = new Set<ServerResponse>();
  const heartbeats = new Map<ServerResponse, NodeJS.Timeout>();

  /** Detaches one client and stops its heartbeat. */
  const drop = (res: ServerResponse): void => {
    const timer = heartbeats.get(res);
    if (timer) clearInterval(timer);
    heartbeats.delete(res);
    clients.delete(res);
  };

  return {
    register: (res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
      timer.unref();
      heartbeats.set(res, timer);
      res.on('close', () => drop(res));
      res.on('error', () => drop(res));
    },
    broadcast: (traceId) => {
      const frame = `data: ${JSON.stringify({ id: traceId })}\n\n`;
      for (const res of clients) res.write(frame);
    },
    close: () => {
      for (const res of [...clients]) {
        drop(res);
        res.end();
      }
    },
  };
};
