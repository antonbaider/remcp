# Changelog

## 0.2.7

Security and correctness fixes for the device runtime.

- **Symlink confinement fixed.** `read_files`, `replace_in_files` and `set_permissions` walked a
  tree with `stat`, which follows symbolic links, and never re-checked the children they collected.
  A directory symlink inside an allowed root could therefore be read *and rewritten* outside it.
  Traversal now uses `lstat`, never follows a link, and re-resolves every collected path through
  the same confinement check a single-file call uses.
- **Large results no longer kill the runtime.** The inline image limit is 4 MiB instead of 8 MiB:
  base64 costs a third more bytes and the MCP stdio client drops the connection above 10 MB, which
  used to restart the runtime in the middle of a call. The text budget is shared between `content`
  and `structuredContent`, which carry the same string.
- **`apply_patch` inserts zero-context hunks at the right line**: `@@ -N,0 +M,K @@` inserts *after*
  line N, and the previous calculation applied every such hunk one line early while reporting
  success.
- **Glob patterns honour `[abc]`, `{a,b}` and `?`**: character classes and brace alternatives were
  escaped into literal text and matched nothing, and `?` could match a directory separator.

## 0.2.3

Full surface and review-aligned annotations. (0.2.0 was published from an earlier snapshot that
carried 23 tools; 0.2.1 is the release that matches this repository.)

- 37 tools: bulk reads and writes (`read_files` by glob, `write_files` for many files at once), binary transfer in both directions (`read_binary`, `write_binary`, base64 chunks),
  archives (`create_archive`, `extract_archive` for tar, tar.gz, tar.bz2, tar.xz, zip), screenshots
  (`take_screenshot`), `read_image`, `hash_file`, `diff_files`, `replace_lines`, `replace_in_files`,
  `move_to_trash`, `get_system_info`, `wait_for_process_output`, runtime introspection, and a glob
  filter on `list_directory`;
- no approval step anywhere: writes replace by default, moves and copies replace the destination,
  `replace_in_files` applies immediately, and `dry_run` is opt-in for callers who want a preview;
- `dangerousCommands` defaults to `warn`: a catastrophic command runs and the result carries a note,
  with `allow` for silence and `block` to refuse;
- annotations say what the tools do: 19 read-only, 14 destructive (including the tools that replace a
  destination by default), 2 open-world;
- crash-resistance: a bad shell, a closed stdin, a stream with no newlines, a dead parent, or an
  unparseable `runtime.json` cannot leave a device silently offline;
- `read_process_output` offsets are documented and implemented as zero-based line numbers, ranged
  reads no longer consume the new-output cursor, and reads never sleep over buffered data;
- the contract commands work with no dependencies installed, so CI can diff the advertised tool
  surface against the published tarball.

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
