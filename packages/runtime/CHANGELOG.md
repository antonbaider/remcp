# Changelog

## Unreleased

## 0.2.76 — 2026-09-21

- `browser_find(text=...)` ranks exact semantic targets ahead of broad ancestor text containers, prefers actionable/semantic nodes, and de-duplicates nested matches before applying the result limit.
- Native `h1`–`h6` elements derive the `heading` role, improving browser text targeting and follow-up actions.
- Lockstep patch release with the ReMCP client/server at `0.2.76`.

## 0.2.63 — 2026-09-20

- Lockstep MCP Apps production-surface release with the ReMCP client/server at `0.2.63`; device runtime tool behavior is unchanged from `0.2.62`.

## 0.2.62 — 2026-09-20

- Lockstep skill-routing metadata release with the ReMCP client at `0.2.62`; runtime tool behavior is unchanged from `0.2.61`.

## 0.2.61 — 2026-09-20

- Lockstep plugin/web branding release with the ReMCP client at `0.2.61`; runtime tool behavior is unchanged from `0.2.60`.

## 0.2.60 — 2026-09-20

- Lockstep canonical-branding release with the ReMCP client at `0.2.60`; runtime tool behavior is unchanged from `0.2.59`.

## 0.2.59 — 2026-09-20

- Tool descriptions now make routing boundaries explicit across overlapping filesystem, search, process, system, desktop, diagnostics, and document operations so AI hosts prefer the narrowest semantic tool instead of broad shell or fallback tools.
- Wayland absolute pointer delivery uses the EIS helper path and avoids stale cached-position assumptions when falling back, improving deterministic desktop input on GNOME/Wayland.
- Lockstep patch release with the ReMCP client at `0.2.59`.

## 0.2.58 — 2026-09-20

- `computer_snapshot` normalizes partial platform-capture failures into schema-stable collections/objects and bounded `{ source, message }` errors instead of leaking error strings into structured output.
- Output-budget pruning preserves the structured snapshot error contract, and browser snapshot fallbacks reject invalid/error-shaped payloads.
- Dynamic browser/CDP capability groups now toggle registrations in one batch and emit one `tools/list_changed` notification per transition, preventing concurrent stdio notification writes from exceeding Node's listener limit.
- Lockstep patch release with the ReMCP client at `0.2.58`.

## 0.2.57 — 2026-09-20

- ZIP extraction recognizes Info-ZIP `unzip` on Debian/Ubuntu by probing it with `-v`, fixing the false “unzip is not installed” error reproduced during physical 76-tool package verification.
- Lockstep patch release with the ReMCP client at `0.2.57`.

## 0.2.56 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.56`; the runtime tool implementation is unchanged from `0.2.55`.

## 0.2.55 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.55`; the runtime tool implementation is unchanged from `0.2.54`.

## 0.2.54 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.54`; the runtime tool implementation is unchanged from `0.2.53`.

## 0.2.53 — 2026-09-20

- Lockstep patch release with the ReMCP client at `0.2.53`; the runtime tool implementation is unchanged from `0.2.52`.

## 0.2.52 — 2026-09-20

- `computer_snapshot.active_window` is nullable when native accessibility state cannot be matched to the platform's top-level window enumeration, preventing valid macOS snapshots from failing structured output validation.
- Lockstep patch release with the ReMCP client at `0.2.52`.

## 0.2.51 — 2026-09-20

- Linux AT-SPI text/focus operations reject explicit false results, `type_text method=accessibility` remains accessibility-only, and semantic browser text failures direct callers to `browser_action` rather than reporting an unverified paste as success.
- GNOME Wayland drag requires the consent-backed Remote Desktop portal instead of unreliable XTEST/xdotool delivery.
- PDF `read_document` falls back from the built-in parser to local `pdftotext` when embedded fonts prevent direct decoding, while preserving the existing no-text error when neither path extracts content.
- Lockstep patch release with the ReMCP client at `0.2.51`.

## 0.2.50 — 2026-09-20

- Lockstep release with the ReMCP client after the hosted MCP/plugin contract was hardened for current OpenAI/MCP Apps requirements.
- Computer-use tools retain the 83-tool runtime surface with AI-oriented descriptions, conditional JSON Schema validation, structured outputs, dynamic capability advertising, and semantic Accessibility/DOM-first routing.
- `browser_navigate` adds `action=new_tab` so CDP automation can create the first page target without a shell/browser-address-bar workaround.
- Live Linux verification covers Tesseract OCR targeting, XDG RemoteDesktop keyboard/pointer input, Unicode `type_text`, and the complete 39-tool computer-use smoke.

## 0.2.49 — 2026-09-20

- Terminal process tools now return schema-validated structured session state, output ranges, match results and termination facts alongside their human-readable text.
- The runtime catalog and hosted tool contract align on bounded structured outputs and accurate read-only/destructive/idempotent/open-world annotations for the expanded computer-use surface.
- Preview references remain optional presentation metadata rather than replacing the source result used for model reasoning.
- Lockstep patch release with the ReMCP client at `0.2.49`.

## 0.2.48 — 2026-09-20

- Migrate the local stdio runtime to the official `@modelcontextprotocol/server` v2 serving entry while preserving legacy 2025-era client compatibility.
- Add negotiated MCP `2026-07-28` support, including `server/discover`, cache hints, full structured output validation, and subscription-based `notifications/tools/list_changed` delivery.
- Keep the legacy `@modelcontextprotocol/sdk` and modern `@modelcontextprotocol/client` packages dev-only so CI continuously proves both protocol eras against the same runtime.
- Add optional Tesseract-backed OCR inside `computer_snapshot`/`computer_action`, including bounded word/line boxes and HiDPI/multi-monitor coordinate mapping, without adding another MCP tool or production dependency.
- Added 39 computer-use tools: native desktop/window automation, accessibility UI inspection/actions, browser CDP, diagnostics, and lightweight DOCX/XLSX/PDF operations.
- Live `tools/list` now advertises only capabilities available on the current operating system and sends `notifications/tools/list_changed` when the capability set changes; `--print-tools` remains the stable full 83-tool release contract.
- Added high-level `computer_snapshot` and `computer_action` primitives so agents can prefer semantic Accessibility/DOM targets and fall back to coordinates/screenshots only when necessary.
- Chrome DevTools Protocol endpoints are restricted to loopback addresses. New filesystem/document operations continue through the existing resolved-path allowlist, and launch/service/power operations reuse the runtime command policy.
- Fixed metadata output truncation once the JSON tool contract exceeded the operating-system pipe buffer by waiting for stdout writes to flush before exit.
- Terminal session tools now expose schema-validated structured `pid`, status, exit information, output ranges/matches, and session lists alongside their human-readable text, so hosted agents can chain process calls without parsing prose.
- Tool descriptions now state the intended routing boundary for exact-path vs glob reads, singular vs batch filesystem operations, full-screen vs targeted/semantic screenshots, and local runtime settings vs hosted device labels.
- Desktop action schemas and common guards now reject targetless `ui_action`/`window_action`, coordinate-less pointer moves, zero-motion scrolls, incomplete cross-backend `computer_action` targets, and connectivity tests without host/port before platform adapters can act. Empty `ui_find`/`browser_find` calls are redirected to their snapshot tools, and `wait_for_ui` requires an explicit state/condition instead of silently acting as a no-op.
- `take_screenshot` is correctly advertised as non-read-only/non-idempotent because kept or oversized captures can persist timestamped files; selector-scoped `browser_snapshot` screenshots restore the original page scroll position before returning so the inspection path remains read-only.
- No browser/document rendering stack was added; the runtime remains dependency-light and uses native OS facilities plus existing qpdf/poppler/zip helpers when available.

## 0.2.47 — 2026-09-19

- Lockstep release with the ReMCP client. Runtime behavior is unchanged from 0.2.46; the client now recovers from transient HTTP handshake failures and migrates Linux systemd services to a stable launcher independent of nvm/Hermes prefixes.

## 0.2.46 — 2026-09-19

- Lockstep release with the ReMCP client. Runtime behavior is unchanged from 0.2.45; the client makes all macOS service restarts use a detached launchd handoff so commands initiated from inside the agent cannot terminate their own updater or settings operation.

## 0.2.45 — 2026-09-19

- Lockstep hotfix with the ReMCP client. Runtime behavior is unchanged from 0.2.44; the paired release fixes macOS self-update handoff so a client update launched from inside ReMCP cannot kill its own repair process.

## 0.2.44 — 2026-09-19

- Lockstep compatibility release with the ReMCP client. Runtime behavior is unchanged from 0.2.43; the pair stays on one immutable version while the client adds versioned config migrations and cross-platform background-service recovery for legacy installations.

## 0.2.43 — 2026-09-19

- Lockstep patch release with the ReMCP client. Runtime behavior is unchanged from 0.2.42; the release keeps client and runtime on the same immutable version while the client fixes automatic reconnect after a temporary device pause.

## 0.2.36 — 2026-09-18

- Documentation and runtime introspection now describe the current 44-tool local surface instead of
  older 35/43-tool snapshots.
- `get_runtime_info` explicitly distinguishes its read-only report from the four preferences that
  `set_config_value` may change. Access roots, blocked commands, the command guardrail, shell,
  write limit, runtime name and unrestricted mode remain local to the computer.
- Package/review documentation now matches the published runtime dependencies and the current
  trusted-publishing release flow.

## 0.2.34 — 2026-09-18

- Lockstep security release with the ReMCP client. Runtime behavior is unchanged from 0.2.33.

## 0.2.33

- Linux Wayland screenshots now use the standard XDG Desktop Portal before compositor-specific
  command-line fallbacks. The runtime subscribes to the portal response before requesting the
  capture, handles fast and legacy request handles without losing the signal, respects an explicit
  cancellation, and cleans the portal-created intermediate PNG after copying it.

## 0.2.30

- **Unrestricted mode.** `REMCP_RUNTIME_UNRESTRICTED=1` (or `"unrestricted": true` in `runtime.json`,
  or `remcp godmode on`) lifts the access roots, the configured command blocklist and the
  catastrophic-command guardrail for this computer. It is not settable through MCP: `set_config_value`
  still accepts only the four preferences it lists, so a model cannot widen its own reach.
  `get_runtime_info` reports `policy.unrestricted` and says how to turn it off. Size limits
  (`maxWriteBytes`, `maxOutputBytes`, line limits) are unchanged, and commands still run as the user
  the agent runs as.

## 0.2.29

- Screenshot failures on GNOME Wayland name the tool that works (`gnome-screenshot`); previously the
  message suggested `grim`, which cannot read a GNOME session at all.

## 0.2.26

- Screenshot failures explain the platform's own gate: Screen Recording on macOS, an interactive
  session on Windows, `grim`/`gnome-screenshot` on Wayland, and "no graphical session" on a server.
- A PNG above the inline limit is saved on the computer and the result says how to fetch it in
  chunks, instead of failing the call.

## 0.2.25

- `EACCES`/`EPERM`/`EROFS`/`ENOSPC`/`EBUSY` from the file system are explained instead of printed
  raw: macOS privacy folders (Full Disk Access for the exact `node` binary), Windows Controlled
  folder access, Linux ownership, read-only mounts and full disks. Every filesystem failure in the
  runtime goes through it.

## 0.2.20

- `set_config_value`: a model may change this runtime’s own preferences (telemetry opt-out, read
  and buffer line limits, result size) while it is running; the change applies immediately and is
  saved to runtime.json. Access roots, blocked commands, the command guardrail, the shell and the
  write limit stay with the person at this computer and are refused by the tool.

## 0.2.16

- Mark cursor-consuming `read_process_output` as non-idempotent so clients do not assume retries
  replay the same output.

## 0.2.11

- Version lockstep with the client.


## 0.2.10

Tool-call reliability fixes found by the second audit round.

- `apply_patch` accepts `diff -u` headers that carry a tab and timestamp (the timestamp is not part
  of the file path), treats a blank line inside a hunk as an empty context line instead of dropping
  it, and drops trailing empty context lines the diff's own line counts say are not part of the hunk.
- The output budget now bounds the serialised frame, not the raw bytes: a control character becomes
  six bytes once JSON-escaped, so an ANSI-heavy result used to pass the check and still exceed the
  transport limit, closing the connection mid-call.
- `read_file`, `read_binary`, `read_image` and `hash_file` refuse anything that is not a regular
  file, so a FIFO cannot hang a call and a device node cannot flood it.
- Tree walks report the directories they could not read instead of silently returning a partial
  result, `read_files` reports the real number of matches, `set_permissions` reports per-path
  failures instead of stopping at the first one, and a glob character class with an invalid range
  falls back to a literal match instead of throwing out of the tool.

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
