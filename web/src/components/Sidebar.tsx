import type { ReactElement } from "react";

/** Identifier for one of the top-level sections reachable from the sidebar. */
export type TabKey =
  | "overview"
  | "traces"
  | "deviations"
  | "flows"
  | "evals"
  | "compare"
  | "experiments"
  | "settings";

/** Grid icon — the Overview dashboard. */
const IconGrid = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </svg>
);

/** Activity/pulse icon — the Traces section. */
const IconActivity = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </svg>
);

/** Flask icon — the Experiments section. */
const IconFlask = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 3h6" />
    <path d="M10 3v6.5L4.8 18.4A2 2 0 0 0 6.6 21.4h10.8a2 2 0 0 0 1.8-3L14 9.5V3" />
    <path d="M7.5 15h9" />
  </svg>
);

/** Branch/flow icon — the Flows section. */
const IconFlow = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

/** Check-square icon — the Evals section. */
const IconCheck = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="9 11 12 14 22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

/** Lightning-bolt icon — the Deviations section. */
const IconDeviation = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  </svg>
);

/** Gear icon — the Settings section. */
const IconSettings = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/** The primary nav entries rendered in the sidebar, in display order. */
const TABS: Array<{ key: TabKey; label: string; href: string; icon: () => ReactElement }> = [
  { key: "overview", label: "Overview", href: "#/", icon: IconGrid },
  { key: "flows", label: "Flows", href: "#/flows", icon: IconFlow },
  { key: "evals", label: "Rules", href: "#/evals", icon: IconCheck },
  { key: "experiments", label: "Experiments", href: "#/experiments", icon: IconFlask },
  { key: "deviations", label: "Deviations", href: "#/deviations", icon: IconDeviation },
  { key: "traces", label: "Traces", href: "#/traces", icon: IconActivity },
];

/** Fixed left sidebar: the Glassray Coach wordmark and section nav. */
export const Sidebar = ({ active }: { active: TabKey }) => (
  <aside className="sidebar">
    <a className="wordmark" href="#/">
      <img className="wordmark-mark-img" src="/glassray-mark.svg" width={22} height={22} alt="" aria-hidden="true" />
      <span className="wordmark-text">
        Glassray <span className="wordmark-accent">Coach</span>
      </span>
    </a>
    <nav className="nav" aria-label="Sections">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <a
            key={tab.key}
            className={`nav-tab${tab.key === active ? " nav-tab-active" : ""}`}
            href={tab.href}
            aria-current={tab.key === active ? "page" : undefined}
          >
            <span className="nav-icon">
              <Icon />
            </span>
            <span className="nav-label">{tab.label}</span>
          </a>
        );
      })}
    </nav>
    <a
      className={`nav-tab nav-tab-bottom${active === "settings" ? " nav-tab-active" : ""}`}
      href="#/settings"
      aria-current={active === "settings" ? "page" : undefined}
    >
      <span className="nav-icon">
        <IconSettings />
      </span>
      <span className="nav-label">Settings</span>
    </a>
  </aside>
);
