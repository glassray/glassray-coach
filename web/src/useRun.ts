import { useCallback, useEffect, useRef, useState } from "react";
import type { RunHandle, RunStatus } from "./api";
import { cancelRun, fetchRun } from "./api";

/** How often to poll GET /api/runs/:id while a background run is in flight. */
const POLL_INTERVAL_MS = 1500;

/** What useRun exposes: whether a run is in flight, its terminal error, the last finished run, live progress, and the controls. */
export interface RunState {
  running: boolean;
  /** True while the run is still waiting in the server's queue (before it starts executing). */
  queued: boolean;
  error: string | null;
  /** The most recently completed run (done or error), for success/result feedback. */
  lastRun: RunStatus | null;
  /** The in-flight run's mid-run stats (`{ scanned, total }`) for a progress readout, or null. */
  progress: RunStatus["stats"] | null;
  start: () => void;
  /** Cancel the in-flight run (queued or executing); a no-op when nothing is running. */
  cancel: () => void;
}

/** Resolve after `ms` milliseconds; paces the run-status poll loop. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Start-and-poll helper shared by the discovery/flows/eval runners: `start`
 * POSTs via `trigger` (a 202 returning `{ runId, status }` — the server queues
 * runs and dedups repeats, handing back the existing run's id), then polls the
 * run every ~1.5s through `queued` → `running` until it reaches done or error,
 * calling `onDone(run)` on success so the view can refetch its list AND read
 * the finished run's stats.
 */
export const useRun = (
  trigger: () => Promise<RunHandle>,
  onDone: (run: RunStatus) => void,
): RunState => {
  const [running, setRunning] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunStatus | null>(null);
  const [progress, setProgress] = useState<RunStatus["stats"] | null>(null);
  const alive = useRef(true);
  /** The run id currently being polled, so `cancel()` can target it. */
  const currentRunId = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Poll a known runId to its terminal state, surfacing queue position + progress, then settle running/error/lastRun. */
  const poll = useCallback(async (runId: string) => {
    currentRunId.current = runId;
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      if (!alive.current) return;
      const run = await fetchRun(runId);
      if (run.status === "queued") continue;
      if (run.status === "running") {
        setQueued(false);
        setProgress(run.stats ?? null);
        continue;
      }
      if (!alive.current) return;
      currentRunId.current = null;
      setRunning(false);
      setQueued(false);
      setProgress(null);
      setLastRun(run);
      // A user-initiated cancel isn't a failure — settle quietly (no error banner).
      if (run.status === "done") onDoneRef.current(run);
      else if (run.error !== "canceled") setError(run.error ?? "Run failed.");
      return;
    }
  }, []);

  /** Cancel the in-flight run; the poll loop then observes it settle. */
  const cancel = useCallback(() => {
    const id = currentRunId.current;
    if (!id) return;
    void cancelRun(id).catch(() => {});
  }, []);

  /** Trigger the run and poll it to a terminal state; no-op while one is already in flight. */
  const start = useCallback(() => {
    if (running) return;
    setRunning(true);
    setQueued(false);
    setError(null);
    setProgress(null);
    void (async () => {
      try {
        const { runId, status } = await trigger();
        if (!alive.current) return;
        setQueued(status === "queued");
        await poll(runId);
      } catch (err) {
        if (!alive.current) return;
        setRunning(false);
        setQueued(false);
        setError(err instanceof Error ? err.message : "Run failed.");
      }
    })();
  }, [running, trigger, poll]);

  return { running, queued, error, lastRun, progress, start, cancel };
};
