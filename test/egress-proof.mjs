#!/usr/bin/env node
/*
 * The offline promise, proven for Glassray Coach (full-airgap variant): boot
 * the server with GLASSRAY_LLM_PROVIDER=mock on a fresh data dir, exercise the
 * whole loop — keyed OTLP ingest, a discovery run, a flows run, the REST reads
 * — then assert the socket-layer preload recorded ZERO connections to any
 * non-loopback host across every process in the tree.
 *
 *   node test/egress-proof.mjs [--port 5951]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const coachRoot = join(here, "..");
const preload = join(here, "egress-preload.cjs");
const portArg = process.argv.indexOf("--port");
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : 5951;

const dataDir = mkdtempSync(join(tmpdir(), "coach-egress-"));
const egressLog = join(dataDir, "egress.log");

/** A minimal OTLP trace with a distinct id. */
const trace = (n) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: `agent-${n}` } }] },
      scopeSpans: [
        {
          scope: { name: "proof" },
          spans: [
            {
              traceId: `${n}${n}${n}${n}aaaabbbbccccddddeeeeffff11112222`.slice(0, 32),
              spanId: "aaaabbbbccccdddd",
              name: `run-${n}`,
              kind: 1,
              startTimeUnixNano: "1751500000000000000",
              endTimeUnixNano: "1751500001000000000",
              attributes: [
                { key: "input.value", value: { stringValue: `question ${n}` } },
                { key: "output.value", value: { stringValue: `answer ${n}` } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

console.log(`coach egress proof: booting on :${port} (fresh datadir, mock LLM)`);
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: coachRoot,
  env: {
    ...process.env,
    NODE_OPTIONS: `--require ${preload}`,
    EGRESS_LOG: egressLog,
    GLASSRAY_HOME: dataDir,
    GLASSRAY_PORT: String(port),
    GLASSRAY_LLM_PROVIDER: "mock",
    // Neutralise any ambient proxy/cloud config from the invoking shell.
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

/** Fail the proof with context and exit non-zero. */
const fail = (message) => {
  console.error(`\nEGRESS PROOF FAILED: ${message}`);
  console.error(log.split("\n").slice(-20).join("\n"));
  child.kill("SIGKILL");
  process.exit(1);
};

/** GET/POST JSON against the local server. */
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// Wait for readiness.
let info = null;
for (let i = 0; i < 120 && !info; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (child.exitCode !== null) fail("server exited during boot");
  try {
    const r = await api("GET", "/api/info");
    if (r.status === 200) info = r.json;
  } catch {
    // still booting
  }
}
if (!info) fail("server never became ready");
console.log("  ready — ingesting + running discovery/flows…");

// Keyed ingest of a few traces.
for (const n of [1, 2, 3]) {
  const r = await api("POST", "/v1/traces", trace(n), { Authorization: `Bearer ${info.apiKey}` });
  if (r.status !== 200) fail(`ingest ${n} returned ${r.status}`);
}

/** POST a run, poll until terminal. */
const runToDone = async (path) => {
  const start = await api("POST", path, {});
  if (start.status !== 202 && start.status !== 200) fail(`${path} returned ${start.status}`);
  const runId = start.json.runId;
  for (let i = 0; i < 60; i++) {
    const s = await api("GET", `/api/runs/${runId}`);
    if (s.json?.status === "done") return s.json;
    if (s.json?.status === "error") fail(`${path} run errored: ${s.json.error}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${path} run never completed`);
};

await runToDone("/api/discovery/run");
// Flow discovery now reads CODE (not traces); with no `codeRoot` and the offline
// mock LLM it reads nothing and mints nothing, which is correct — the point here
// is that the run still completes without any egress. Exercise the flows
// subsystem itself by creating one flow directly (the deterministic offline path).
await runToDone("/api/flows/run");
const created = await api("POST", "/api/flows", { name: "Proof flow", selector: { status: "ok" } });
if (created.status !== 201) fail(`flow create returned ${created.status}`);
const devs = await api("GET", "/api/deviations");
const flows = await api("GET", "/api/flows");
if (!(devs.json?.total >= 1)) fail("no deviations produced");
if (!(flows.json?.items?.length >= 1)) fail("no flows produced");
console.log(`  discovery + flows completed (${devs.json.total} deviation type, ${flows.json.items.length} flow)`);

// Clean shutdown, then the verdict.
child.kill("SIGINT");
await new Promise((resolve) => child.once("exit", resolve));

const attempts = existsSync(egressLog) ? readFileSync(egressLog, "utf8").trim() : "";
if (attempts) {
  console.error("\nEGRESS PROOF FAILED — non-loopback connection attempts detected:");
  console.error(attempts);
  process.exit(1);
}
rmSync(dataDir, { recursive: true, force: true });
console.log(
  "\nEGRESS PROOF PASSED — zero non-loopback connections across boot, ingest, discovery, flows, and shutdown.",
);
