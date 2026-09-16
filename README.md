# ReMCP

ReMCP is an open-source remote MCP bridge for computers you control. A lightweight device agent
connects **outbound** to a ReMCP relay, so ChatGPT, Codex, or another MCP client can work with local
files, directories, searches, terminal sessions, and processes without exposing an inbound port on
the computer.

- Hosted service: <https://remcp.delio24.com>
- MCP endpoint: `https://remcp.delio24.com/mcp`
- Plugin manifest: [`plugin.json`](plugin.json) · MCP configuration: [`mcp.json`](mcp.json)
- License: MIT

## Packages

| Package | Directory | What it does |
| --- | --- | --- |
| [`@remcp/remcp`](packages/client) | `packages/client` | Device client: pairing, the outbound agent, and the user service (`remcp start`, `status`, `update`, `install`, `uninstall`, `telemetry`). |
| [`@remcp/runtime`](packages/runtime) | `packages/runtime` | First-party local device runtime: 23 MCP tools for files, search, terminal sessions, and processes, with one dependency. |

Both packages are published from this repository. The hosted relay and workspace are operated
separately; this repository is everything that runs on your own computer.

## Quick start

Requires Node.js 22.5 or newer.

```bash
npm install --global @remcp/remcp@latest
```

Then open <https://remcp.delio24.com/app/connect>, sign in, choose **Generate pairing command**, and
run the generated command on the computer you want to pair. Verify with `remcp status`, and add
`https://remcp.delio24.com/mcp` to your MCP client. Authentication uses OAuth 2.1 authorization code
with PKCE and rotating refresh credentials.

## Usage metrics

The agent and the runtime collect **opt-out** usage metrics: tool names, durations, outcomes, coarse
error classes, session counts, and device health samples (uptime, load, memory, versions). They never
include file paths, file contents, command strings, tool arguments, or tool output — the event schema
is a whitelist, so those fields cannot be emitted even by accident.

There is no telemetry endpoint and no third-party processor. Events travel as MCP notifications from
the runtime to the agent, and the agent forwards them over the authenticated WebSocket it already
holds to your own ReMCP account. There is no install ping, no postinstall script, no remote feature
flags, and no A/B assignment.

```bash
remcp telemetry off     # one switch for the client and the runtime
remcp telemetry status
```

## Security

- no inbound port on paired computers; the agent only dials out;
- one revocable credential per paired device, stored as a hash server-side;
- pairing codes are short-lived and single-use;
- the runtime opens no sockets of its own and has no postinstall script;
- device metrics are opt-out, self-hosted, and limited to a whitelisted event schema.

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT.
