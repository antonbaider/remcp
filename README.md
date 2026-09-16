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
  <a href="https://remcp.delio24.com">Website</a> ·
  <a href="https://remcp.delio24.com/docs">Docs</a> ·
  <a href="https://remcp.delio24.com/security">Security</a> ·
  <a href="https://remcp.delio24.com/support">Support</a>
</p>

ReMCP connects a computer you own or administer to ChatGPT, Codex, or any other MCP client. The
device agent makes an **outbound connection only** — no inbound port, no tunnel, no third-party
relay. This repository is everything that runs on your machine: the client and the local device
runtime.

## Packages

| Package | What it is |
| --- | --- |
| [`@remcp/remcp`](packages/client) | The device client: pairing, the outbound agent, the background service, and the usage-metrics switch. |
| [`@remcp/runtime`](packages/runtime) | The first-party local runtime: **30 MCP tools** for files, images, search, terminal sessions, and processes, with **one dependency**. |

## Install

**Requires Node.js 22.5 or newer.**

```bash
npm install --global @remcp/remcp@latest
```

Then open **[ReMCP → Connect a machine](https://remcp.delio24.com/app/connect)** and generate a
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

## The local runtime

`@remcp/runtime` is a clean-room MCP server written for ReMCP. It is not a fork of, and shares no code
with, [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) or any other MCP
server.

**30 tools, six areas:**

| Area | Tools |
| --- | --- |
| Read | `read_file`, `read_multiple_files`, `read_image`, `list_directory`, `get_file_info`, `hash_file`, `diff_files` |
| Write | `write_file`, `edit_block`, `replace_lines`, `replace_in_files` |
| Organise | `create_directory`, `move_file`, `copy_file`, `move_to_trash` |
| Search | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Processes | `start_process`, `read_process_output`, `wait_for_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Introspect | `get_system_info`, `get_runtime_info`, `get_runtime_stats` |

**Why the tool list looks different from other computer-control servers.** Three capabilities are
deliberately absent, and everything else the alternatives can do has an equivalent here — usually more
than one:

| Not included | Why |
| --- | --- |
| `write_pdf`, spreadsheet and DOCX editing | These are the reason other servers ship Puppeteer, `sharp`, and `exceljs` — hundreds of megabytes and three install scripts on your computer. ReMCP keeps one dependency instead. |
| `get_config` / `set_config_value` | A model must not be able to rewrite its own device limits. Configuration is yours, on disk. `get_runtime_info` shows the effective policy read-only. |
| URL fetching in `read_file` | It is a server-side request forgery surface. The runtime reads your computer, not the internet. |

**What ReMCP adds beyond the usual set:** image reads that any MCP client can display,
`wait_for_process_output` instead of polling, line-range replacement, project-wide replace that
previews before it writes, unified diffs, checksums, trash instead of deletion, host resource
reporting — plus guardrails that the alternatives do not have.

## Safety, by design

- **Nothing is destroyed silently.** Replacing a non-empty file needs an explicit `mode`; moves and
  copies never overwrite; deletion goes to the trash; every broad edit can be previewed as a diff.
- **Confinement is real.** `allowedRoots` is checked against the resolved real path, so a symlink
  cannot walk out of an allowed directory.
- **The obvious catastrophes are refused.** Formatting a disk, writing a raw device, repartitioning,
  powering off the host, or recursively destroying a root path is blocked *before* it runs — while
  `grep -n format README.md` still works, because the guardrail reads the command word, not the text.
- **A bad configuration is loud.** An unparseable `runtime.json` stops the device with an explanation
  instead of quietly dropping your limits.
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
