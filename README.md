<p align="center">
  <img src="./assets/remcp-logo.png" width="168" alt="ReMCP logo">
</p>

<h1 align="center">ReMCP</h1>

<p align="center"><strong>Your computer. Your tools. One secure MCP connection.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@remcp/remcp"><img alt="npm" src="https://img.shields.io/npm/v/%40remcp%2Fremcp?style=flat-square&label=npm"></a>
  <a href="https://www.npmjs.com/package/@remcp/remcp"><img alt="downloads" src="https://img.shields.io/npm/dm/%40remcp%2Fremcp?style=flat-square&label=downloads"></a>
  <img alt="Node.js" src="https://img.shields.io/node/v/%40remcp%2Fremcp?style=flat-square&label=node">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40remcp%2Fremcp?style=flat-square"></a>
  <a href="https://github.com/antonbaider/remcp/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/antonbaider/remcp?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://remcp.delio24.com">Website</a> ·
  <a href="https://remcp.delio24.com/docs">Docs</a> ·
  <a href="https://remcp.delio24.com/security">Security</a> ·
  <a href="https://remcp.delio24.com/support">Support</a>
</p>

ReMCP is the lightweight device client that connects a computer you own or administer to your ReMCP workspace. The agent makes an outbound connection only; you do not need to expose an inbound port on the machine.

## Install

**Requires Node.js 22.5 or newer.**

```bash
npm install --global @remcp/remcp@latest
```

Then open **[ReMCP → Connect a machine](https://remcp.delio24.com/app/connect)** and generate a one-time pairing command. Run that exact command on the computer you want to connect.

> Pairing codes are generated in the authenticated workspace, expire automatically, and are single-use. Do not invent or reuse a code from documentation.

## Commands

| Command | Purpose |
| --- | --- |
| `remcp start` | Start the device agent in the foreground |
| `remcp status` | Show pairing and service health |
| `remcp doctor` | Run the same connectivity diagnostics in JSON form |
| `remcp install` | Install the persistent Linux user service |
| `remcp update` | Update ReMCP and the compatible local runtime |
| `remcp uninstall` | Stop and remove the user service |
| `remcp uninstall --purge` | Remove the service and global packages |
| `remcp --version` | Print the installed client version |

## How pairing works

1. Sign in to your ReMCP workspace.
2. Generate a one-time pairing command.
3. Run the command on your machine.
4. ReMCP stores the device credential locally with restrictive permissions.
5. The agent establishes an outbound WebSocket connection to the configured ReMCP service.

For the official service, compatible runtime metadata is delivered as part of the pairing response. A custom ReMCP server must be explicitly trusted with `--trust-runtime` before the client accepts runtime metadata from it.

## Security model

- Outbound-only device connection.
- Per-device revocable credential.
- Local client configuration stored with restrictive permissions.
- Runtime metadata validated before installation.
- Custom servers require an explicit runtime trust decision.
- No pairing secrets belong in issues, screenshots, logs, or documentation.

If a machine should no longer be connected, revoke it from the workspace and remove the local service.

## Update

```bash
remcp update
remcp --version
remcp status
```

## Development

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

## License

MIT © ReMCP contributors. See [LICENSE](LICENSE).
