# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**[Security → Report a vulnerability](https://github.com/glassray/glassray-coach/security/advisories/new)**
on this repository. Don't open a public issue for security reports.

We aim to acknowledge reports within a few business days. Only the latest
released version of `@glassray/coach` is supported with fixes.

## Security model

Coach is a **local-only** tool; its design assumptions are worth knowing when
you assess a finding:

- **Loopback only.** The server binds `127.0.0.1` and every route enforces a
  Host/Origin loopback guard (403 otherwise) as a DNS-rebinding defense. It is
  not designed to be port-forwarded or exposed to untrusted networks.
- **Ingest auth.** Only the trace-ingest routes (`POST /v1/traces` and its
  alias) take auth — a local bearer key generated once under
  `$GLASSRAY_HOME/local-api-key` (`chmod 0600`). All other routes are
  unauthenticated by design, relying on the loopback boundary.
- **Local data.** Traces, rules, and settings live under `~/.glassray`;
  nothing is uploaded and there is no account. API keys for metered providers
  stay in the environment and are never written to disk.
- **Network egress.** The only network calls Coach itself makes are to the
  LLM provider you configure and the CLI's npm update check (one HTTPS GET of
  the package name; opt out with `GLASSRAY_NO_UPDATE_CHECK=1`). The `mock`
  provider path is fully offline — `npm run test:egress` asserts it.
- **Code discovery reads files.** `flows discover` gives the configured LLM
  read-only tools (Read/Grep/Glob — no shell, no writes) rooted at your
  `codeRoot`. The root is a starting point, not a hard sandbox: treat the
  feature as granting the LLM provider read access to files on your machine,
  and point it only at code you're comfortable sharing with that provider.

Findings that break one of these properties — a route reachable without the
loopback guard, unexpected egress, a write path from the discovery agent, key
material landing on disk — are exactly what we want to hear about.
