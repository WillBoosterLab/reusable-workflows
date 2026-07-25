# reusable-workflows

[![Test](https://github.com/WillBooster/reusable-workflows/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/reusable-workflows/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/test-rust.yml)
[![Deploy](https://github.com/WillBooster/reusable-workflows/actions/workflows/deploy.yml/badge.svg)](https://github.com/WillBooster/reusable-workflows/actions/workflows/deploy.yml)

A collection of reusable workflows for GitHub Actions.

## Secrets contract for callers

The five install-capable workflows (`test.yml`, `deploy.yml`, `release.yml`, `run-script.yml`, `autofix.yml`) declare these optional secrets:

- `VERDACCIO_TOKEN`: auth token for the private Verdaccio registry (`@willbooster-private/*`). When set, the workflow generates a git-excluded workspace `.npmrc` before installing dependencies. Every caller should pass it. The generated `.npmrc` stays on disk for the whole job, but the secret itself is step-scoped: `${VERDACCIO_TOKEN}` only expands in the "Install dependencies" step of all five workflows, plus `common/ci-setup` and "Deploy" in `deploy.yml`, `common/ci-setup` and "Run script" in `run-script.yml`, "Release" in `release.yml`, and "Test release script" in `test.yml`. Consumer scripts running on any other step (e.g. `test/ci-setup`, `cleanup`, `build`, tests) see an empty `VERDACCIO_TOKEN` and must rely on the already-installed dependency graph instead of fetching from the private registry at run time.
- `TAKUMI_GUARD_TOKEN`: auth token for the [Takumi Guard](https://flatt.tech/takumi/features/guard) registry proxy, which blocks known-malicious packages. When set, newly resolved public (default-registry) packages go through `https://npm.flatt.tech/`; `@willbooster-private/*` packages keep resolving from Verdaccio with `VERDACCIO_TOKEN`. The token follows the same step-scoping as `VERDACCIO_TOKEN`. Coverage: for bun, an EMPTY `resolved` field does not bypass the proxy — bun derives the download URL from the configured registry, so already-locked packages go through Guard too. A non-empty `resolved` is what bypasses it, and Yarn 1 always records one; Yarn Berry ignores `.npmrc`, so Guard does not apply to Berry installs at all. Note the side effect for bun consumers: an install that UPDATES `bun.lock` under the Guard `.npmrc` makes bun rewrite every already-locked package's `resolved` to the proxy host, so `test.yml` and `autofix.yml` normalize those URLs back to `""` before their autofix commit — otherwise the committed lockfile would pin every environment to the proxy and fail cold-cache installs with 401 for anyone holding a `registry.npmjs.org` token. That normalization runs before the patch is collected, so it travels with the other autofix changes (see “Applying autofix commits”); `autofix.yml` still commits and pushes it directly. Publishing repositories must declare `publishConfig.registry` explicitly (npmjs for public packages — wbfy injects it; Verdaccio publishers already declare theirs): without it, `npm publish` resolves the Guard proxy from the generated `.npmrc` and fails with 405.
- `FNOX_AGE_KEY`: age secret key that decrypts the age-encrypted secrets committed in the caller's `fnox.toml`. Required for repositories whose `fnox.toml` contains age-encrypted secrets; after mise installs fnox, `deploy.yml`, `release.yml`, and `run-script.yml` fail fast when the committed secrets cannot be resolved (missing or wrong key), while `test.yml` and `autofix.yml` only warn (fork pull requests run `test.yml` without secrets, and autofix's cleanup/build steps do not need app secrets). A `fnox.toml` with only plaintext defaults needs no key, but a non-development job must still declare the selected profile (an inline `[profiles.<name>]` or a `fnox.<name>.toml` file) — an undeclared profile silently falls back to the base (development) secrets, so the check rejects it.

Do NOT pass these secrets explicitly to the other workflows (e.g. `semantic-pr.yml`, `close-comment.yml`): GitHub rejects a `secrets:` map entry the callee does not declare (`secrets: inherit` is exempt from this validation). Running `wbfy` (>= 3.0.0) on the caller repository injects `VERDACCIO_TOKEN`/`FNOX_AGE_KEY` automatically.

`wbfy.yml` applies wbfy to the calling repository itself on a schedule and force-pushes the result to its `wbfy` branch (wbfy generates the caller workflow; repositories where wbfy does not work are excluded by wbfy's deny list). By default it needs NO extra credential: the push uses `GITHUB_TOKEN` (caller grants `contents: write` plus `actions: write` for the `test.yml` dispatch after the push, since a `GITHUB_TOKEN` push triggers no workflows). GitHub forbids `GITHUB_TOKEN` from writing files under `.github/workflows/` through every path (git push, contents API, GraphQL; no `workflows` key is supported in the workflow `permissions` block), so workflow-file changes are skipped with a warning — they are distributed through local wbfy runs instead. It runs two jobs: the wbfy job executes dependency code and therefore only holds a read-only job token, handing its result to the push job as a patch artifact; the push job runs only trusted code on an ephemeral GitHub-hosted runner and is the sole holder of the write token.

Migration prerequisite for the no-PAT path: the caller's default-branch `test.yml` must declare `workflow_dispatch` (current wbfy generates it) — without it the post-push dispatch fails with a warning and downstream wbfy-merge falls back from direct-merging to opening a PR; update `test.yml` once via a local wbfy run.

(The declared `WBFY_GH_TOKEN` secret is retired and ignored; the declaration remains only until every generated caller stops passing it, because GitHub rejects callers passing undeclared secrets.)

## Applying autofix commits

`test.yml` no longer pushes the fixes itself. Its test job runs the pull request's own dependencies, so its checkout no longer persists a push credential (`persist-credentials: false`); instead it uploads the fixers' output as an `autofix-patch` artifact and fails with the diff. A separate caller workflow, triggered by `workflow_run`, commits that patch as a GitHub App:

```yaml
name: Apply autofix
on:
  workflow_run:
    workflows: [Test]
    types: [completed]
jobs:
  apply:
    # A called workflow can only REDUCE the caller's token, never elevate it, so the grant has to
    # be here: without actions:read the job cannot list or download the triggering run's artifact.
    permissions:
      actions: read
      contents: read
    uses: WillBooster/reusable-workflows/.github/workflows/autofix-apply.yml@main
    secrets:
      AUTOFIX_APP_PRIVATE_KEY: ${{ secrets.AUTOFIX_APP_PRIVATE_KEY }}
```

- `AUTOFIX_APP_PRIVATE_KEY` is the only thing a caller configures. The App ID is a constant inside `autofix-apply.yml` — it is a public identifier, useless without the key, and one Autofixer App serves every organization, so there is no input to override. An organization wanting its own App needs a change to that workflow.
- An App push re-triggers `pull_request` **and** `pull_request_target`, so every required check — including `pull_request_target` ones such as `semantic-pr` — populates on the fixed commit. This is why the old `workflow_dispatch` workaround is gone.
- Without this caller workflow the test job simply fails with the diff, which is the fail-closed fallback.
- Fork pull requests are excluded: `workflow_run` carries the base repository's secrets, and the App cannot push to a fork's branch.
- Only self-hosted runs currently produce a patch. Hosted runs check out the pull-request merge ref, where the fixed contents would not correspond to the head commit, so the collector declines with a warning.
- The collector refuses changes under `.github/**`, and produces no patch (a warning, so the job still fails with the diff) when any changed entry is not a plain `100644` file, because the commit API expresses file contents only. Note this also covers a content-only edit to an already-executable file: `git diff --raw` reports its destination mode as `100755`, and whether the commit API preserves an existing path's mode is undocumented.
- This removes the *push* credential from the test job, not every credential: the caller's `GH_TOKEN` is still provided, step-scoped, to the steps that run the consumer's `test`/`release-test` scripts. Narrowing that is a separate change to the caller contract.

The `test.yml` caller's permissions are unchanged. `test.yml` no longer pushes or dispatches, but both grants are still needed for other reasons, so do NOT drop them:

- `contents: write` — the "Test release script" step runs `semantic-release --dry-run`, which performs a `git push --dry-run` to verify write access and aborts with `EGITNOPERMISSION` without it, even in a dry run. Callers such as `prompt-study`, `build-ts` and `agentic-workflows` reach that step.
- `actions: write` — the test job runs `fkirc/skip-duplicate-actions` with `cancel_others: true`, which calls `cancelWorkflowRun`. Dropping the grant also loses the implied `actions: read`, so duplicate/`paths_ignore` skipping silently stops working too.
- `statuses: write` — used by the aggregate status job.

`autofix.yml` (public repositories) and `wbfy.yml` keep their own mechanisms: they push with `GITHUB_TOKEN` and, because such a push triggers no workflows, dispatch the caller's `.github/workflows/test.yml` afterwards. Callers of those two still need a `workflow_dispatch:` trigger in `test.yml` plus `contents: write`, `actions: write` and `statuses: write`; without them the push fails or the dispatch/status steps degrade to warnings.

Source checkouts use the automatically provided `GITHUB_TOKEN` (no secret needs to be passed, and self-hosted runners need no SSH deploy key). Exception: `sync.yml` pushes to the caller-supplied `DEST_GIT_URL` secret, so an SSH-form value there still needs runner SSH credentials until it is migrated to an HTTPS token URL.

Note: this repository is mirrored to `WillBoosterLab/reusable-workflows` with `one-way-git-sync` via the `sync` script, which maintainers run from their machines (`bun run sync`; `renovate.json` and `node_modules` are excluded). The mirror is not synced automatically on merge, so it can lag `main` — run `bun run sync` after merging changes that WillBoosterLab callers need.
