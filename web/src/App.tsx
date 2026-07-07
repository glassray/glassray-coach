import { useEffect, useState } from "react";
import type { TabKey } from "./components/Sidebar";
import { Sidebar } from "./components/Sidebar";
import { TraceList } from "./components/TraceList";
import { TraceDetail } from "./components/TraceDetail";
import { Deviations } from "./components/Deviations";
import { DeviationDetail } from "./components/DeviationDetail";
import { Flows } from "./components/Flows";
import { FlowDetail } from "./components/FlowDetail";
import { Evals } from "./components/Evals";
import { EvalDetail } from "./components/EvalDetail";
import { Overview } from "./components/Overview";
import { Settings } from "./components/Settings";

/** The active view, derived from the URL hash (no router dependency). */
type Route =
  | { name: "overview" }
  | { name: "list" }
  | { name: "trace"; id: string }
  | { name: "deviations" }
  | { name: "deviation"; id: string }
  | { name: "flows" }
  | { name: "flow"; id: string }
  | { name: "evals" }
  | { name: "eval"; id: string }
  | { name: "settings" };

/** Decode a hash id segment, tolerating malformed percent-encoding (returns it raw). */
const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Parse window.location.hash into a Route, defaulting to the Overview dashboard. */
const parseHash = (): Route => {
  const hash = window.location.hash.replace(/^#/, "");
  const traceId = /^\/trace\/(.+)$/.exec(hash)?.[1];
  if (traceId) return { name: "trace", id: decodeSegment(traceId) };
  const deviationId = /^\/deviation\/(.+)$/.exec(hash)?.[1];
  if (deviationId) return { name: "deviation", id: decodeSegment(deviationId) };
  const flowId = /^\/flow\/(.+)$/.exec(hash)?.[1];
  if (flowId) return { name: "flow", id: decodeSegment(flowId) };
  const evalId = /^\/eval\/(.+)$/.exec(hash)?.[1];
  if (evalId) return { name: "eval", id: decodeSegment(evalId) };
  if (hash === "/traces") return { name: "list" };
  if (hash === "/deviations") return { name: "deviations" };
  if (hash === "/flows") return { name: "flows" };
  if (hash === "/evals") return { name: "evals" };
  if (hash === "/settings") return { name: "settings" };
  return { name: "overview" };
};

/** Map a route to the sidebar tab it belongs under. */
const tabFor = (route: Route): TabKey => {
  if (route.name === "list" || route.name === "trace") return "traces";
  if (route.name === "deviations" || route.name === "deviation") return "deviations";
  if (route.name === "flows" || route.name === "flow") return "flows";
  if (route.name === "evals" || route.name === "eval") return "evals";
  if (route.name === "settings") return "settings";
  return "overview";
};

/** Pick the view component for the active route. */
const renderRoute = (route: Route) => {
  switch (route.name) {
    case "list":
      return <TraceList />;
    case "trace":
      return <TraceDetail id={route.id} />;
    case "deviations":
      return <Deviations />;
    case "deviation":
      return <DeviationDetail id={route.id} />;
    case "flows":
      return <Flows />;
    case "flow":
      return <FlowDetail id={route.id} />;
    case "evals":
      return <Evals />;
    case "eval":
      return <EvalDetail id={route.id} />;
    case "settings":
      return <Settings />;
    default:
      return <Overview />;
  }
};

/** Root component: a hash-routed shell wrapping the left sidebar and the active view. */
export const App = () => {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    /** Re-derive the route whenever the hash changes. */
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="app">
      <Sidebar active={tabFor(route)} />
      <main className="main">{renderRoute(route)}</main>
    </div>
  );
};
