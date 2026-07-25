// Snapshots the working-tree changes produced by the repository's fixers into ONE JSON file.
//
// A single well-known filename is deliberate: the applier downloads this artifact, and if the
// archive itself carried the fixers' paths, extraction would be the point where an attacker-chosen
// path takes effect. Keeping every attacker-controlled path INSIDE the JSON makes them mere data
// that the applier validates before use.
//
// Contents come from the git INDEX, not the working tree. Reading the working tree would discard
// whatever .gitattributes does on staging — end-of-line normalization, clean filters, LFS pointer
// substitution — so the committed bytes would differ from what `git commit` would have produced.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The only mode createCommitOnBranch can express: its FileAddition input carries `path` and
// `contents` and nothing else (verified against the live GraphQL schema), so an executable bit
// (100755), a symlink (120000) or a gitlink (160000) would be silently downgraded to a plain file.
// Refuse instead — a visibly unsupported change beats a subtly corrupted commit.
const RegularFileMode = '100644';
const DeletedMode = '000000';
// The applier enforces the same envelope on the untrusted artifact it receives. Checking it here
// too is what keeps the two consistent: without it a large-but-legitimate autofix would upload
// fine and then be rejected in a different workflow run, where nobody is looking at the diff.
const MaxFileCount = 2000;
const MaxTotalBytes = 25 * 1024 * 1024;

const {
  EXCLUDE_PATHS: excludePaths = '',
  EXPECTED_HEAD_SHA: expectedHeadSha,
  RUNNER_TEMP: runnerTemp,
  GITHUB_OUTPUT: githubOutput,
} = process.env;

function git(args, encoding = 'utf8', stdio = undefined) {
  return execFileSync('git', args, { encoding, maxBuffer: 512 * 1024 * 1024, stdio });
}

function setOutput(key, value) {
  appendFileSync(githubOutput, `${key}=${value}\n`);
}

// The patch is committed onto the pull request head, so it is only valid if the fixers ran against
// that exact tree. Hosted runs check out the merge ref instead, where the resulting contents would
// silently include the base branch's state; refuse rather than commit a subtly wrong file.
const headSha = git(['rev-parse', 'HEAD']).trim();
if (expectedHeadSha && headSha !== expectedHeadSha) {
  console.log(
    `::warning::Working tree is at ${headSha}, not the pull request head ${expectedHeadSha}, so no autofix patch was produced.`
  );
  setOutput('has_patch', 'false');
  process.exit(0);
}

// Excluded paths (the dotenv file a DOT_ENV secret overwrote) must never be hashed in the first
// place: staging one writes a blob holding the plaintext secret into .git/objects, where it stays
// recoverable on a persistent self-hosted workspace even after the index entry is dropped.
const excluded = excludePaths
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const pathspecs = ['.', ...excluded.map((file) => `:(exclude)${file}`)];
for (const file of excluded) {
  // Drop anything a consumer script staged before this action ran. stderr is discarded because
  // the common case — an untracked dotenv — makes git print a fatal-looking "pathspec ... did not
  // match any file(s)" line that this catch already handles, and a spurious `error:` is worst
  // exactly here, in the step responsible for keeping a secret out of the patch.
  try {
    git(['restore', '--staged', '--', file], 'utf8', ['ignore', 'pipe', 'ignore']);
  } catch {
    // Not staged, or not tracked at all; nothing to unstage.
  }
}
git(['add', '--all', '--', ...pathspecs]);

// --raw exposes the index-side mode and blob id, which the mode check and the content read below
// both need. -z keeps paths verbatim: git otherwise quotes unusual names, and any line-based
// parsing would corrupt a path holding a newline or a trailing space. --no-abbrev because --raw
// otherwise emits a short OID whose length is only a probabilistic uniqueness estimate, so
// `git cat-file blob` below would fail with "short object ID is ambiguous" in a large repository.
const raw = git([
  '-c',
  'core.quotepath=false',
  'diff',
  '--staged',
  '--raw',
  '-z',
  '--no-renames',
  '--no-abbrev',
  '--',
  ...pathspecs,
]);
const fields = raw.split('\0');
const entries = [];
for (let index = 0; index + 1 < fields.length; index += 2) {
  const metadata = fields[index];
  if (!metadata.startsWith(':')) continue;
  const [sourceMode, destinationMode, , destinationBlob, status] = metadata.slice(1).split(' ');
  entries.push({ sourceMode, destinationMode, destinationBlob, status, path: fields[index + 1] });
}

if (entries.length === 0) {
  setOutput('has_patch', 'false');
  process.exit(0);
}

// Mirrors the applier's enforcing check so the failure is reported here, where the diff is
// visible, instead of surfacing as an opaque rejection in a separate workflow run.
const forbidden = entries.filter(({ path: file }) => file === '.github' || file.startsWith('.github/') || file.startsWith('.git/'));
if (forbidden.length > 0) {
  // The caller's reporting step runs even after this failure and prints the diff, so it is not
  // repeated here.
  console.log(`::error::Autofix must not modify ${forbidden.map((entry) => entry.path).join(', ')}; refusing to produce a patch.`);
  process.exit(1);
}

// Note --raw reports the DESTINATION mode for content-only edits too, so this also catches a
// plain reformat of a file that was already executable. That is intended: whether the commit API
// preserves an existing path's mode when a FileAddition replaces only its contents is
// undocumented, so committing such a change could silently drop the executable bit.
// Declining is a WARNING rather than an error: the reporting step still fails the job with the
// diff, which is exactly the behaviour callers had before autofix could push at all. Failing hard
// here would instead tell the author to "apply manually" for a change autofix simply cannot carry.
// A CHANGED mode is caught too, even when the destination is a plain 100644: clearing an
// executable bit leaves the blob identical, so the patch would be a byte-for-byte no-op that
// drops the fix. Worse, the next run reproduces the same diff on top of the App's own commit and
// trips the apply job's non-convergence guard with a misleading "fixers are not idempotent".
const unsupported = entries.filter(
  ({ sourceMode, destinationMode }) =>
    (destinationMode !== RegularFileMode && destinationMode !== DeletedMode) ||
    (sourceMode !== DeletedMode && destinationMode !== DeletedMode && sourceMode !== destinationMode)
);
if (unsupported.length > 0) {
  console.log(
    `::warning::No autofix patch was produced: ${unsupported.map((entry) => `${entry.path} (mode ${entry.sourceMode} -> ${entry.destinationMode})`).join(', ')} is not a plain-file content change, and the commit API expresses file contents only, so file modes, symlinks and submodules cannot be carried.`
  );
  setOutput('has_patch', 'false');
  process.exit(0);
}

if (entries.length > MaxFileCount) {
  console.log(
    `::warning::No autofix patch was produced: ${entries.length} changed files exceeds the ${MaxFileCount} the apply workflow accepts.`
  );
  setOutput('has_patch', 'false');
  process.exit(0);
}

const additions = [];
const deletions = [];
let totalBytes = 0;
for (const entry of entries) {
  if (entry.destinationMode === DeletedMode) {
    deletions.push({ path: entry.path });
  } else {
    const contents = git(['cat-file', 'blob', entry.destinationBlob], 'buffer');
    totalBytes += contents.length;
    if (totalBytes > MaxTotalBytes) {
      console.log(
        `::warning::No autofix patch was produced: the changed files exceed the ${MaxTotalBytes} bytes the apply workflow accepts.`
      );
      setOutput('has_patch', 'false');
      process.exit(0);
    }
    additions.push({ path: entry.path, contents: contents.toString('base64') });
  }
}

const outputDirectory = path.join(runnerTemp, 'autofix-patch');
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  path.join(outputDirectory, 'autofix.json'),
  JSON.stringify({ version: 1, headSha, changes: { additions, deletions } })
);

console.log(`Collected ${additions.length} addition(s) and ${deletions.length} deletion(s):`);
for (const entry of entries) console.log(`  ${entry.status} ${entry.path}`);
setOutput('has_patch', 'true');
setOutput('patch_directory', outputDirectory);
