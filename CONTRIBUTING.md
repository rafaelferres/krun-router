# Contributing

krun-router has no runtime dependencies and needs Node.js 22 or newer.

## Tests

```bash
npm test           # offline: mocked Krun and provider servers, no credentials needed
npm run test:live  # optional: real Krun API, needs a configured key (krun-router config)
```

CI runs the offline suite on Linux, macOS and Windows. Live tests never run in CI.
New behavior needs a test in `test/` that fails without the change.

## Layout

```text
bin/                   thin entry points; every alias calls src/cli/main.mjs
src/cli/               one file per command (config, doctor, claude, codex, opencode, kimi, explain)
src/router.mjs         provider-neutral routing: one Krun decision per fresh turn, pinned for the turn
src/policy.mjs         turns a Krun answer into the model that runs (pure, deterministic)
src/krun-client.mjs    /v1/decide client; never throws, always fails open
src/proxy.mjs          local HTTP proxy used by the Claude, Codex and Kimi adapters
src/adapters/          one file per coding CLI: request parsing, fresh-turn detection,
                       catalog, request rewriting, launch arguments and environment
src/opencode-plugin/   OpenCode plugin (runs inside OpenCode; no imports)
skills/                /krun-explain for each CLI
test/                  node:test suites; test/live/ holds the opt-in real-API checks
```

Adding a CLI means a new adapter plus a command; the router, policy and Krun client stay
unchanged.

## Style

- ES modules (`.mjs`), no build step, no dependencies.
- Keep code small and comments short; explain why, not what.
- Never log or print credentials, and never write to the user's CLI configuration files:
  pass settings per process (environment variables or arguments) instead.
- Routing must fail open: any error keeps the current model and the turn continues.
