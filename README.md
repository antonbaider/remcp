<p align="center">
  <img src="./assets/remcp-icon.png" width="168" alt="ReMCP logo">
</p>

<h1 align="center">ReMCP</h1>

<p align="center"><strong>Your computer. Your tools. One secure MCP connection.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@remcp/remcp"><img alt="npm" src="https://img.shields.io/npm/v/%40remcp%2Fremcp?style=flat-square&label=npm"></a>
  <a href="https://www.npmjs.com/package/@remcp/runtime"><img alt="runtime" src="https://img.shields.io/npm/v/%40remcp%2Fruntime?style=flat-square&label=runtime"></a>
  <a href="https://www.npmjs.com/package/@remcp/remcp"><img alt="downloads" src="https://img.shields.io/npm/dm/%40remcp%2Fremcp?style=flat-square&label=downloads"></a>
  <img alt="Node.js" src="https://img.shields.io/node/v/%40remcp/remcp?style=flat-square&label=node">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40remcp%2Fremcp?style=flat-square"></a>
  <a href="https://github.com/antonbaider/remcp/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/antonbaider/remcp?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://remcp.site">Website</a> ·
  <a href="https://remcp.site/docs">Docs</a> ·
  <a href="https://remcp.site/security">Security</a> ·
  <a href="https://remcp.site/support">Support</a>
</p>

ReMCP connects a computer you own or administer to ChatGPT, Codex, or any other MCP client. The
device agent makes an **outbound connection only** — no inbound port, no tunnel, no third-party
relay. This repository is everything that runs on your machine: the client and the local device
runtime.

## Packages

| Package | What it is |
| --- | --- |
| [`@remcp/remcp`](packages/client) | The device client: pairing, the outbound agent, the background service, and the usage-metrics switch. |
| [`@remcp/runtime`](packages/runtime) | The first-party local runtime: **43 MCP tools** for files, images, binary transfer, archives, screenshots, search, terminal sessions, and processes, with **two direct dependencies**. |

## Install

**Requires Node.js 22.5 or newer.**

```bash
npm install --global @remcp/remcp@latest
```

Then open **[ReMCP → Connect a machine](https://remcp.site/app/connect)** and generate a
one-time pairing command. Run that exact command on the computer you want to connect; it installs the
runtime and registers the background service.

> Pairing codes are generated in the authenticated workspace, expire automatically, and are
> single-use. Do not invent or reuse a code from documentation.

## Commands

| Command | Purpose |
| --- | --- |
| `remcp start` | Start the device agent in the foreground |
| `remcp status` | Show pairing, runtime, telemetry, and service health as JSON |
| `remcp doctor` | Alias for `status` |
| `remcp install` | Install or repair the persistent user service |
| `remcp update` | Update the client and runtime, then restart the service |
| `remcp uninstall` | Stop and remove the user service |
| `remcp uninstall --purge` | Remove the service and the global packages |
| `remcp telemetry [status\|on\|off]` | Show or change usage metrics for the client **and** the runtime |
| `remcp --version` | Print the installed client version |

## ChatGPT and Codex plugin

The repository root is a portable Agent Plugins package: `plugin.json`, `mcp.json`, icons, and
five workflows in `skills/`. Each skill declares its ReMCP MCP dependency. npm installation pairs
a device; it does not install ChatGPT skills or submit a plugin to OpenAI.

Use the matching release's `remcp-plugin.zip` for a portal upload. It includes every skill reference
and presentation asset. `chatgpt-app-submission.json` contains the tool review metadata. Public CI
checks that the ZIP matches the source tree before publishing either npm package.

The hosted OAuth issuer is `https://remcp.site`; it advertises `openid` and `email`, OIDC
discovery at `/.well-known/openid-configuration`, and UserInfo at `/oauth/userinfo`. Enterprise
restrictions require the linked account's verified email and workspace domain verification.
The front end, backend and database are deployed from the separate `remcp-full` repository.

## The local runtime

`@remcp/runtime` is a clean-room MCP server written for ReMCP. It is not a fork of, and shares no code
with, [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) or any other MCP
server.

**43 tools, seven areas:**

| Area | Tools |
| --- | --- |
| Read | `read_file`, `read_files` (glob), `read_multiple_files`, `read_image`, `read_binary`, `list_directory`, `get_file_info`, `hash_file`, `diff_files` |
| Write | `write_file`, `write_files` (bulk), `write_binary`, `edit_block`, `replace_lines`, `replace_in_files` |
| Organise | `create_directory` (bulk), `move_file`, `copy_file`, `copy_paths`, `move_paths`, `move_to_trash`, `create_archive`, `extract_archive` |
| Delete | `delete_path`, `delete_paths` |
| Transfer | `read_binary` and `write_binary` move any file in base64 chunks both ways; `create_archive` and `extract_archive` move whole trees |
| Screen | `take_screenshot` returns the desktop as an image |
| Search | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Processes | `start_process`, `read_process_output`, `wait_for_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Introspect | `get_system_info`, `get_runtime_info`, `get_runtime_stats` |

**Why the tool list looks different from other computer-control servers.** Three capabilities are
deliberately absent, and everything else the alternatives can do has an equivalent here — usually more
than one:

| Not included | Why |
| --- | --- |
| `write_pdf`, spreadsheet and DOCX editing | These are the reason other servers ship Puppeteer, `sharp`, and `exceljs` — hundreds of megabytes and three install scripts on your computer. ReMCP keeps two small direct runtime dependencies instead. |
| `get_config` / `set_config_value` | A model must not be able to rewrite its own device limits. Configuration is yours, on disk. `get_runtime_info` shows the effective policy read-only. |
| URL fetching in `read_file` | It is a server-side request forgery surface. The runtime reads your computer, not the internet. |

**What ReMCP adds beyond the usual set:** image reads and screenshots that any MCP client can
display, binary transfer in both directions, archive create/extract, `wait_for_process_output` instead
of polling, line-range replacement, project-wide replace, unified diffs, checksums, trash instead of
deletion, and host resource reporting.

**Nothing is gated.** There is no approval prompt, no "are you sure", and no mandatory dry run: a tool
call executes with the full rights of the account running the agent — the same trust model as SSH.
Writes replace by default, moves and copies replace the destination, and the catastrophic-command
guardrail is off unless an operator opts into `warn` or `block`. Files are never written to a local
history log, so nothing about your work is recorded on the machine.

## Unrestricted by design

- **No approval contour.** Nothing in the client, the runtime, or the relay asks for confirmation, and
  no policy stands between the agent and the machine. What the account can do, the agent can do:
  services, packages, databases, containers, `sudo`, git — all through `start_process`.
- **Full transfer in both directions.** `read_binary`/`write_binary` move any file, `create_archive`
  and `extract_archive` move whole trees, and `take_screenshot` shows the desktop.
- **Optional hardening, not defaults.** `remcp godmode on` lifts the roots, the blocklist and the
  guardrail for one computer — and only a person at that computer can turn it on; no MCP tool
  accepts it. `allowedRoots` confines the device when an operator sets it,
  `dangerousCommands` can warn or refuse catastrophic commands, and `blockedCommands` adds a deny
  list. All three are off unless configured, and the runtime refuses to start — loudly — if its
  `runtime.json` cannot be parsed, so a limit can never be dropped silently.
- **Crash-resistant.** A bad shell, a closed stdin, or a 40 MB line cannot take the runtime down; the
  agent restarts it if it exits, so a device recovers instead of going quietly offline.
- **Outbound-only.** Per-device revocable credential, hashed server-side, stored locally with
  restrictive permissions. Runtime metadata from a custom server requires an explicit
  `--trust-runtime` decision.
- **No local history.** Tool arguments and outputs are never written to a log on your computer.

## Usage metrics

Both the client and the runtime collect **opt-out** usage metrics: tool names, durations, outcomes,
coarse error classes, session counts, and device health samples. They never include file paths, file
contents, command strings, tool arguments, or tool output — the event schema is a whitelist, so those
fields have nowhere to travel.

There is no telemetry endpoint and no third-party processor. The runtime emits MCP notifications to
the agent, and the agent forwards them over the authenticated WebSocket it already holds to **your**
ReMCP account. No install ping, no postinstall script, no remote feature flags, no A/B assignment.

```bash
remcp telemetry off      # one switch for the client and the runtime
remcp telemetry status
```

## Development

```bash
npm install
npm run check
npm test
```

Both workspaces are plain ESM with no build step. The contract commands (`--help`, `--version`,
`--print-tools`, `--describe`) work with no dependencies installed, so CI can diff the advertised
tool surface against the published tarball.

## License

MIT.
