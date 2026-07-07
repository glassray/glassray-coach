import { useCallback, useEffect, useMemo, useState } from "react";
import type { CoachSettings, LlmProvider } from "../api";
import { fetchSettings, updateSettings } from "../api";

/** Human labels for the provider dropdown. */
const PROVIDER_LABELS: Record<LlmProvider, string> = {
  mock: "Mock — offline, deterministic",
  "claude-subscription": "Claude subscription (~/.claude)",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
};

/** Provider order in the dropdown. */
const PROVIDERS: LlmProvider[] = ["claude-subscription", "anthropic", "openai", "mock"];

/** Suggested model ids per provider family, offered in the model dropdowns. */
const MODEL_PRESETS: Record<"claude" | "openai", { heavy: string[]; light: string[] }> = {
  claude: {
    heavy: ["claude-opus-4-8", "claude-sonnet-4-6"],
    light: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  },
  openai: {
    heavy: ["gpt-4o", "gpt-4o-mini"],
    light: ["gpt-4o-mini", "gpt-4o"],
  },
};

/** Why the selected provider isn't usable yet (null when it's ready to go). */
const unavailableReason = (provider: LlmProvider): string | null => {
  switch (provider) {
    case "anthropic":
      return "Set ANTHROPIC_API_KEY in the environment to use this provider.";
    case "openai":
      return "Set OPENAI_API_KEY in the environment to use this provider.";
    case "claude-subscription":
      return "No ~/.claude found — sign in with the Claude CLI, or pick another provider.";
    default:
      return null;
  }
};

/** De-duplicate while preserving order (so the current value always appears in its dropdown). */
const uniq = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

/** The Settings view (#/settings): pick the analysis provider, models, and spend cap — no restart, no env editing. */
export const Settings = () => {
  const [data, setData] = useState<CoachSettings | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [provider, setProvider] = useState<LlmProvider>("mock");
  const [heavyModel, setHeavyModel] = useState("");
  const [lightModel, setLightModel] = useState("");
  const [budget, setBudget] = useState("50");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** Seed the form from the server's effective config. */
  const apply = useCallback((s: CoachSettings) => {
    setData(s);
    setProvider(s.provider);
    setHeavyModel(s.heavyModelId);
    setLightModel(s.lightModelId);
    setBudget(String(s.budgetUsd));
  }, []);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        apply(s);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [apply]);

  /** Model options track the selected provider (mock ignores models entirely). */
  const family = provider === "openai" ? "openai" : "claude";
  const heavyOptions = useMemo(() => uniq([...MODEL_PRESETS[family].heavy, heavyModel]), [family, heavyModel]);
  const lightOptions = useMemo(() => uniq([...MODEL_PRESETS[family].light, lightModel]), [family, lightModel]);
  const modelsDisabled = provider === "mock";

  /** Switching provider snaps the models to that provider's defaults (an OpenAI id is meaningless on Anthropic). */
  const onProviderChange = (next: LlmProvider) => {
    setProvider(next);
    setSaved(false);
    if (next !== "mock") {
      const fam = next === "openai" ? "openai" : "claude";
      setHeavyModel(MODEL_PRESETS[fam].heavy[0]!);
      setLightModel(MODEL_PRESETS[fam].light[0]!);
    }
  };

  /** Persist the form and adopt the server's fresh effective config + readiness. */
  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const parsedBudget = Number(budget);
      const next = await updateSettings({
        llmProvider: provider,
        heavyModelId: heavyModel.trim() || undefined,
        lightModelId: lightModel.trim() || undefined,
        budgetUsd: Number.isFinite(parsedBudget) && parsedBudget >= 0 ? parsedBudget : 50,
      });
      apply(next);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }, [saving, budget, provider, heavyModel, lightModel, apply]);

  if (status === "loading") return <div className="notice">Loading settings…</div>;
  if (status === "error" || !data) return <div className="notice notice-error">Could not reach the local Coach server.</div>;

  const available = data.availability[provider];
  const hint = available ? null : unavailableReason(provider);

  return (
    <section className="detail settings">
      <header className="detail-head">
        <div className="detail-title-row">
          <h1 className="detail-title">Settings</h1>
        </div>
        <p className="detail-sub">
          Choose the model Coach uses for discovery, evals, flows, and replay. Changes take effect immediately — no
          restart. Provider API keys stay in your environment.
        </p>
      </header>

      <div className="panel settings-panel">
        <div className="settings-field">
          <label className="settings-label" htmlFor="set-provider">
            Analysis provider
          </label>
          <select
            id="set-provider"
            className="settings-input"
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as LlmProvider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
                {data.availability[p] ? "" : " — not configured"}
              </option>
            ))}
          </select>
          {hint ? <p className="settings-hint settings-hint-warn">{hint}</p> : null}
        </div>

        <div className="settings-row">
          <div className="settings-field">
            <label className="settings-label" htmlFor="set-heavy">
              Heavy model <span className="muted">— clustering &amp; labeling</span>
            </label>
            <select
              id="set-heavy"
              className="settings-input mono"
              value={heavyModel}
              disabled={modelsDisabled}
              onChange={(e) => {
                setHeavyModel(e.target.value);
                setSaved(false);
              }}
            >
              {heavyOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-label" htmlFor="set-light">
              Light model <span className="muted">— per-trace judging</span>
            </label>
            <select
              id="set-light"
              className="settings-input mono"
              value={lightModel}
              disabled={modelsDisabled}
              onChange={(e) => {
                setLightModel(e.target.value);
                setSaved(false);
              }}
            >
              {lightOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        {modelsDisabled ? <p className="settings-hint">The mock provider is deterministic and offline — model choice doesn't apply.</p> : null}

        <div className="settings-field settings-field-narrow">
          <label className="settings-label" htmlFor="set-budget">
            Spend cap (USD) <span className="muted">— metered providers · 0 = unlimited</span>
          </label>
          <input
            id="set-budget"
            className="settings-input mono"
            type="number"
            min={0}
            step={5}
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setSaved(false);
            }}
          />
        </div>

        <div className="settings-actions">
          {saveError ? (
            <span className="runbar-error">{saveError}</span>
          ) : saved ? (
            <span className="runbar-success">✓ Saved · {data.reason}</span>
          ) : (
            <span className={`settings-status ${data.ready ? "settings-status-ok" : "settings-status-warn"}`}>
              {data.ready ? "●" : "○"} {data.reason}
            </span>
          )}
          <button className="btn" type="button" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </section>
  );
};
