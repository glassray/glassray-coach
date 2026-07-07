/*
 * Egress-proof preload (CJS, injected via NODE_OPTIONS=--require). Records any
 * attempt to reach a non-loopback host to $EGRESS_LOG, across every Node
 * process in the tree. Attempts are recorded, never blocked, so a failure is
 * evidence (who dialed where), not a hang.
 *
 * Two layers, because DNS resolution in Node happens off the `net.Socket` path
 * (c-ares / getaddrinfo), so a bare lookup would bypass a TCP-only hook:
 *   1. `net.Socket.prototype.connect` — every real outbound connection opens a
 *      socket to a resolved IP, so this alone catches all actual egress.
 *   2. `dns.lookup` / `dns.promises.lookup` / `dns.resolve` — flags even a bare
 *      hostname resolution with no follow-on connect, closing the DNS gap.
 */
const net = require("node:net");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const fs = require("node:fs");

const logFile = process.env.EGRESS_LOG;
if (logFile) {
  /** Hosts a loopback-only tool may legitimately dial / resolve. */
  const LOCAL = new Set([
    "127.0.0.1",
    "localhost",
    "::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
    "::",
    "",
  ]);

  /** Append one recorded attempt; recording must never break the app. */
  const record = (kind, host, port) => {
    try {
      if (!LOCAL.has(String(host).toLowerCase())) {
        fs.appendFileSync(logFile, `${process.pid} ${kind} ${host}${port ? ":" + port : ""}\n`);
      }
    } catch {
      // swallow
    }
  };

  // ── 1. TCP connect ──────────────────────────────────────────────────────────
  /** Pull host/port out of the many net.connect signatures. */
  const target = (args) => {
    let opts = args[0];
    if (Array.isArray(opts)) opts = opts[0];
    if (opts && typeof opts === "object") {
      return { host: opts.host ?? opts.hostname ?? "localhost", port: opts.port };
    }
    if (typeof opts === "number") {
      return { host: typeof args[1] === "string" ? args[1] : "localhost", port: opts };
    }
    return { host: "localhost", port: undefined };
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const { host, port } = target(args);
    record("tcp", host, port);
    return originalConnect.apply(this, args);
  };

  // ── 2. DNS resolution ───────────────────────────────────────────────────────
  const originalLookup = dns.lookup;
  dns.lookup = function (hostname, ...rest) {
    record("dns", hostname);
    return originalLookup.call(this, hostname, ...rest);
  };
  const originalResolve = dns.resolve;
  dns.resolve = function (hostname, ...rest) {
    record("dns", hostname);
    return originalResolve.call(this, hostname, ...rest);
  };
  const originalPromiseLookup = dnsPromises.lookup;
  dnsPromises.lookup = function (hostname, ...rest) {
    record("dns", hostname);
    return originalPromiseLookup.call(this, hostname, ...rest);
  };
}
