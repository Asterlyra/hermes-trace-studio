# Hermes Trace Studio

Hermes Trace Studio is a local, Hermes-only observability workspace. One user
request becomes one Trace containing the Hermes prompt snapshot, provider
requests, observable reasoning, tools, Skills, MCP calls, subagents, approvals,
usage, and redacted source records.

The program intentionally has no generic Agent Adapter registry and no fallback
runtime. Its server speaks directly to Hermes so new Hermes capabilities can be
captured without waiting for a cross-agent abstraction to change.

## Capture channels

- **Gateway** — starts and controls live turns through `hermes serve` and the
  TUI Gateway JSON-RPC/WebSocket protocol.
- **Observer** — an optional, read-only Hermes plugin captures stable turn,
  provider-request, tool, approval, and subagent hook payloads.
- **SessionDB** — reads `~/.hermes/state.db` in read-only mode for historical
  imports and post-run reconciliation.

Capture completeness is explicit: `full` means Gateway + Observer + SessionDB,
`standard` means Gateway + SessionDB, `history` means SessionDB import, and
`partial` means one or more expected channels were unavailable.

## Requirements

- Node.js 22.13 or newer
- Hermes Agent with the modern `hermes serve` command
- A configured Hermes model provider for live turns

The currently validated local runtime is Hermes Agent v0.19.1. Protocol fields
are preserved as redacted Raw Events when no normalizer is known yet.

## Run locally

```bash
npm install
npm run dev
```

The interface runs at `http://localhost:3000` and the loopback Trace API at
`http://127.0.0.1:4318`. The Trace API starts its own loopback-only
`hermes serve` process when the first live turn connects.

## Optional deep observer

```bash
npm run hermes:observer:install
```

Restart long-running Hermes processes after installation. The plugin is
observer-only and uses a mode-0600 local token. It never blocks tools, injects
Prompt context, answers approvals, transforms tool output, or transforms model
output.

## Verify

```bash
npm test
npm run lint
```

## Project map

```text
app/                         Icewater Hermes dashboard
server/index.mjs             Loopback Hermes Trace HTTP/SSE API
server/hermes/index.mjs      Only public Hermes runtime module
server/hermes/gateway-client.mjs
                             Hermes JSON-RPC/WebSocket client
server/hermes/normalizer.mjs Gateway and observer event semantics
server/hermes/session-reader.mjs
                             Read-only state.db import and reconciliation
server/store.mjs             Local redacted SQLite Trace persistence
hermes-plugin/               Read-only Hermes observer plugin source
```

## Security boundary

- Trace API and managed Hermes Gateway bind to loopback.
- Hermes remains the owner of approval, clarify, sudo, and secret decisions.
- Secret and sudo response values are forwarded in memory and are never written
  as Trace events.
- Observer delivery requires a local token and rejects non-loopback URLs.
- SessionDB is opened read-only.
- Common credentials and sensitive keys are redacted before persistence and
  export.

The interface displays only reasoning text Hermes deliberately exposes or
stores. It does not claim access to undisclosed model chain of thought.

## License

Original project code is available under the [MIT License](LICENSE); third-party dependencies retain their own licenses.
