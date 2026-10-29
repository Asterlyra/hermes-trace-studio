# Hermes Trace Observer

This project ships a read-only Hermes observer plugin in
`hermes-plugin/agent-trace-observer`. It forwards Hermes' stable observer-hook
contract to the local Trace API and never returns a block, context injection,
approval decision, transformed result, or transformed model output.

Install it explicitly with:

```bash
npm run hermes:observer:install
```

Restart `hermes serve` and other long-running Hermes processes after enabling
the plugin. The Trace server creates a mode-0600 local token at
`~/.hermes/agent-trace-observer.token`; the plugin refuses non-loopback URLs.
