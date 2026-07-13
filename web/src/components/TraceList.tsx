import { useCallback, useEffect, useRef, useState } from "react";
import type { Info, StatsResponse, TraceFilters, TraceListItem } from "../api";
import { fetchInfo, fetchStats, fetchTraces } from "../api";
import { formatDuration, formatNumber, formatTokens, relativeTime, truncate } from "../format";
import { useTailRefresh } from "../useTailRefresh";
import { Recipes } from "./Recipes";

/** How many trace rows are fetched per page (and per "Load more"). */
const PAGE = 50;

/** Format a rough USD cost estimate compactly (<$0.01 shown as such). */
const formatCost = (usd: number): string => {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
};

/** The token/latency/cost rollup strip shown above the trace table. */
const StatsStrip = ({ stats }: { stats: StatsResponse }) => {
  const { totals } = stats;
  const cells: Array<{ label: string; value: string; hint?: string }> = [
    { label: "Traces", value: formatNumber(totals.traces) },
    { label: "Errors", value: formatNumber(totals.errors) },
    { label: "Tokens", value: `${formatNumber(totals.tokensIn)} → ${formatNumber(totals.tokensOut)}` },
    { label: "Est. cost", value: formatCost(totals.estCostUsd), hint: "rough provider-blended estimate" },
    { label: "Latency avg", value: formatDuration(totals.avgDurationMs) },
    { label: "Latency p95", value: formatDuration(totals.p95DurationMs) },
  ];
  return (
    <div className="stats-strip">
      {cells.map((c) => (
        <div className="stat-cell" key={c.label} title={c.hint}>
          <span className="stat-label">{c.label}</span>
          <span className="stat-value mono">{c.value}</span>
        </div>
      ))}
    </div>
  );
};

/** A small colored dot conveying trace/span status (ok / error / unknown). */
export const StatusDot = ({ status }: { status: TraceListItem["status"] }) => {
  const kind = status === "ok" ? "ok" : status === "error" ? "error" : "null";
  const label = status ?? "unknown";
  return <span className={`dot dot-${kind}`} title={label} aria-label={label} />;
};

/** Copyable code block used by the empty state to advertise the OTLP endpoint. */
export const CopyBlock = ({ snippet }: { snippet: string }) => {
  const [copied, setCopied] = useState(false);

  /** Copy the snippet to the clipboard and briefly flip the button label. */
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(snippet).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [snippet]);

  return (
    <div className="codeblock">
      <button className="codeblock-copy" onClick={copy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>
        <code>{snippet}</code>
      </pre>
    </div>
  );
};

/** Shown when no traces exist yet: hand the setup to a coding agent, or instrument by hand. */
export const EmptyState = ({ info }: { info: Info | null }) => (
  <div className="empty">
    <div className="empty-pulse" aria-hidden="true" />
    <h2 className="empty-title">Waiting for traces</h2>
    <p className="empty-sub">
      Let your coding agent set everything up, or instrument by hand — pick your setup:
    </p>
    {/* Wait for the real endpoint + key before showing copy-paste recipes, so a
        user never copies a snippet with the wrong port or a placeholder key. */}
    {info ? (
      <Recipes endpoint={info.ingestEndpoint} apiKey={info.apiKey} agentPrompt={info.agentPrompt} />
    ) : (
      <p className="empty-hint">Loading your local ingest endpoint…</p>
    )}
    <p className="empty-hint">New traces appear live — no refresh needed.</p>
  </div>
);

/** The default view: a live, newest-first table of captured traces. */
export const TraceList = () => {
  const [items, setItems] = useState<TraceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [info, setInfo] = useState<Info | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [filters, setFilters] = useState<TraceFilters>({});
  const [loadingMore, setLoadingMore] = useState(false);
  /** The search box's raw text, debounced into `filters.q` below. */
  const [queryText, setQueryText] = useState("");
  /** How many rows are currently paged in — a ref so a tail refresh preserves depth without re-subscribing. */
  const shownCount = useRef(0);
  /** Bumped by every full reload so an in-flight loadMore can discard a now-stale append. */
  const loadGen = useRef(0);
  /** Whether any page has loaded, so a background-refresh failure doesn't wipe a populated view. */
  const hasData = useRef(false);

  /** Reload from offset 0, keeping the user's paged-in depth (honoring filters) + the rollups. */
  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    const want = Math.max(shownCount.current, PAGE);
    try {
      const [res, s] = await Promise.all([fetchTraces(filters, want, 0), fetchStats()]);
      if (gen !== loadGen.current) return; // a newer reload superseded this one
      setItems(res.items);
      setTotal(res.total);
      setStats(s);
      shownCount.current = res.items.length;
      hasData.current = true;
      setStatus("ready");
    } catch {
      // Only surface the fatal error if nothing has loaded yet; a transient
      // failure on a background (tail) refresh keeps the good data on screen.
      if (!hasData.current) setStatus("error");
    }
  }, [filters]);

  /** Append the next page of traces (offset = rows already shown), discarding the result if a reload intervened. */
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const gen = loadGen.current;
    try {
      const res = await fetchTraces(filters, PAGE, items.length);
      if (gen !== loadGen.current) return; // a reload reset the list — drop this stale page
      setItems((prev) => {
        const next = [...prev, ...res.items];
        shownCount.current = next.length;
        return next;
      });
      setTotal(res.total);
    } catch {
      /* keep what's shown */
    } finally {
      setLoadingMore(false);
    }
  }, [filters, items.length, loadingMore]);

  // Reset paged-in depth whenever the filters change (load() then refills).
  useEffect(() => {
    shownCount.current = 0;
    void load();
  }, [load]);

  useEffect(() => {
    void fetchInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  // Debounced, resubscribe-safe live refresh (replaces a raw per-event reload).
  const live = useTailRefresh(() => void load());

  // Debounce the search box into the filter that drives the query.
  useEffect(() => {
    const t = window.setTimeout(
      () => setFilters((f) => ({ ...f, q: queryText.trim() || undefined })),
      250,
    );
    return () => window.clearTimeout(t);
  }, [queryText]);

  if (status === "loading") {
    return <div className="notice">Loading traces…</div>;
  }
  if (status === "error") {
    return <div className="notice notice-error">Could not reach the local Coach server.</div>;
  }
  // The empty state (instrument-your-agent) shows only when NOTHING is captured
  // — not merely when a filter matches nothing.
  const nothingCaptured = (stats?.totals.traces ?? 0) === 0;
  if (nothingCaptured) {
    return <EmptyState info={info} />;
  }

  /** Toggle a filter key, clearing it when it already holds `value`. */
  const toggle = <K extends keyof TraceFilters>(key: K, value: TraceFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));

  return (
    <section className="list">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Traces</h1>
          <p className="page-sub">Every run your agents send, newest first.</p>
        </div>
        <span className="list-count">
          <span className={`live-dot${live ? "" : " live-dot-off"}`} aria-hidden="true" title={live ? "live" : "reconnecting…"} />
          {formatNumber(total)} {total === 1 ? "trace" : "traces"}
        </span>
      </div>
      {stats ? <StatsStrip stats={stats} /> : null}
      <div className="filter-bar">
        <input
          className="filter-search"
          type="search"
          placeholder="Search name or agent…"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
        />
        <select
          className="filter-select"
          value={filters.agent ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, agent: e.target.value || undefined }))}
        >
          <option value="">All agents</option>
          {(stats?.agents ?? []).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`filter-toggle${filters.status === "error" ? " filter-toggle-active" : ""}`}
          onClick={() => toggle("status", "error")}
        >
          Errors only
        </button>
        {filters.q || filters.agent || filters.status ? (
          <button
            type="button"
            className="filter-clear"
            onClick={() => {
              setQueryText("");
              setFilters({});
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="notice">No traces match these filters.</div>
      ) : (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="col-status" />
              <th>Name</th>
              <th>Agent</th>
              <th className="col-num">Age</th>
              <th className="col-num">Duration</th>
              <th className="col-num">Spans</th>
              <th className="col-num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                className={`row${item.status === "error" ? " row-error" : ""}`}
                onClick={() => {
                  window.location.hash = `#/trace/${encodeURIComponent(item.id)}`;
                }}
              >
                <td className="col-status">
                  <StatusDot status={item.status} />
                </td>
                <td>
                  <a className="cell-name cell-link" href={`#/trace/${encodeURIComponent(item.id)}`}>
                    {item.name ?? "Untitled trace"}
                  </a>
                  {item.inputPreview ? <div className="cell-preview">{truncate(item.inputPreview, 96)}</div> : null}
                </td>
                <td>{item.agent ? <span className="tag">{item.agent}</span> : <span className="muted">—</span>}</td>
                <td className="col-num muted">{relativeTime(item.startedAt)}</td>
                <td className="col-num mono">{formatDuration(item.durationMs)}</td>
                <td className="col-num mono">{formatNumber(item.spanCount)}</td>
                <td className="col-num mono">{formatTokens(item.tokensIn, item.tokensOut)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {items.length > 0 && items.length < total ? (
        <div className="load-more">
          <button className="btn btn-ghost" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : `Load more (${formatNumber(total - items.length)} more)`}
          </button>
        </div>
      ) : null}
    </section>
  );
};
