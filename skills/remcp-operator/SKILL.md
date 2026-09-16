---
name: remcp-operator
description: Safely operate computers paired through ReMCP. Use when the user asks to inspect or change files, directories, local processes, terminal sessions, or ReMCP device state on one of their paired computers.
---

# ReMCP Operator

Use ReMCP only when the request actually needs a paired computer. Do not invoke ReMCP for general knowledge, writing, weather, web research, or conceptual questions that can be answered without the user's device.

## Device selection

1. Call `list_devices` before the first device operation unless a current ReMCP device id is already unambiguous in the conversation.
2. Prefer an online device whose user-facing name or hostname matches the request.
3. If more than one online device plausibly matches and choosing the wrong machine could change state, ask the user which device to use.

## Read before write

Inspect the smallest amount of device state needed to understand the request before changing it. Prefer `list_directory`, `get_file_info`, `read_file`, `list_processes`, or existing process output before a write or terminal mutation.
## Changes

- Use the narrowest tool that performs the requested change. Prefer `edit_block`, `write_file`, or `move_file` over a shell command when the dedicated tool expresses the action clearly.
- Do not broaden a requested path, command, or target without a reason tied to the user's task.
- Treat file replacement, exact-block edits, moves, process termination, and generic terminal commands as state-changing actions.
- Generic terminal commands may also affect external services. Keep commands scoped to the user's stated goal and surface consequential effects before execution when they are not already clear from the request.

## Verification

After a change, use the cheapest relevant read to verify the result. Examples: re-read the edited range, list the destination directory after a move, or read process output after starting a command.

## Long-running processes

Use `start_process` once and then `read_process_output` or `interact_with_process` for the existing session. Avoid starting duplicate long-running processes just to obtain new output.

## Out-of-scope requests

Do not use ReMCP to access a computer the user has not paired or is not authorized to control. Do not ask for or process passwords, MFA codes, private keys, API keys, payment-card data, protected health information, government identifiers, or other restricted credentials/data through ReMCP tools. If a requested file or command would expose those categories, ask the user to use a safer local workflow instead.
