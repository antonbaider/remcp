---
name: transfer-files-between-machines
description: Use when the user wants a file or a directory copied from one paired computer to another, moved between machines, or backed up from a laptop to a server through ReMCP.
---

# Transfer files between machines

ReMCP has no direct machine-to-machine copy: the bytes travel through this conversation, so size
matters. Follow the size first, then choose the path.

1. `list_devices` and pick the source and the destination. Both must belong to the signed-in
   account; if the destination is offline, stop and say so.
2. Size the payload: `get_file_info` on the source path. For a directory, inspect its entries,
   create an archive, then inspect the archive size; directory metadata is not a total byte count.
3. Choose the method:
   - **Small file (a few hundred kilobytes):** `read_binary` on the source, then `write_binary` on
     the destination with the returned base64 `data` and `mode: "rewrite"`.
   - **Large file:** `read_binary` with `offset_bytes` and `length_bytes`; write the returned
     `data` using `mode: "rewrite"` for the first chunk and `mode: "append"` thereafter.
     Set the next read's `offset_bytes` to `nextOffsetBytes` until `complete` is true.
     `write_binary` has no offset or encoding parameter. Never truncate a chunk silently.
   - **Directory or many files:** `create_archive` (tar.gz or zip) on the source, transfer the
     archive, then `extract_archive` on the destination.
4. Verify with `hash_file` on both machines and compare the digests. Report both digests; a
   transfer is not finished until they match.
5. Clean up only what the user asked you to remove. If you created a temporary archive, say where
   it is instead of deleting it silently.
6. Never transfer secrets, private keys, credential stores or browser profiles; if the user asks
   for one, explain that ReMCP does not move credentials and suggest a secret manager instead.

Pass the source `device` id on reads and the destination `device` id on writes. Ask before an
overwrite unless the user already authorized that exact destination. Do not blindly retry an
append after a timeout: the write may already have completed, and a retry would duplicate bytes.

See [chunked transfer loop](references/chunking.md) for sizes, examples, and recovery.
