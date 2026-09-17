# Chunked transfer loop

`read_binary` takes `offset_bytes` and `length_bytes`. `write_binary` takes base64 `data`
and `mode` (`rewrite` or `append`); it cannot write at an arbitrary offset.

## Recommended sizes

| Situation | `length_bytes` |
| --- | --- |
| Default, leaves room for base64 overhead | `65536` (64 KiB) |
| Host supports larger tool results | `262144` (256 KiB) |
| Maximum accepted read | `1048576` (1 MiB) |

## Loop

1. Resolve both device ids. Inspect source and destination with `get_file_info`; establish
   whether replacing the destination is authorized. Record source size and SHA-256.
2. Read the first chunk (replace the example ids and paths):

```json
{"tool":"read_binary","arguments":{"device":"source-device","path":"/source/file.bin","offset_bytes":0,"length_bytes":65536}}
```

3. Parse the JSON text result and write its exact base64 `data` to the destination:

```json
{"tool":"write_binary","arguments":{"device":"destination-device","path":"/destination/file.bin","data":"AAEC","mode":"rewrite"}}
```

`AAEC` is illustrative only; replace it with the returned data. For an empty file, write
`data: ""` once in rewrite mode.

4. After a successful write, stop if the read returned `complete: true`. Otherwise read from
   `offset_bytes: nextOffsetBytes` and write with `mode: "append"`. Never advance by a guessed
   chunk size or send offset/encoding parameters to the writer.
5. Compare destination size and SHA-256 with the source, and hash the source again to detect
   changes during copying. Report success only when all sizes and digests agree.

## Failure handling

- A truncated read can be retried at the same offset with a smaller `length_bytes` before writing.
- Never blindly retry an append after a timeout: it may already have written bytes. Check the
  destination size and read back the affected bytes before continuing. Restart from byte zero
  within the user's overwrite authorization if the result is uncertain.
- If a digest differs or the source changed, report an incomplete transfer and preserve the source.
- A move means copy, verify, then remove the source only when removal was explicitly requested.
- If context or tool limits cannot carry the payload intact, stop and explain the limit instead
  of inventing bytes or claiming success. Leave and report any temporary archive paths.
