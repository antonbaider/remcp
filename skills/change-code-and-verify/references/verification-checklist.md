# Verification checklist

Use this when the repository does not advertise a test command.

## Find the command

| File | What to look for |
| --- | --- |
| `package.json` | `scripts.test`, `scripts.build`, `scripts.lint`, `scripts.typecheck` |
| `Makefile` | `test`, `check`, `lint`, `build` targets |
| `pyproject.toml` / `tox.ini` | `[tool.pytest]`, `pytest`, `ruff`, `mypy` |
| `Cargo.toml` | `cargo test`, `cargo clippy` |
| `go.mod` | `go test ./...`, `go vet ./...` |
| `.github/workflows/*.yml` | the commands CI actually runs |
| `docker-compose*.yml` | services that must be up before the command works |

## Order of preference

1. The project's own test command.
2. A type check or lint pass for the language.
3. A build or a `--dry-run` invocation of the changed entry point.
4. A minimal, explicit invocation of the changed function or script with sample input.

## Rules

- Run the narrowest check that covers the change first, then the full suite if it is fast enough.
- Quote the command in the final answer, not a paraphrase of it.
- A skipped or unavailable check is a result too: report it as "not run" with the reason.
- Never claim a check passed without the output that shows it.
