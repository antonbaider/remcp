# Changelog

## 0.2.0

First feature-complete first-party release. ReMCP no longer needs to install an upstream MCP server
on a user's computer.

Tools (23, up from 19):

- add `copy_file` with an explicit `overwrite` flag;
- add `wait_for_process_output` so a model can wait for a pattern instead of polling
  `read_process_output`;
- add read-only `get_runtime_info` and `get_runtime_stats`;
- `edit_block` falls back to whitespace-tolerant matching when the exact block is not found, reports
  when it did, and still refuses ambiguous matches; `allow_fuzzy: false` keeps it strict.

Security:

- `allowedRoots` is now enforced against the resolved real path of the deepest existing ancestor.
  Before this release a symlink inside an allowed root (`<allowed>/link -> /etc`) passed the lexical
  prefix check and allowed reads, writes, searches, and listings outside the allowed directories.
- add a built-in catastrophic-command guardrail (`dangerousCommands: block|warn|allow`) covering
  filesystem formatting, raw block-device writes, repartitioning, host power control, fork bombs,
  root-path recursive deletion, root chmod/chown, history wiping, and Windows disk destruction;
- add `maxWriteBytes` so a single write cannot fill the disk through the relay;
- `kill_process` refuses the ReMCP agent process in addition to pid 1 and the runtime itself;
- blocked-command matching is case-insensitive and whitespace-normalized.

Usage metrics:

- opt-out metrics for tool names, durations, outcomes, and session counts, with a whitelisted event
  schema that cannot carry paths, commands, arguments, or output;
- delivered as an MCP notification to the paired agent only - no telemetry endpoint, no install ping,
  no postinstall script, no third-party processor, no remote feature flags;
- one-time notice on first run, `--describe` reports the state, `remcp telemetry off` disables it.

## 0.1.0

Initial runtime: 19 tools for files, search, terminal sessions, and processes, with one dependency
(`@modelcontextprotocol/sdk`), no postinstall script, and no network calls.
