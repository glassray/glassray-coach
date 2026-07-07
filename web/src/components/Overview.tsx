import { useCallback, useEffect, useState } from "react";
import type {
  DeviationItem,
  EvalSummary,
  FlowItem,
  Info,
  StatsResponse,
  TimelineResponse,
  TraceListItem,
  UsageSummary,
} from "../api";
import {
  fetchDeviations,
  fetchEvals,
  fetchFlows,
  fetchInfo,
  fetchStats,
  fetchTimeline,
  fetchTraces,
  fetchUsage,
} from "../api";
import { formatDuration, formatNumber, relativeTime, truncate } from "../format";
import { useTailRefresh } from "../useTailRefresh";
import { ActivityBars, SeverityBar, type SeverityCounts } from "./charts";
import { SeverityChip } from "./Deviations";
import { HealthBadge } from "./Evals";
import { EmptyState, StatusDot } from "./TraceList";
import { UsageCard } from "./UsageCard";

/** Everything the dashboard renders, loaded together so the whole view stays consistent. */
interface OverviewData {
  stats: StatsResponse;
  timeline: TimelineResponse;
  deviations: DeviationItem[];
  evals: EvalSummary[];
  flows: FlowItem[];
  recent: TraceListItem[];
  usage: UsageSummary;
}

/** Compact USD cost estimate (<$0.01 shown as such). */
const formatCost = (usd: number): string => {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
};

/** Tally deviation TYPES by severity for the distribution bar. */
const severityCounts = (deviations: DeviationItem[]): SeverityCounts =>
  deviations.reduce<SeverityCounts>(
    (acc, d) => {
      acc[d.severity] += 1;
      return acc;
    },
    { critical: 0, major: 0, minor: 0 },
  );

/** One headline KPI tile. */
const Kpi = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="kpi" title={hint}>
    <span className="kpi-value mono">{value}</span>
    <span className="kpi-label">{label}</span>
  </div>
);

/** The Overview dashboard (#/): live activity, headline KPIs, deviation + eval health, recent traces. */
export const Overview = () => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  /** Load every panel's data in one shot so the dashboard is internally consistent. */
  const load = useCallback(async () => {
    try {
      const [stats, timeline, deviations, evals, flows, recent, usage] = await Promise.all([
        fetchStats(),
        fetchTimeline(),
        fetchDeviations(),
        fetchEvals(),
        fetchFlows(),
        fetchTraces({}, 6, 0),
        fetchUsage(),
      ]);
      setData({
        stats,
        timeline,
        deviations: deviations.items,
        evals: evals.items,
        flows: flows.items,
        recent: recent.items,
        usage,
      });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  // Live: refresh the whole dashboard when new traces land (dim the badge if the stream drops).
  const live = useTailRefresh(() => void load());

  if (status === "loading") return <div className="notice">Loading dashboard…</div>;
  if (status === "error" || !data) return <div className="notice notice-error">Could not reach the local Coach server.</div>;

  const { stats, timeline, deviations, evals, flows, recent, usage } = data;
  const { totals } = stats;

  // Nothing captured yet → the instrument-your-agent on-ramp.
  if (totals.traces === 0) return <EmptyState info={info} />;

  const errorRate = totals.traces > 0 ? (totals.errors / totals.traces) * 100 : 0;
  const sev = severityCounts(deviations);
  // Roll up eval health across every saved eval.
  const evalHealth = evals.reduce(
    (acc, e) => {
      acc.passed += e.passed;
      acc.failed += e.failed;
      acc.regressions += e.regressionCount;
      return acc;
    },
    { passed: 0, failed: 0, regressions: 0 },
  );

  return (
    <section className="overview">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Everything your agents are doing, on this machine.</p>
        </div>
        <span className="list-count">
          <span className={`live-dot${live ? "" : " live-dot-off"}`} aria-hidden="true" />
          {live ? "live" : "reconnecting…"}
        </span>
      </div>

      <div className="panel card-pad activity-card">
        <div className="card-head">
          <h2 className="card-title">Activity</h2>
          <span className="muted">
            {formatNumber(totals.traces)} traces · {errorRate.toFixed(errorRate < 10 ? 1 : 0)}% errors
          </span>
        </div>
        <ActivityBars points={timeline.points} from={timeline.from} to={timeline.to} />
      </div>

      <div className="kpi-row">
        <Kpi label="Traces" value={formatNumber(totals.traces)} />
        <Kpi label="Error rate" value={`${errorRate.toFixed(errorRate < 10 ? 1 : 0)}%`} hint={`${totals.errors} errors`} />
        <Kpi label="Tokens" value={`${formatNumber(totals.tokensIn)}→${formatNumber(totals.tokensOut)}`} />
        <Kpi
          label="Est. cost"
          value={formatCost(totals.estCostUsd)}
          hint="estimated spend of your traced agent's own LLM calls (not Coach's analysis spend)"
        />
        <Kpi label="Latency p95" value={formatDuration(totals.p95DurationMs)} />
      </div>

      <div className="overview-cols">
        <div className="panel card-pad">
          <div className="card-head">
            <h2 className="card-title">Deviations</h2>
            <a className="card-link" href="#/deviations">
              View all →
            </a>
          </div>
          {deviations.length === 0 ? (
            <p className="muted card-empty">
              None found yet — run discovery to surface recurring failures.
            </p>
          ) : (
            <>
              <SeverityBar counts={sev} />
              <ul className="mini-list">
                {deviations.slice(0, 4).map((d) => (
                  <li key={d.id}>
                    <a className="mini-row" href={`#/deviation/${encodeURIComponent(d.id)}`}>
                      <SeverityChip severity={d.severity} />
                      <span className="mini-name">{d.label}</span>
                      <span className="mono muted">{formatNumber(d.exampleCount)}×</span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="panel card-pad">
          <div className="card-head">
            <h2 className="card-title">Evals</h2>
            <a className="card-link" href="#/evals">
              View all →
            </a>
          </div>
          {evals.length === 0 ? (
            <p className="muted card-empty">
              No evals yet — save a deviation as a repeatable check.
            </p>
          ) : (
            <>
              <div className="eval-health-row">
                <span className="eval-health eval-health-pass">{evalHealth.passed} checks passing</span>
                <span className={`eval-health ${evalHealth.failed > 0 ? "eval-health-fail" : "eval-health-idle"}`}>
                  {evalHealth.failed} failing
                </span>
                {evalHealth.regressions > 0 ? (
                  <span className="eval-health eval-health-regress">▲ {evalHealth.regressions} regressions</span>
                ) : null}
              </div>
              <ul className="mini-list">
                {evals.slice(0, 4).map((e) => (
                  <li key={e.id}>
                    <a className="mini-row" href={`#/eval/${encodeURIComponent(e.id)}`}>
                      <span className="mini-name">{e.label}</span>
                      <HealthBadge ev={e} />
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <UsageCard summary={usage} onReset={() => void load()} />

      <div className="panel card-pad">
        <div className="card-head">
          <h2 className="card-title">Recent traces</h2>
          <a className="card-link" href="#/traces">
            View all →
          </a>
        </div>
        <ul className="mini-list">
          {recent.map((t) => (
            <li key={t.id}>
              <a
                className={`mini-row${t.status === "error" ? " mini-row-error" : ""}`}
                href={`#/trace/${encodeURIComponent(t.id)}`}
              >
                <StatusDot status={t.status} />
                <span className="mini-name">{t.name ?? "Untitled trace"}</span>
                {t.agent ? <span className="tag">{t.agent}</span> : null}
                {t.inputPreview ? <span className="muted mini-preview">{truncate(t.inputPreview, 48)}</span> : null}
                <span className="mono muted mini-age">{relativeTime(t.startedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      {flows.length > 0 ? (
        <div className="panel card-pad">
          <div className="card-head">
            <h2 className="card-title">Flows</h2>
            <a className="card-link" href="#/flows">
              View all →
            </a>
          </div>
          <ul className="mini-list">
            {flows.slice(0, 4).map((f) => (
              <li key={f.id}>
                <a className="mini-row" href={`#/flow/${encodeURIComponent(f.id)}`}>
                  <span className="mini-name">{f.name}</span>
                  <span className="mono muted">{formatNumber(f.traceCount)} traces</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {info ? (
        <p className="overview-foot muted">
          Ingesting at <span className="mono">{truncate(info.ingestEndpoint, 60)}</span> · traces stay on this machine.
        </p>
      ) : null}
    </section>
  );
};
