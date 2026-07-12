import { useCallback, useState } from "react";
import type { UsageSummary } from "../api";
import { resetUsage } from "../api";
import { formatNumber } from "../format";

/** Format a USD amount for the budget meter (<$0.01 shown as such). */
const usd = (n: number): string => {
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
};

/**
 * Coach's own LLM spend: a budget meter (metered spend vs the cap) plus a
 * per-model breakdown of tokens + cost. The cap keeps a metered API key from
 * draining a developer's balance during testing; the free `mock` /
 * `claude-subscription` paths accrue $0, so the meter simply stays empty.
 */
export const UsageCard = ({ summary, onReset }: { summary: UsageSummary; onReset: () => void }) => {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const { budgetUsd, spentUsd, overBudget } = summary;
  const pct = budgetUsd && budgetUsd > 0 ? Math.min(100, (spentUsd / budgetUsd) * 100) : 0;
  const fillClass = overBudget ? "budget-fill-over" : pct > 80 ? "budget-fill-warn" : "";

  /** Clear the usage ledger, then let the parent reload. */
  const doReset = useCallback(async () => {
    if (resetting) return;
    if (!window.confirm("Reset the LLM usage ledger? This clears the recorded spend.")) return;
    setResetting(true);
    setResetError(null);
    try {
      await resetUsage();
      onReset();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Could not reset usage.");
    } finally {
      setResetting(false);
    }
  }, [resetting, onReset]);

  return (
    <div className="panel card-pad">
      <div className="card-head">
        <h2 className="card-title">Coach LLM usage</h2>
        {summary.calls > 0 ? (
          <button className="card-link card-link-btn" type="button" onClick={doReset} disabled={resetting}>
            {resetting ? "Resetting…" : "Reset"}
          </button>
        ) : null}
      </div>
      <p className="muted card-subtitle">Coach's own analysis spend (discovery, evals, flows, replay).</p>

      <div className="budget">
        <div className="budget-head">
          <span className="budget-spent mono">{usd(spentUsd)}</span>
          <span className="muted">
            {budgetUsd == null ? "unlimited budget" : `of ${usd(budgetUsd)} budget`}
          </span>
        </div>
        {budgetUsd != null ? (
          <div className="budget-track">
            {pct > 0 ? <div className={`budget-fill ${fillClass}`} style={{ width: `${pct}%` }} /> : null}
          </div>
        ) : null}
        {resetError ? <p className="runbar-error">{resetError}</p> : null}
        {overBudget ? (
          <p className="budget-warn">Budget reached — new analysis runs are paused. Raise the cap or reset.</p>
        ) : summary.calls > 0 && spentUsd === 0 ? (
          <p className="budget-note muted">
            No metered spend — running on a free provider (mock / subscription).
            {summary.spentIfMeteredUsd > 0 ? (
              <>
                {" "}
                These tokens would cost <span className="mono">{usd(summary.spentIfMeteredUsd)}</span> on a metered API
                key.
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {summary.byModel.length === 0 ? (
        <p className="muted card-empty">
          No analysis has run yet — discovery, evals, flows and replay show up here.
        </p>
      ) : (
        <div className="table-wrap usage-wrap">
          <table className="table usage-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="col-num">Calls</th>
                <th className="col-num">Tokens</th>
                <th className="col-num">Cost</th>
                <th className="col-num" title="Price-book estimate: what these tokens would cost on a metered API key">
                  If metered
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={`${m.provider}/${m.model}`}>
                  <td>
                    <span className="mono">{m.model}</span> <span className="muted">{m.provider}</span>
                  </td>
                  <td className="col-num mono">{formatNumber(m.calls)}</td>
                  <td className="col-num mono">
                    {formatNumber(m.tokensIn)}→{formatNumber(m.tokensOut)}
                  </td>
                  <td className="col-num mono">{usd(m.costUsd)}</td>
                  <td className="col-num mono muted">{usd(m.costIfMeteredUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
