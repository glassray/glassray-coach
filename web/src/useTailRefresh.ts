import { useEffect, useRef, useState } from "react";
import { subscribeTail } from "./api";

/**
 * Re-run `onChange` (debounced) whenever a new trace lands on the /api/tail SSE
 * stream, so a view stays live without a manual refresh. The latest callback is
 * always used, so callers can pass an inline closure without re-subscribing.
 * Returns whether the stream is currently connected, so a "live" badge can dim
 * when it drops (starts optimistically `true` to avoid a flash on first paint).
 */
export const useTailRefresh = (onChange: () => void, debounceMs = 500): boolean => {
  const cb = useRef(onChange);
  cb.current = onChange;
  const [live, setLive] = useState(true);
  useEffect(() => {
    let timer: number | undefined;
    const unsub = subscribeTail(
      () => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => cb.current(), debounceMs);
      },
      (isLive) => setLive(isLive),
    );
    return () => {
      if (timer) window.clearTimeout(timer);
      unsub();
    };
  }, [debounceMs]);
  return live;
};
