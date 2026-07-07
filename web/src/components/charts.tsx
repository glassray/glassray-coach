import type { TimelinePoint } from "../api";

/*
 * Tiny dependency-free charts for the Coach dashboard — plain CSS bars (no SVG
 * distortion, fully responsive, hover via native titles). They draw only in the
 * Glassray tokens: the brand green for the primary series and the reserved
 * status colors (red = critical/error, amber = major, neutral = minor) which
 * always appear beside a text label, never as color alone.
 */

/** Format an ISO time compactly for an axis tick / tooltip ("14:05", "Jul 3"). */
const shortTime = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/**
 * Trace-volume-over-time as stacked columns: each bucket's height is its trace
 * count, with the error share drawn red at the base (a bucket tooltip carries
 * the exact counts + time). Flat baseline when nothing is captured yet.
 */
export const ActivityBars = ({
  points,
  from,
  to,
  height = 72,
}: {
  points: TimelinePoint[];
  from: string | null;
  to: string | null;
  height?: number;
}) => {
  const max = points.reduce((m, p) => Math.max(m, p.traces), 0);
  return (
    <div className="chart">
      <div className="chart-bars" style={{ height }}>
        {points.length === 0 ? (
          <div className="chart-empty">No activity yet</div>
        ) : (
          points.map((p, i) => {
            // One bar per bucket (height = trace count); the error share is
            // highlighted red at the base — a part-of-whole, not a stack.
            const barPct = max > 0 ? (p.traces / max) * 100 : 0;
            const errPct = p.traces > 0 ? (p.errors / p.traces) * 100 : 0;
            return (
              <div
                className="chart-col"
                key={i}
                title={`${p.traces} trace${p.traces === 1 ? "" : "s"}${p.errors ? ` · ${p.errors} error${p.errors === 1 ? "" : "s"}` : ""} · ${shortTime(p.t)}`}
              >
                <div className="chart-bar" style={{ height: `${barPct}%` }}>
                  {errPct > 0 ? <div className="chart-bar-err" style={{ height: `${errPct}%` }} /> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      {points.length > 0 ? (
        <div className="chart-axis">
          <span>{shortTime(from)}</span>
          <span>{shortTime(to)}</span>
        </div>
      ) : null}
    </div>
  );
};

/** Severity counts for the deviation distribution bar. */
export interface SeverityCounts {
  critical: number;
  major: number;
  minor: number;
}

/** The three severity segments in worst-first order, with their status color class + label. */
const SEV_SEGMENTS: Array<{ key: keyof SeverityCounts; label: string; cls: string }> = [
  { key: "critical", label: "Critical", cls: "sev-seg-critical" },
  { key: "major", label: "Major", cls: "sev-seg-major" },
  { key: "minor", label: "Minor", cls: "sev-seg-minor" },
];

/**
 * A single horizontal stacked bar of deviation severities (critical → major →
 * minor), with a labelled legend beneath so the reserved status colors are never
 * the sole carrier of meaning.
 */
export const SeverityBar = ({ counts }: { counts: SeverityCounts }) => {
  const total = counts.critical + counts.major + counts.minor;
  return (
    <div className="sevbar">
      <div className="sevbar-track">
        {total === 0 ? (
          <div className="sevbar-empty" />
        ) : (
          SEV_SEGMENTS.map((s) => {
            const n = counts[s.key];
            if (n === 0) return null;
            return (
              <div
                key={s.key}
                className={`sevbar-seg ${s.cls}`}
                style={{ width: `${(n / total) * 100}%` }}
                title={`${n} ${s.label.toLowerCase()}`}
              />
            );
          })
        )}
      </div>
      <div className="sevbar-legend">
        {SEV_SEGMENTS.map((s) => (
          <span className="sevbar-key" key={s.key}>
            <span className={`sevbar-dot ${s.cls}`} aria-hidden="true" />
            {s.label} <span className="mono">{counts[s.key]}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/** One run on the eval pass-rate trend. */
export interface TrendPoint {
  passed: number;
  total: number;
  title?: string;
}

/**
 * Pass-rate-over-runs as slim columns (each run's height is its pass rate); a run
 * with any failures gets a red cap so a regression reads at a glance. Left→right
 * is oldest→newest.
 */
export const PassRateTrend = ({ points, height = 56 }: { points: TrendPoint[]; height?: number }) => {
  if (points.length === 0) return <div className="chart-empty chart-empty-inline">No runs yet</div>;
  return (
    <div className="trend" style={{ height }}>
      {points.map((p, i) => {
        const rate = p.total > 0 ? p.passed / p.total : 0;
        const failed = p.total - p.passed;
        const pct = Math.round(rate * 100);
        return (
          <div className="trend-col" key={i} title={p.title ?? `${pct}% pass (${p.passed}/${p.total})`}>
            <div className="trend-fill" style={{ height: `${Math.max(rate * 100, 2)}%` }}>
              {failed > 0 ? <div className="trend-cap" /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};
