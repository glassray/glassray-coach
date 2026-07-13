# Contributing to Glassray Coach

Thanks for your interest! Issues and pull requests are welcome.

## Getting started

Everything you need to run Coach from a clone — commands, environment variables,
data layout, and how the repo is organized — is in
**[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**. The short version:

```sh
npm install
npm run dev        # API on :5899
npm run dev:ui     # Vite dev server for the SPA
```

## Before you open a PR

```sh
npm run typecheck  # tsc --noEmit (server + web)
npm test           # vitest — hermetic, no network or API key needed
```

Both must pass. The test suite runs entirely on the deterministic `mock` LLM
provider, so no credentials are required. If your change touches ingest,
discovery, or the flows/classify path, also run `npm run test:egress` (the
airgap proof — asserts zero non-loopback sockets).

A few conventions:

- This is a plain npm project — use `npm`, not `pnpm`, and keep it free of
  external workspace dependencies (it's consumed by a monorepo as a submodule).
- The CLI (`bin/`) is zero-dependency by design; don't add packages to it.
- Match the surrounding code style; there is no lint step to fight with.

## Reporting bugs

Open a [GitHub issue](https://github.com/glassray/glassray-coach/issues) with
what you ran, what you expected, and what happened — `glassray-coach doctor`
output helps. For security issues, see [SECURITY.md](./SECURITY.md) instead.
