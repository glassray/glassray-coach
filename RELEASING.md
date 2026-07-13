# Releasing @glassray/coach

Releases run through [release-it](https://github.com/release-it/release-it),
driven manually by a maintainer — one command does the whole flow **except the
npm publish**, which happens in GitHub Actions via
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC):
pushing the release tag triggers `.github/workflows/release.yml`, which re-runs
the gates, builds the SPA, and publishes. No npm token exists anywhere — not on
laptops, not in repo secrets — and npm attaches a provenance attestation linking
the tarball to the exact commit and workflow run.

## Prerequisites (one-time)

- Push access to this repo.
- The npm package must have a **trusted publisher** configured
  (npmjs.com → `@glassray/coach` → Settings → Trusted Publisher):
  GitHub Actions, owner `glassray`, repo `glassray-coach`, workflow
  `release.yml`, no environment. While there, set publishing access to
  **trusted publisher only** so tokens can't publish at all.

## Cut a release

From this directory, on `main`, with a clean tree:

```sh
npm run release:dry   # full rehearsal — prints every step, changes nothing
npm run release       # prompts for the version bump, then does everything
```

What it does, in order (see `.release-it.json`):

1. **Gates** — typecheck (server + web), tests, and the egress airgap proof
   must pass (`before:init`).
2. **Bumps** `package.json` (you pick patch/minor/major at the prompt;
   strict semver, `0.x` during the pilot).
3. **Builds** the SPA into `web/dist` with Vite (`after:bump`) — a pre-tag
   check that the UI compiles; CI rebuilds it at publish time via `prepack`.
4. **Commits** `chore: release v<version>`, **tags** `v<version>`, and
   **pushes** with tags.
5. **Opens a GitHub release** in your browser, pre-filled with
   auto-generated notes — review and publish it.
6. The pushed `v<version>` tag **triggers the Release workflow**
   (`.github/workflows/release.yml`), which re-runs the gates and
   **publishes to npm** via trusted publishing. Watch it in the repo's
   Actions tab; the npm page shows the provenance badge when it's done.

To publish the current version without bumping (e.g. the very first
release of the current `package.json` version): `npm run release -- --no-increment`.

> **Why plain `npm publish` (unlike the tracing SDK's workflow):** coach ships
> its runtime as `server/*.ts` executed via `tsx`, with no dev-vs-publish
> `exports` rewrite to reconcile — the committed manifest is already what
> consumers get. The one build step is the web SPA, which `prepack`
> (`vite build web`) produces into `web/dist` right before the `files`
> whitelist packs it. So the workflow just runs `npm publish`; npm does the
> OIDC exchange and attaches provenance.

## After publishing

- Verify: `npm view @glassray/coach` and a scratch
  `npx @glassray/coach@latest start` smoke test in a clean directory.
- If this checkout is the Glassray monorepo submodule: bump the gitlink in
  the parent repo (`git add coach` + commit) so the platform pins the
  released commit.

## Later

If maintainer-driven releases become a bottleneck, the version/tag half can
also move into Actions (a `workflow_dispatch` wrapping `release-it --ci`). The
publish half is already there.
