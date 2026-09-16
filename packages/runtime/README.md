# ReMCP local runtime

`@remcp/runtime` is the local device runtime for [ReMCP](https://remcp.delio24.com). It is an MCP
server that runs on a computer you paired with ReMCP and executes the file, search, terminal, and
process tools that the hosted ReMCP MCP endpoint exposes to ChatGPT and Codex.

The ReMCP device agent starts this runtime as a child process and talks to it over stdio. The runtime
never talks to the network on its own: it only answers the paired agent, which holds the device
credential you can revoke at any time.

## Install

The runtime is installed automatically by the ReMCP device client:

```bash
npm install -g @remcp/remcp
remcp install
```

To run it directly:

```bash
npx @remcp/runtime --describe   # version, limits, configuration, telemetry state
npx @remcp/runtime --print-tools
npx @remcp/runtime              # MCP server over stdio
```

## Tools

23 tools, all implemented in this repository.

| Tool | Behavior |
| --- | --- |
| `read_file`, `read_multiple_files` | Read text files, with line paging and per-file errors in batch reads. |
| `list_directory`, `get_file_info` | Inspect directory contents and file metadata. |
| `write_file`, `edit_block` | Create, replace, or append file content; apply an exact-context text edit with a whitespace-tolerant fallback. |
| `create_directory`, `move_file`, `copy_file` | Create directories; move, rename, or copy without overwriting an existing path unless asked. |
| `start_search`, `get_more_search_results`, `stop_search`, `list_searches` | Streaming filename and content search with pagination, using `rg` when it is installed. |
| `start_process`, `read_process_output`, `wait_for_process_output`, `interact_with_process`, `force_terminate`, `list_sessions` | Run and drive terminal sessions, including REPLs, with pattern waits instead of polling. |
| `list_processes`, `kill_process` | Inspect and terminate operating-system processes. |
| `get_runtime_info`, `get_runtime_stats` | Read-only introspection of configuration, limits, guardrails, and local counters. |

There is deliberately no `set_config_value`: a model must not be able to rewrite its own device
limits. Configuration is file- and environment-based, owned by the person at the computer.

`--print-tools` prints the exact JSON contract (schemas and annotations) the runtime advertises, and
`src/catalog.mjs` is the single source of truth for it.

## Usage metrics

Usage metrics are **opt-out**, matching the ReMCP client. They cover tool names, durations, outcomes,
coarse error classes, and session counts. They never include file paths, file contents, command
strings, tool arguments, or tool output - the event schema is a whitelist, so a tool cannot leak
those fields even by accident.

Transport is the point that matters: the runtime has **no telemetry endpoint**. Events are emitted as
an MCP notification (`notifications/remcp/telemetry`) to the agent that started the runtime, and the
agent forwards them over the WebSocket connection it already holds to your own ReMCP account. There
is no install ping, no postinstall script, no third-party processor, no remote feature flags, and no
A/B assignment.

Turn it off in any of these ways:

```bash
remcp telemetry off                       # the ReMCP client writes both config files
export REMCP_RUNTIME_DISABLE_TELEMETRY=1  # environment
```

```json
{ "telemetryEnabled": false }
```

in `~/.config/remcp/runtime.json`. `--describe` always reports the current state.

## Safety model

- **No network calls.** The runtime opens no sockets. Every byte it emits goes to the paired agent.
- **Symlink-aware confinement.** `allowedRoots` is enforced against the resolved real path of the
  deepest existing ancestor, not against the lexical string, so `<allowed>/link -> /etc` cannot be
  used to read or write outside the allowed directories.
- **No silent overwrites.** `move_file` fails when the destination exists; `copy_file` requires
  `overwrite: true`; `edit_block` fails unless the number of matched blocks equals
  `expected_replacements`.
- **Catastrophic-command guardrail.** Commands that format filesystems, write raw block devices,
  repartition disks, power off the host, fork-bomb, or recursively destroy a root path are refused
  before they run (`dangerousCommands: block`, the default). `warn` runs them and reports the match;
  `allow` disables the built-in list. User `blockedCommands` entries are always enforced.
- **Secret masking.** `list_processes` masks command arguments that look like tokens, passwords, or
  API keys before returning them.
- **Bounded everything.** Tool results are capped (`maxOutputBytes`), writes are capped
  (`maxWriteBytes`), buffered session output is capped (`maxBufferedLines`), and reads are paged.
- **Protected processes.** `kill_process` refuses pid 1, the runtime itself, and the ReMCP agent that
  hosts it.

These are guardrails, not an operating-system sandbox. A user who can run a shell can reach anything
their account can reach; use a container, a VM, or a dedicated user account when that matters.

ReMCP device credentials are scoped to the paired computer and can be revoked from the ReMCP
workspace; revoking a device disconnects the agent that spawns this runtime.

## Configuration

Optional settings live in `~/.config/remcp/runtime.json` (override the directory with
`REMCP_RUNTIME_CONFIG_DIR`):

```json
{
  "name": "workstation",
  "allowedRoots": ["~/projects", "/srv/data"],
  "blockedCommands": ["rm -rf /", "shutdown"],
  "dangerousCommands": "block",
  "telemetryEnabled": true,
  "maxOutputBytes": 1048576,
  "maxReadLines": 2000,
  "maxBufferedLines": 50000,
  "maxWriteBytes": 8388608,
  "defaultShell": "/bin/bash"
}
```

Every value can also be set with an environment variable: `REMCP_RUNTIME_ALLOWED_ROOTS`,
`REMCP_RUNTIME_BLOCKED_COMMANDS`, `REMCP_RUNTIME_DANGEROUS_COMMANDS`, `REMCP_RUNTIME_TELEMETRY`,
`REMCP_RUNTIME_DISABLE_TELEMETRY`, `REMCP_RUNTIME_MAX_OUTPUT_BYTES`, `REMCP_RUNTIME_MAX_READ_LINES`,
`REMCP_RUNTIME_MAX_BUFFERED_LINES`, `REMCP_RUNTIME_MAX_WRITE_BYTES`, `REMCP_RUNTIME_SHELL`,
`REMCP_RUNTIME_NAME`.

`allowedRoots` is empty by default, which means the paired device can reach anything the operating
system user running the agent can reach. Set it when you want the device to be scoped to specific
directories.

## Session behavior

Terminal sessions and searches live in memory for the lifetime of the runtime process. They end when
the agent restarts, and exited sessions are dropped 30 minutes after they finish.

## Development

```bash
npm install
npm run check
npm test
```

## Relationship to other MCP servers

This runtime is an independent implementation written for ReMCP. It is not a fork of, and shares no
code with, Desktop Commander or any other MCP server. Compared with
[DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) it keeps the same core
remote-computer workflow while dropping the parts ReMCP does not want on a user's machine: 34 runtime
dependencies (Supabase, Puppeteer/md-to-pdf, sharp, exceljs, Tiptap), the install-tracking postinstall
script, remote feature flags and A/B tests, unredacted local tool logs, URL fetching in `read_file`,
and `set_config_value`. What it adds is symlink-aware confinement, the catastrophic-command
guardrail, `copy_file`, pattern waits, whitespace-tolerant edits, and read-only introspection.

## License

MIT.
