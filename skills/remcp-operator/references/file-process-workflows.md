# File and process workflows

Load this reference when the task primarily edits files, transfers data, runs commands, manages long-running processes, or diagnoses the ReMCP runtime.

## Read before write

Choose the narrowest read that answers the question:

- `read_file` with `offset`/`length` for large text files. Its normal text/structured result is the complete default path; do not look for a custom renderer.
- `read_image`, `take_screenshot`, and `screenshot_region` return native MCP image content for model vision and host presentation. Do not follow them with `read_binary` or another tool just to display the image.
- Process tools return model-readable terminal text/structured state directly. Continue the same PID with `read_process_output` or `wait_for_process_output`; never rerun a command merely to obtain another visual result.
- If and only if this server actually advertises one of the optional `render_*` tools, its source result includes `structuredContent.preview`, and the user explicitly benefits from custom interactive UI, the renderer may consume that preview id. This is an opt-in MCP Apps path, not the default workflow.
- `read_multiple_files` for two or more exact paths you already know; use `read_file` for one path.
- `read_files` only when the files should be discovered by one glob; do not use it for an explicit path list.
- `list_directory` with `depth`/`pattern` instead of shell `find`/`ls`.
- `start_search` for name/content search; page with `get_more_search_results` and stop long searches with `stop_search`.
- `read_image` for images already on the device.
- `hash_file` to prove identity without transferring content.
- `diff_files` to verify text changes.

## Editing

Use the narrowest editor:

- `apply_patch` for a prepared unified diff spanning one or more files; use `dry_run:true` for a preview when needed.
- `edit_block` for one exact block.
- `replace_lines` for a known line range.
- `replace_in_files` for one literal/regex change across many files.
- `write_file` for one complete replacement/creation; `write_files` for two or more independent files.
- `copy_file` for one regular file; `copy_paths` for directories or multiple copies.
- `move_file` for one source/destination pair; `move_paths` for two or more moves.
- `delete_path` for one target; `delete_paths` for two or more; prefer `move_to_trash` when reversibility matters.
- `set_permissions` for mode/ownership changes.

Do not choose a batch tool for one item just because it can technically represent it. Batch independent operations only when there are genuinely multiple targets.

## Transfers and archives

- Off-device text: `read_file`/`read_files`.
- Off-device bytes: `read_binary` in chunks until `complete`.
- Onto-device text: `write_file`/`write_files`.
- Onto-device bytes: `write_binary`; use append mode for chunks.
- Trees: `create_archive` before transfer and `extract_archive` after.
- Verify transfer integrity with `hash_file`.

## Long-running processes

Call `start_process` once. Continue that same session with `read_process_output`, `wait_for_process_output`, or `interact_with_process`. Use `wait_for_process_output` for readiness/failure text instead of polling. Do not start duplicate processes just to obtain fresh output.

Use `force_terminate`/`kill_process` only when stopping the running task is part of the request.

## Runtime troubleshooting

- `get_runtime_info`: runtime version, roots, command policy, limits, and settable preferences.
- `get_runtime_stats`: session counters/failures.
- `set_config_value`: only supported runtime preferences; access roots and command guardrails remain local to the device.
- If runtime reports a restart, wait briefly and retry once rather than looping.

## Verification examples

- File edit: re-read the changed range or use `diff_files`.
- Copy/transfer: `hash_file`.
- Permission change: `get_file_info`.
- Move: list the destination.
- Build/test: read the final process exit/output.
- Large multi-file refactor: run the project's own check/build/test once after the coherent change rather than re-reading every file.
