# reusable-workflows

[![Test](https://github.com/WillBooster/reusable-workflows/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/reusable-workflows/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/test-rust.yml)
[![Deploy](https://github.com/WillBooster/reusable-workflows/actions/workflows/deploy.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/deploy.yml)

A collection of reusable workflows for GitHub Actions.

## Secrets contract for callers

The five install-capable workflows (`test.yml`, `deploy.yml`, `release.yml`, `run-script.yml`, `autofix.yml`) declare these optional secrets:

- `VERDACCIO_TOKEN`: auth token for the private Verdaccio registry (`@willbooster-private/*`). When set, the workflow generates a git-excluded workspace `.npmrc` before installing dependencies. Every caller should pass it. The generated `.npmrc` stays on disk for the whole job, but the secret itself is step-scoped: `${VERDACCIO_TOKEN}` only expands in the "Install dependencies" step of all five workflows, plus `common/ci-setup` and "Deploy" in `deploy.yml`, `common/ci-setup` and "Run script" in `run-script.yml`, "Release" in `release.yml`, and "Test release script" in `test.yml`. Consumer scripts running on any other step (e.g. `test/ci-setup`, `cleanup`, `build`, tests) see an empty `VERDACCIO_TOKEN` and must rely on the already-installed dependency graph instead of fetching from the private registry at run time.
- `FNOX_AGE_KEY`: age secret key that decrypts the age-encrypted secrets committed in the caller's `fnox.toml`. Required for repositories whose `fnox.toml` contains age-encrypted secrets; after mise installs fnox, `deploy.yml`, `release.yml`, and `run-script.yml` fail fast when the committed secrets cannot be resolved (missing or wrong key), while `test.yml` and `autofix.yml` only warn (fork pull requests run `test.yml` without secrets, and autofix's cleanup/build steps do not need app secrets). A `fnox.toml` with only plaintext defaults needs no key, but a non-development job must still declare the selected profile (an inline `[profiles.<name>]` or a `fnox.<name>.toml` file) — an undeclared profile silently falls back to the base (development) secrets, so the check rejects it.

Do NOT pass either secret explicitly to the other workflows (e.g. `semantic-pr.yml`, `close-comment.yml`): GitHub rejects a `secrets:` map entry the callee does not declare (`secrets: inherit` is exempt from this validation). Running `wbfy` (>= 3.0.0) on the caller repository injects both automatically.

Note: this repository is mirrored to `WillBoosterLab/reusable-workflows` with `one-way-git-sync` via the `sync` script, which maintainers run from their machines (`bun run sync`; `renovate.json` and `node_modules` are excluded). The mirror is not synced automatically on merge, so it can lag `main` — run `bun run sync` after merging changes that WillBoosterLab callers need.
