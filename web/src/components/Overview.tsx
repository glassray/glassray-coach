import { useCallback, useEffect, useState } from "react";
import type {
  CompareReport,
  EvalSummary,
  FlowSummary,
  Info,
  StatsResponse,
  TraceListItem,
  UsageSummary,
} from "../api";
import { fetchEvals, fetchFlows, fetchInfo, fetchLastCompare, fetchStats, fetchTraces, fetchUsage } from "../api";
import { formatNumber, relativeTime, truncate } from "../format";
import { useTailRefresh } from "../useTailRefresh";
import { parseCompareReport } from "./Compare";
import { HealthBadge, SourceChip } from "./Evals";
import { EmptyState, StatusDot } from "./TraceList";
import { UsageCard } from "./UsageCard";

/*
 * OVERVIEW (#/) — the home surface. Local is a change-with-confidence test
 * runner, not a monitoring dashboard, so this leads with the RULE SUITE and the
 * LAST EXPERIMENT (the compare that mattered), then what's landing. No activity
 * chart, error-rate KPIs, or deviations here — those are production concerns and
 * live in the cloud edition.
 */

/** Everything the home surface renders, loaded together so the view stays consistent. */
interface OverviewData {
  stats: StatsResponse;
  evals: EvalSummary[];
  flows: FlowSummary[];
  recent: TraceListItem[];
  usage: UsageSummary;
  /** The newest finished compare run's report + when it finished; null before any compare. */
  lastCompare: { report: CompareReport; at: string | null } | null;
}

/** The home surface: rule suite, last experiment, and what's landing — on this machine. */
export const Overview = () => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  /** Load every panel's data in one shot so the surface is internally consistent. */
  const load = useCallback(async () => {
    try {
      const [stats, evals, flows, recent, usage, lastCompareRun] = await Promise.all([
        fetchStats(),
        fetchEvals(),
        fetchFlows(),
        fetchTraces({}, 6, 0),
        fetchUsage(),
        fetchLastCompare().catch(() => null),
      ]);
      const report = parseCompareReport(lastCompareRun);
      setData({
        stats,
        evals: evals.items,
        flows: flows.items,
        recent: recent.items,
        usage,
        lastCompare: report ? { report, at: lastCompareRun?.finishedAt ?? null } : null,
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

  // Live: refresh when new traces land (dim the badge if the stream drops).
  const live = useTailRefresh(() => void load());

  if (status === "loading") return <div className="notice">Loading…</div>;
  if (status === "error" || !data)
    return <div className="notice notice-error">Could not reach the local Coach server.</div>;

  const { stats, evals, flows, recent, usage, lastCompare } = data;

  // Nothing captured yet → the instrument-your-agent on-ramp.
  if (stats.totals.traces === 0) return <EmptyState info={info} />;

  // Roll up rule health across every saved rule.
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
          <p className="page-sub">Your rule suite, the last experiment, and what's landing — on this machine.</p>
        </div>
        <span className="list-count">
          <span className={`live-dot${live ? "" : " live-dot-off"}`} aria-hidden="true" />
          {live ? "live" : "reconnecting…"}
        </span>
      </div>

      <div className="panel card-pad">
        <div className="card-head">
          <h2 className="card-title">Rules</h2>
          <a className="card-link" href="#/evals">
            View all →
          </a>
        </div>
        {evals.length === 0 ? (
          <p className="muted card-empty">
            No rules yet — write one, or ask your coding agent to derive them from the flow's code.
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
              {evals.slice(0, 8).map((e) => (
                <li key={e.id}>
                  <a className="mini-row" href={`#/eval/${encodeURIComponent(e.id)}`}>
                    <span className="mini-name">{e.label}</span>
                    <SourceChip sourceFile={e.sourceFile} />
                    <HealthBadge ev={e} />
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="panel card-pad">
        <div className="card-head">
          <h2 className="card-title">Last experiment</h2>
          <a className="card-link" href="#/experiments">
            View all →
          </a>
        </div>
        {lastCompare === null ? (
          <p className="muted card-empty">
            No experiments yet — run the rule suite over two corpora to change with confidence.
          </p>
        ) : (
          <>
            <div className="eval-health-row">
              <span
                className={`eval-health ${lastCompare.report.regressions > 0 ? "eval-health-regress" : "eval-health-pass"}`}
              >
                {lastCompare.report.regressions > 0
                  ? `▲ ${lastCompare.report.regressions} rule(s) regressed`
                  : "no regressions"}
              </span>
              {lastCompare.at ? <span className="muted">{relativeTime(lastCompare.at)}</span> : null}
            </div>
            <ul className="mini-list">
              {lastCompare.report.rules.slice(0, 4).map((r) => (
                <li key={r.id}>
                  <a className="mini-row" href="#/experiments">
                    <span className="mini-name">{r.label}</span>
                    <span className="mono muted">
                      {r.baseline.passRate === null ? "—" : `${Math.round(r.baseline.passRate * 100)}%`}
                      {" → "}
                      {r.candidate.passRate === null ? "—" : `${Math.round(r.candidate.passRate * 100)}%`}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

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

      <UsageCard summary={usage} onReset={() => void load()} />

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
