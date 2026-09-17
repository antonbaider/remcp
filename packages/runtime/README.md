# ReMCP local runtime

`@remcp/runtime` is the local device runtime for [ReMCP](https://remcp.site). It is an MCP
server that runs on a computer you paired with ReMCP and executes the file, image, search, terminal,
and process tools that the hosted ReMCP MCP endpoint exposes to ChatGPT and Codex.

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

35 tools, all implemented in this repository. Nothing is gated behind an approval step: a tool call
executes.

| Area | Tools |
| --- | --- |
| Read | `read_file`, `read_multiple_files`, `read_image`, `read_binary`, `list_directory` (glob filter), `get_file_info`, `hash_file`, `diff_files` |
| Write | `write_file`, `write_binary`, `edit_block` (whitespace-tolerant fallback, optional `dry_run`), `replace_lines`, `replace_in_files` |
| Organise | `create_directory`, `move_file`, `copy_file`, `move_to_trash`, `create_archive`, `extract_archive` |
| Transfer | `read_binary` / `write_binary` stream any file as base64 chunks in both directions; `create_archive` / `extract_archive` move whole trees |
| Screen | `take_screenshot` returns the desktop as an image on Linux, macOS, and Windows |
| Search | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Processes | `start_process`, `read_process_output`, `wait_for_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Introspection | `get_system_info`, `get_runtime_info`, `get_runtime_stats` |

The hosted ReMCP endpoint adds `list_devices` so a model can pick a machine. Everything else the
agent may need — service management, package installs, git, docker, `sudo` — runs through
`start_process`, which is an unrestricted shell for the account running the agent.

There is deliberately no `set_config_value` (a model must not rewrite its own device limits; use the
file) and no `write_pdf`/spreadsheet/DOCX tooling (that is what drags Puppeteer, `sharp`, and
`exceljs` onto your computer — use `start_process` with whatever tool you already have).

`--print-tools` prints the exact JSON contract (schemas and annotations) the runtime advertises, and
`src/catalog.mjs` is the single source of truth for it.

## No approval staircase

ReMCP is a remote control for computers you own, with the same trust model as SSH: the tool call runs,
and the user's request is the authorization. There is no approval prompt, no "are you sure", and no
dry-run detour unless you ask for one.

- file writes replace by default (`mode: "append"` to add), moves and copies replace the destination
  (`overwrite: false` refuses instead), `replace_in_files` applies immediately (`dry_run: true`
  previews), and `move_to_trash` is there when you want an undo;
- the destructive-command guardrail defaults to `warn`: the command runs and the result carries a note
  when it matches the catastrophic list (`mkfs`, raw device writes, repartitioning, host power
  control, fork bombs, recursive root deletion). `allow` removes even the note, `block` refuses
  before running, and `blockedCommands` adds your own deny list;
- `allowedRoots` is empty, so the device reaches everything the agent's account can reach. Set it to
  confine a device to specific directories, enforced against the resolved real path.

The guarantees that remain are about correctness rather than permission: a bad shell, a closed stdin,
or a 40 MB line cannot take the runtime down; a crashed runtime is restarted by the agent; terminal
sessions run in their own process group so `force_terminate` stops the whole pipeline; and a
misconfigured `runtime.json` stops the device loudly instead of silently dropping your settings.

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

## Runtime properties

- **No network calls of its own.** The runtime opens no sockets: every byte it emits goes to the
  paired agent. Shell commands it runs can of course reach the network, exactly as they would from
  your own terminal.
- **Optional confinement.** `allowedRoots` is empty by default. When you set it, it is enforced
  against the resolved real path of the deepest existing ancestor rather than the lexical string, so
  `<allowed>/link -> /etc` cannot be used to read or write outside the allowed directories.
  `allowedRoots: ["/"]` means the whole filesystem and works as written.
- **Command guardrail.** `dangerousCommands` defaults to `warn`: a catastrophic command still runs and
  the result carries a note. `allow` silences the note, `block` refuses before running. Rules match the
  *command word* of each shell segment, so `grep -n format README.md` is never affected. User
  `blockedCommands` entries are always enforced.
- **A bad configuration is loud.** If `runtime.json` cannot be parsed, the device refuses to start and
  says why, instead of quietly dropping your `allowedRoots` and re-enabling usage metrics.
- **Secret masking.** `list_processes` masks command arguments that look like tokens, passwords, or
  API keys before returning them.
- **Bounded everything.** Tool results are capped (`maxOutputBytes`, also clamped below the MCP
  transport limit), writes are capped (`maxWriteBytes`), buffered session output is capped by both
  line count and total characters - a stream with no newlines cannot grow without limit - and reads
  are paged or chunked.
- **Crash-resistant sessions.** A bogus shell, a closed stdin, or a dead parent cannot take the
  runtime down; sessions run in their own process group so `force_terminate` stops a whole pipeline;
  the agent restarts the runtime if it ever exits, so a device recovers instead of going silently
  offline.
- **Protected processes.** `kill_process` refuses pid 1, the runtime itself, and the ReMCP agent that
  hosts it - the three ways a model could otherwise cut its own connection.

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
  "dangerousCommands": "warn",
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
the agent restarts, and exited sessions are dropped 30 minutes after they finish. The agent watches
this process and restarts it with backoff if it ever exits, so a device recovers instead of staying
silently offline.

## Development

```bash
npm install
npm run check
npm test
```

The contract commands (`--help`, `--version`, `--print-tools`, `--describe`) work without
dependencies installed, so CI can diff the advertised tool surface against the published tarball.

## How it compares with Desktop Commander

This runtime is an independent implementation written for ReMCP. It is not a fork of, and shares no
code with, [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) or any other
MCP server.

| | Desktop Commander 0.2.50 | ReMCP runtime 0.2.0 |
| --- | --- | --- |
| Tools | 26, including config mutators and document tooling | 35, including binary transfer, archives, screenshots, and diffs |
| Runtime dependencies | 34 (Supabase, Puppeteer/md-to-pdf, `sharp`, `exceljs`, Tiptap, ripgrep download) | 2 direct (`@modelcontextprotocol/sdk`, `@jellybrick/dbus-next`) |
| Install scripts | `postinstall` posts an install payload that ignores the telemetry setting | none |
| Telemetry | opt-out, 51 event names, remote feature flags, A/B assignment, third-party processor | opt-out, whitelisted event schema, no endpoint, no flags |
| Install size | 3.78 MB unpacked, 249 files | ~110 kB unpacked, 20 files |
| `read_file` | also fetches arbitrary URLs (SSRF surface) | local files only; `read_binary` transfers any file as base64 |
| Command guardrails | always on, 32 substring-blocked commands, advisory; also refuses read-only mentions | `warn` by default (never blocks), `allow`/`block` opt-in, command-word matching |
| Confinement | always on, checked against the lexical path | opt-in, checked against the resolved real path |
| Local history | writes tool arguments to disk unredacted | none |
| Images | file preview UI in a specific client | `read_image` returns the image to any MCP client |
| Termination | session kill only | whole process group, plus runtime supervision and restart |

What ReMCP deliberately does not implement, and why: document rendering (`write_pdf`) and spreadsheet
handling would put Puppeteer, `sharp`, and `exceljs` on your computer; `get_config`/`set_config_value`
would let the model change its own limits; local usage history would write your arguments to disk;
URL reads in `read_file` would add an SSRF surface. Everything else the upstream server can do has an
equivalent here, and the tool count is higher.

## License

MIT.
