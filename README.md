# reusable-workflows

[![Test](https://github.com/WillBooster/reusable-workflows/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/reusable-workflows/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/test-rust.yml)
[![Deploy](https://github.com/WillBooster/reusable-workflows/actions/workflows/deploy.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/deploy.yml)

A collection of reusable workflows for GitHub Actions.

## Secrets contract for callers

The six install-capable workflows (`test.yml`, `deploy.yml`, `release.yml`, `run-script.yml`, `gen-pr.yml`, `autofix.yml`) declare these optional secrets:

- `VERDACCIO_TOKEN`: auth token for the private Verdaccio registry (`@willbooster-private/*`). When set, the workflow generates a git-excluded workspace `.npmrc` before installing dependencies. Every caller should pass it.
- `FNOX_AGE_KEY`: age secret key that decrypts the age-encrypted secrets committed in the caller's `fnox.toml`. Required for repositories whose `fnox.toml` contains age-encrypted secrets; after mise installs fnox, `deploy.yml`, `release.yml`, `run-script.yml`, and `gen-pr.yml` fail fast when the committed secrets cannot be resolved (missing or wrong key), while `test.yml` and `autofix.yml` only warn (fork pull requests run `test.yml` without secrets, and autofix's cleanup/build steps do not need app secrets). A `fnox.toml` with only plaintext defaults needs no key and passes the checks.

Do NOT pass either secret explicitly to the other workflows (e.g. `semantic-pr.yml`, `close-comment.yml`): GitHub rejects a `secrets:` map entry the callee does not declare (`secrets: inherit` is exempt from this validation). Running `wbfy` built from WillBooster/shared `main` on the caller repository injects both automatically (the released `@willbooster/wbfy` 2.1.0 injects only `FNOX_AGE_KEY`; pass `VERDACCIO_TOKEN` manually until a newer release ships).

Note: this repository is mirrored to `WillBoosterLab/reusable-workflows` with `one-way-git-sync` via the `sync` script, which maintainers run from their machines (`bun run sync`; `renovate.json` and `node_modules` are excluded). The mirror is not synced automatically on merge, so it can lag `main` — run `bun run sync` after merging changes that WillBoosterLab callers need.
