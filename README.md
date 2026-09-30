# krun-router

Automatic per-turn model routing for Claude Code, Codex, OpenCode and Kimi Code, powered by Krun.

krun-router keeps the native experience of each CLI but lets
[Krun](https://krun.ai) choose the model for each fresh user turn.

> This is an independent open-source project by Rafael Ferres and is not an official
> Krun product. It uses the public Krun API for routing decisions.

```bash
npm install -g krun-router

krun-router config
krun-router doctor

krun-router claude
```

```text
> rename getUserData to fetchUserData

[Krun] → <fast-model>

> investigate this race condition across the queue and worker

[Krun] → <stronger-model>
```

(Illustrative: the actual models are whichever ones your own account can use.)

- [How it works](#how-it-works)
- [Installation and setup](#installation-and-setup)
- [Claude Code](#claude-code)
- [Codex](#codex)
- [Manual model override](#manual-model-override)
- [Explaining a decision](#explaining-a-decision)
- [Commands](#commands)
- [Configuration](#configuration)
- [Privacy](#privacy)
- [Failure behavior](#failure-behavior)
- [Development](#development)
- [Limitations](#limitations)

## How it works

```text
you → Claude Code → local krun-router proxy → Anthropic
                      │
                      └→ Krun: what kind of task is this turn?

you → Codex → local krun-router proxy → OpenAI
                 │
                 └→ Krun: what kind of task is this turn?
```

`krun-router claude` and `krun-router codex` start a small proxy on `127.0.0.1`, point your
installed CLI at it through that CLI's own supported base-URL / provider mechanism, and launch
it with your arguments. You keep your login, subscription, tools, MCP servers, permissions,
sessions and UI. Inference goes straight from your machine to Anthropic or OpenAI with your
own credentials; Krun only decides which model runs a turn.

For each request the proxy:

1. **Classifies it.** Only the first request of a new human turn is routed. Tool-result
   continuations, streaming follow-ups, title generation, summaries, compaction and token
   counting are never routed.
2. **Discovers the models you can use**, as your CLI sees them (Claude Code's account model
   catalog plus context windows from Anthropic's `/v1/models`; Codex's `/models` catalog).
   Nothing is hard-coded and each model version is a separate choice.
3. **Filters by capability** locally: vision input, tool calling, context size and
   provider-specific request formats.
4. **Asks Krun once** (`POST /v1/decide`), with your new prompt as the context, two questions:
   what kind of task this is (a question, a command, a small edit, a bug fix, a feature, a
   refactor, architecture, hard debugging, a security review, a follow-up …) and whether you are
   rejecting the previous attempt ("that didn't work", "still failing"). Krun is an intent
   classifier; asking it to pick among model ids directly measured worse than always using the
   smallest model (see [Routing evaluation](#routing-evaluation)).
5. **Applies policy**: each kind maps to a tier (small, medium, large); the cheapest compatible
   model of that tier runs. A follow-up keeps the current model; a rejected attempt moves one
   tier above the current model; a downgrade that would rewrite a large warm prompt cache for
   less than it saves keeps the current model. `mode` shifts the mapping (see
   [Configuration](#configuration)).
6. **Pins the model for the whole turn**, including every tool call; the next prompt you type
   is routed again.
7. **Rewrites only what depends on the model**: the `model` field plus settings the chosen
   model cannot accept (for example thinking/effort or reasoning levels). Everything else,
   including your auth headers, is forwarded unchanged.

The main agent, each sub-agent and each parallel session keep separate routing state.

The goal is task/model suitability: required reasoning, tools and context come first. Lower
cost is a consequence of not over-provisioning easy turns.

## Installation and setup

Requires Node.js 22+ and an installed, logged-in [Claude Code](https://code.claude.com/docs/en/setup)
and/or [Codex CLI](https://developers.openai.com/codex/cli).

```bash
npm install -g krun-router
krun-router config      # asks for your Krun API key and a few optional settings
krun-router doctor      # checks the key, the Krun API and your CLIs
```

```text
Krun Router setup

Krun API key:
> ****************

Enable debug logging? [y/N]:
>

Configuration saved to:
/home/you/.krun-router
```

`config` never makes a routing request. `doctor` validates the key with `GET /v1/models`,
which involves no model inference.

Without a key, `krun-router claude` and `krun-router codex` start the plain CLI without
routing.

## Claude Code

```bash
krun-router claude                  # instead of: claude
krun-router claude --resume
krun-router claude -p "fix the failing test"
```

Every argument after `claude` is passed to the real `claude` unchanged, including `--help`
(which therefore shows Claude Code's own help; wrapper help is `krun-router help claude`).

- The session starts on **Krun Router**, an extra row in `/model`.
- The routed model is shown in the status line: `[Krun] → <model> (0.91)`. If you already
  have your own status line, yours is kept.
- `/krun-explain` shows why the last prompt got its model.

Mechanics: `ANTHROPIC_BASE_URL` points at the proxy (an existing `ANTHROPIC_BASE_URL` becomes
the proxy's upstream) and `ANTHROPIC_CUSTOM_MODEL_OPTION` adds the picker row. The starting
model is set per process with `ANTHROPIC_MODEL`; nothing is written to your Claude settings.
If you pick Krun Router with Enter (which Claude Code saves as your default), your previous
default is restored when the session ends.
`ENABLE_TOOL_SEARCH=true` is also set (unless you set it yourself or use your own
`ANTHROPIC_BASE_URL`): Claude Code otherwise turns MCP tool search off behind a proxy and
sends every tool definition inline on every request.

## Codex

```bash
krun-router codex                   # instead of: codex
krun-router codex exec "fix the tests"
krun-router codex resume --last
```

Every argument after `codex` is passed to the real `codex` unchanged, after temporary `-c`
overrides that define a `krun` provider pointing at the proxy. Nothing is written to
`~/.codex/config.toml`. ChatGPT login and API-key login both keep working against their
native upstreams (`chatgpt.com/backend-api/codex` or `api.openai.com/v1`, honoring
`OPENAI_BASE_URL`).

- **Krun Router** is the first entry in `/model`, cloned from your default model's entry.
- Each routed turn starts with one line: `[Krun] → <model> (0.91)`. It is removed from the
  conversation before it is sent back to OpenAI.
- `$krun-explain` shows why the last prompt got its model.
- Reasoning effort is mapped to the nearest level the routed model supports.
- If Codex is configured for another provider (Azure, `--oss`, a local model), it starts
  untouched, without routing.

## OpenCode

```bash
krun-router opencode                # instead of: opencode
krun-router opencode run "fix the tests"
```

Requires OpenCode v2. A plugin is loaded for this process only (through
`OPENCODE_CONFIG_CONTENT`, added to any plugins you already configure) and OpenCode runs
with its private server (`--standalone`, added for you). Nothing is written to your OpenCode
config. There is no proxy: the plugin switches the session's model itself, so every provider
and login OpenCode supports keeps working.

- Before each prompt, Krun chooses among the models of the provider you selected; the choice
  shows as the session's model. Tool steps, titles and compaction are not routed.
- Choosing a model in `/models` pauses routing for that session; `/krun-auto` resumes it.
- A toast shows each new routing decision (`[Krun] → <model> …`); the plugin's TUI part is
  loaded by OpenCode itself from the same plugin directory.
- `/krun-explain` shows why the last prompt got its model.
- Sub-agent sessions keep their own model. With `--server`, OpenCode starts without routing.

## Kimi Code

```bash
krun-router kimi                    # instead of: kimi
krun-router kimi -p "fix the tests"
```

Every argument after `kimi` is passed to the real `kimi` unchanged. Routing uses a Moonshot
API key: `MOONSHOT_API_KEY` (optionally `MOONSHOT_BASE_URL`), or Kimi Code's own
`KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY`. Without one, Kimi Code starts without routing.

- **Krun Router** is the default model and appears in `/model`. It is defined for the process
  with `KIMI_MODEL_*` environment variables; nothing is written to `~/.kimi-code/config.toml`.
- Candidates are the chat models your key lists at `GET /models`, with their context size,
  thinking and image support.
- `/krun-explain` shows why the last prompt got its model (installed into `~/.kimi-code/skills`).
- Picking another model in `/model` bypasses the proxy entirely.
- To see the routed model in the footer, add a status line command to `~/.kimi-code/tui.toml`
  (Kimi Code reads it only from that file, which krun-router never writes). The first routed
  launch prints the exact line, for example:

  ```toml
  [status_line]
  command = '"/path/to/node" "/path/to/krun-router/bin/krun-statusline.mjs"'
  ```

  Outside `krun-router kimi` the same line shows Kimi Code's own model.

## Aliases

`krun-claude`, `krun-codex`, `krun-opencode`, `krun-kimi` and `krun-explain` are installed too.
Each is exactly the matching `krun-router <command>` (same implementation, arguments passed
through unchanged).

## Manual model override

Human choice always wins.

- Select a concrete model in `/model` (or pass `--model` / `-m`): requests pass through
  unchanged, Krun is not called, and the status line shows `[Krun] paused · manual model …`.
- Select **Krun Router** again and routing resumes with your next prompt.
- A model that an agent definition pins explicitly is treated as a manual choice too.

## Stats

```bash
krun-router stats                 # everything recorded
krun-router stats --days 7 --cli claude
krun-router stats --json
```

Routed sessions append one prompt-free line per decision and per provider response to
`~/.krun-router/usage.jsonl`. `stats` shows turns routed vs kept (low confidence, follow-up,
switching cost, timeout, only one model, manual), Krun latency p50/p95 and timeout rate,
tokens per model, and estimated cost and
savings. Savings compare every request with the same tokens on the model its conversation
started on; cache writes caused by a switch are priced as cache reads on that model, so the
estimate leans against routing. Claude list prices are built in; add others in
`~/.krun-router/prices.json` as `{ "model-id": [input, output, cacheRead, cacheWrite] }` (USD per
million tokens).

## Explaining a decision

```bash
krun-router explain               # latest decision (current or most recent session)
krun-router explain <session-id>
krun-router explain --history     # one line per recent decision
krun-router explain --json        # the full recorded exchange
```

Inside the CLIs: `/krun-explain` (Claude Code) and `$krun-explain` (Codex).

```text
┌─ Krun Router ────────────────────────────────┐
│                                              │
│ Prompt          refactor the auth module     │
│ Selected        model-x                      │
│ Previous        model-a                      │
│ Confidence      0.91                         │
│ Abstained       no                           │
│ Latency         312 ms                       │
│ Request id      req_…                        │
│                                              │
│ Candidates                                   │
│ model-a                                 0.04 │
│ model-b                                 0.19 │
│ model-x *                               0.77 │
│                                              │
│ Context                                      │
│ tokens          ~18,400                      │
│ new turn        yes                          │
│ tools           yes                          │
│ vision          no                           │
│                                              │
│ Policy                                       │
│ manual override no                           │
│ capability pass yes                          │
│ fallback        no                           │
└──────────────────────────────────────────────┘
```

Explanations never ask Krun again: they render the exchange recorded at decision time. The
last 20 decisions per CLI session are kept in a private temp file (`<tmp>/krun-router/`),
and files older than three days are deleted automatically.

## Commands

```text
krun-router config                    interactive setup
krun-router config show               effective values and where each comes from
krun-router config set <key> <value>  api-key | debug | status
krun-router config reset [--yes]      remove saved configuration and credentials
krun-router doctor                    check configuration and integrations
krun-router claude [args...]          launch Claude Code with routing
krun-router codex [args...]           launch Codex with routing
krun-router opencode [args...]        launch OpenCode with routing
krun-router kimi [args...]            launch Kimi Code with routing
krun-router explain [session]         explain the latest routing decision
krun-router stats [--days N]          routing, token and cost statistics
krun-router eval [options]            measure routing quality on labelled cases
krun-router help <command>            wrapper help for a command
krun-router --version
```

`config set api-key` without a value prompts for the key without echoing it, which keeps it
out of your shell history.

```text
$ krun-router config show
Krun Router configuration

API URL          https://api.krun.ai         fixed  
API key          krun_live_••••••••Fk2       credentials
Routing timeout  5000 ms                     fixed  
Mode             balanced                    default
Debug            off                         default
Status output    on                          default
```

`doctor` reports errors (✗), warnings (!) and passing checks (✓), and exits non-zero only on
errors. A missing Claude Code or Codex is a warning as long as the other is installed.

## Configuration

Precedence, per value:

```text
CLI flags (before the command, e.g. krun-router --debug claude)
  ↓
environment variables
  ↓
~/.krun-router/config.json and ~/.krun-router/credentials.json
  ↓
legacy ~/.krun-router.env
  ↓
defaults
```

| Setting | `config set` key | Environment | Default |
|---|---|---|---|
| API key | `api-key` | `KRUN_API_KEY` | none (routing off) |
| Routing mode | `mode` | `KRUN_MODE` | `balanced` |
| Debug log | `debug` | `KRUN_DEBUG=1` | off |
| Status output | `status` | `KRUN_NO_STATUS=1` disables | on |

Global flags: `--debug`, `--no-status`.

Modes (measured on the labelled cases in `eval/`; see [Routing evaluation](#routing-evaluation)):

| Mode | Small tasks | Medium tasks | Large tasks | Low confidence | Rejected attempt |
|---|---|---|---|---|---|
| `economy` | small | small | large | routed anyway | escalates at ≥ 0.9 |
| `balanced` | small | medium | large | routed anyway | escalates at ≥ 0.8 |
| `quality` | medium | medium | large | keeps the current model below 0.2 | escalates at ≥ 0.7 |

Model tiers come from model names (`haiku`, `mini`, `flash`, `luna`, `turbo` … are small;
`opus`, `fable`, `astra`, `thinking`, `pro` … are large; anything else is medium). Within a
tier the cheapest known model runs (`quality`: the priciest).

The Krun API URL (`https://api.krun.ai`) and the routing deadline (5000 ms) are fixed and
cannot be changed by flag, environment or file, so nothing can send your prompts elsewhere.

Advanced, environment only: `KRUN_MODELS` (comma-separated allowlist of exact model ids Krun
may choose) and `KRUN_DUMP_DIR` (raw request dumps for debugging; see [Privacy](#privacy)).

A project-local `.env` is not read: a cloned repository could otherwise inject settings such
as `KRUN_DUMP_DIR`. An existing `~/.krun-router.env` keeps working and is
never modified or deleted; `krun-router config` offers its values as defaults.

### Credential storage

- The API key is stored separately from other settings, in `~/.krun-router/credentials.json`.
- On macOS/Linux the directory is `0700` and the files are `0600`. On Windows the credentials
  file's ACL is reduced to your user account with the built-in `icacls`.
- The key is never printed after it is saved: `config show`, `doctor`, errors and logs show at
  most a masked form such as `krun_live_••••••••Fk2`.
- `krun-router config reset` removes only this project's files.
- OS-native credential storage (Keychain, Credential Manager, libsecret) is not implemented
  yet and may be added later.

## Privacy

Krun receives the fresh user prompt and nothing else: not even the list of models you can
use. `~/.krun-router/usage.jsonl` stores models, token counts and reasons, never
prompts.

Krun Router does not send your Anthropic or OpenAI credentials to Krun. Provider
authentication continues to be sent directly to the original provider.

Precisely, per routed turn, the `POST /v1/decide` request contains:

- `context`: the text of the prompt you just typed, with injected system reminders and
  environment blocks removed, truncated to 8,000 characters;
- two fixed questions: a `choice` over task kinds and a yes/no (`noul`) "is the user
  rejecting the previous attempt?";
- your Krun API key as the bearer token.

It does not contain conversation history, tool results, file contents the agent read, provider
credentials, cookies or account identifiers. Separately, the proxy calls Krun's `/health`
(no credentials) at startup to open the connection, and `krun-router doctor` calls
`GET /v1/models` with your Krun key.

The one request the proxy makes on its own with your provider credentials is a model listing
(`GET /v1/models` on Anthropic, the same call Claude Code's gateway discovery makes) to learn
context windows. It goes to your provider, never to Krun.

Nothing logs or stores authorization headers, API keys, cookies or provider credentials, and
request bodies are not logged. `KRUN_DEBUG=1` writes routing metadata (models, reasons,
latency, upstream status codes and provider error messages) to `<tmp>/krun-router/router.log`,
with a redaction pass for anything credential-shaped. The local decision history (used by
`explain`) contains your routed prompts.

`KRUN_DUMP_DIR=<dir>` writes raw request bodies, never headers. **Dumps contain your prompts,
code and tool output**: use it only for debugging and delete the files afterwards.

## Failure behavior

Routing is fail-open: Krun can never make your CLI unusable.

| Situation | Result |
|---|---|
| No API key | The CLI starts without the proxy, as if you ran it directly |
| Krun timeout (5000 ms), network or HTTP error | Keep the current model and continue immediately |
| Invalid response or an unknown task kind | Keep the current model |
| Follow-up with no task of its own ("go ahead", "thanks") | Keep the current model |
| `quality` mode and classification confidence below 0.2 | Keep the current model |
| No compatible model at the task's tier | The nearest tier, larger first |
| Cheaper model, but switching would rewrite a large warm prompt cache for less than it saves | Keep the current model |
| Current model incompatible with the request (e.g. context too large) | First compatible candidate |
| First turn | Your configured model, or the provider's first catalog model |
| Proxy cannot parse a request | Forward it unchanged |

Krun is on the critical path only for the first request of a turn, with a hard deadline and
no retries. Every fallback is recorded and visible in `explain` and the status line
(`[Krun] → <model> · kept: <reason>`).

## Development

```bash
git clone https://github.com/rafaelferres/krun-router
cd krun-router
npm install
npm test          # offline: mocked provider and Krun servers, no credentials needed
npm link          # puts krun-router and the aliases on your PATH
npm run test:live # optional: real Krun API checks, only with a configured key
```

No runtime dependencies: Node's standard library only.

```text
bin/                  krun-router and its krun-* aliases
src/cli/              command parsing, config wizard, doctor, launch commands
src/config.mjs        the single source of effective configuration
src/credentials.mjs   private file storage and key masking
src/router.mjs        provider-neutral routing: route() + once-per-turn pinning
src/krun-client.mjs   the /v1/decide call (deadline, no retries, never throws)
src/policy.mjs        deterministic decision rules
src/capabilities.mjs  local hard constraints
src/adapters/         everything specific to each CLI (Claude Code, Codex, OpenCode, Kimi Code)
src/opencode-plugin/  the OpenCode plugin (runs inside OpenCode)
src/stats.mjs         usage ledger, prices and savings estimate
eval/                 labelled routing cases for krun-router eval
src/proxy.mjs         generic loopback HTTP proxy
```

Supporting another agent (Aider, Cline, an OpenAI-compatible gateway) means writing one
adapter that produces the normalized turn; the router core does not change.

### Routing evaluation

`krun-router eval` classifies the labelled prompts in `eval/routing.jsonl` (tuning set),
`eval/holdout.jsonl` (written after tuning, never tuned on) and `eval/escalation.jsonl` with the
real Krun API, then runs the production policy offline for every provider family in
`eval/families.json`, mode and confidence floor. It reports accuracy (chosen tier acceptable),
waste (bigger than needed), risk (smaller than needed), relative cost and latency, plus
rejection detection per mode. One `/v1/decide` call per case and variant (more than 100 need
`--yes`). Request variants live in `VARIANTS` (src/cli/eval-command.mjs).

Latest run (`eval/phase2-report.json`, Claude family, conversation on the large model):

| Policy | Tuning set accuracy | Risk | Relative cost | Holdout accuracy | Holdout risk |
|---|---|---|---|---|---|
| v1: Krun picks a model id, advisory abstentions kept (`eval/baseline-report.json`) | 41.9% | 0% | 100% | — | — |
| v1: Krun's top model id, always | 59.7% | 12.9% | 70.3% | — | — |
| always small | 56.5% | 43.5% | 20% | 43.8% | 56.3% |
| `economy` | 77.4% | 19.4% | 45.8% | 62.5% | 18.8% |
| `quality` | 67.7% | 0% | 85.2% | 62.5% | 0% |
| `balanced` (task kinds) | 93.5% | 3.2% | 60% | 81.3% | 0% |

Accuracy counts the chosen tier as right when it is one of the acceptable tiers, so `quality`
scores lower by design (it spends more to take no risk). The task taxonomy was tuned on the
tuning set; the holdout shows how far that generalizes. Rejection detection (`balanced`,
≥ 0.8): 80% of rejections caught, no false alarms on 13 cases.

When a provider changes its wire format, `KRUN_DEBUG=1` shows upstream status codes and error
messages and `KRUN_DUMP_DIR` captures the new request shape. Fixes stay in `src/adapters/`.

## Limitations

- Claude Code and Codex request formats are not public contracts. The adapters target Claude
  Code 2.1.x and Codex CLI 0.155 and may need updates when those change.
- Claude Code's own UI shows "Krun Router" as the active model. Its cost estimate for that row
  is not meaningful, it assumes a 200k-token window for auto-compaction, and in `-p` mode it
  prints an `unrecognized_model` notice. The status line and `explain` show the real model.
- The Claude model catalog comes from Claude Code's local catalog cache; before Claude Code
  has cached it once, routing keeps your configured model.
- Background Claude Code sessions (`claude --bg`) outlive the launcher and are not routed.
- In Codex, the status line is a commentary message injected into the streamed response. It
  is stripped before being sent upstream, but other clients reading the same session may
  display it.
- `explain` covers decisions of the current process; after `--resume` in a new process, use
  `krun-router explain <old-session-id>`.
- Routing needs at least two compatible models.
- OpenCode routing uses its v2 plugin API (targets v2.0.x), which is new and may change.
- The Kimi Code subscription login is not routed: Kimi Code keys its OAuth credentials to the
  endpoint URL, so routing it would need a separate login or rewriting your credentials.
- Antigravity CLI (`agy`) is not supported: it ignores base-URL settings, and routing it would
  mean intercepting its HTTPS traffic with a locally trusted certificate authority. Google has
  also restricted accounts that used Antigravity sign-ins through third-party tools, so this is
  deliberately not offered.
- Credentials are stored in a permission-restricted file, not in the OS keychain.

## License

MIT © Rafael Ferres. Portions of the interception mechanics are adapted from
[jev-router](https://github.com/gargpratyush/jev-router) (MIT); see `LICENSE`.

krun-router is not affiliated with or endorsed by Krun. "Krun" refers to the public Krun API
this project uses.
