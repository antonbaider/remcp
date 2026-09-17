# Device client

`@remcp/remcp` is the ReMCP device client. It pairs a computer with ReMCP, installs the first-party
local runtime, and runs the outbound-only agent that serves your MCP client's tool calls.

```bash
npm install --global @remcp/remcp@latest
remcp --version
remcp status
```

Pairing commands are generated in the workspace at <https://remcp.site/app/connect>. The
generated command runs `remcp connect --server … --code … --install`, which stores a per-device
credential under `~/.config/remcp/`, installs the runtime from npm, and registers a user service
(systemd on Linux, LaunchAgent on macOS, Scheduled Task on Windows).

## Commands

```text
remcp start                  Run the device agent in the foreground
remcp status                 Show version, pairing, runtime, telemetry and server health as JSON
remcp doctor                 Alias for status
remcp update                 Update the client and runtime, then restart the user service
remcp install                Install or repair the user service
remcp uninstall              Remove the user service
remcp uninstall --purge      Remove the service and the global packages
remcp telemetry [status|on|off]
remcp --version
```

`remcp status` reports the runtime the device would install, whether the agent service is running,
and the current usage-metrics state, so a support request can be answered with one paste.

## What runs on your computer

- the agent (`remcp start`), which holds the device credential and dials
  `wss://remcp.site/agent`;
- [`@remcp/runtime`](https://www.npmjs.com/package/@remcp/runtime), spawned by the agent as an MCP
  stdio server. The runtime executes the tools, opens no network connection, and is supervised: if it
  exits, the agent restarts it with backoff and reports the restart instead of failing silently.

Configuration lives in `~/.config/remcp/config.json` (client) and `~/.config/remcp/runtime.json`
(runtime: allowed roots, blocked commands, output and write limits, and the usage-metrics switch).
Run `npx @remcp/runtime --describe` to print the runtime's effective configuration.

## Usage metrics

Opt-out, self-hosted, and limited to tool names, timings, outcomes, error classes, and device health
samples. No paths, no commands, no arguments, no output, no third-party endpoint, no install ping.
Disable with `remcp telemetry off` or `REMCP_RUNTIME_DISABLE_TELEMETRY=1`; the switch applies to both
the client and the runtime, and restarts the service so it takes effect immediately.

## Security

- Outbound-only connection; the machine never listens.
- One revocable credential per paired device, stored with restrictive permissions.
- Runtime metadata from a custom server is only accepted with an explicit `--trust-runtime`.
- Revoking a device in the workspace closes the connection; the agent then stops retrying and says so
  instead of reconnecting forever.

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT.
