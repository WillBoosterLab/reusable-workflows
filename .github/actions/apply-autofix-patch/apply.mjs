// Applies an autofix patch produced by an untrusted pull-request job.
//
// Everything in the patch file is attacker-controlled: it was written by a job that ran the pull
// request's own dependency lifecycle scripts. This script therefore treats the file as data only
// — every path is validated here, and the commit target (repository, branch, expected head) comes
// from the workflow_run event rather than from the patch. Getting that backwards would turn this
// into a "commit anything anywhere" primitive for any compromised dependency.
import { readFile, stat } from 'node:fs/promises';

// createCommitOnBranch sends the whole patch in one GraphQL request, so the cap bounds the request
// as well as the review burden of a single autofix commit.
const MaxTotalBytes = 25 * 1024 * 1024;
const MaxFileCount = 2000;
const MaxPathBytes = 4096;
// Ceiling on the raw artifact, enforced before parsing. It has to exceed the largest patch the
// other limits still ACCEPT, or a legitimate autofix would be produced and then rejected here:
// MaxTotalBytes as base64 is 34,952,536 bytes, and MaxFileCount paths of MaxPathBytes each add up
// to ~16 MB once JSON escaping is budgeted at 2x. 64 MiB clears that worst case with room to
// spare while still bounding a hostile artifact.
const MaxPatchFileBytes = 64 * 1024 * 1024;
// A first segment this script refuses to touch: a patch that rewrites workflows or actions would
// execute with this App's privileges on the next run, escalating a formatting bot into arbitrary
// org-wide write. The producing action rejects these too; this is the enforcing copy.
const ForbiddenTopLevelDirectories = new Set(['.github', '.git']);
// Control characters (NUL included) are never legitimate in a repository path, and they are a
// classic way to make a rendered diff disagree with the bytes actually committed.
const ControlCharacterPattern = /[\u0000-\u001f\u007f]/;

const {
  PATCH_FILE: patchFile,
  APP_TOKEN: appToken,
  REPOSITORY: repository,
  BRANCH: branch,
  EXPECTED_HEAD_OID: expectedHeadOid,
  COMMIT_MESSAGE: commitMessage,
} = process.env;

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

/**
 * Rejects anything that could escape the repository root or land in an executable-on-CI location.
 * `createCommitOnBranch` takes repository-relative POSIX paths, so anything else is malformed
 * regardless of intent.
 */
function validatePath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return 'is not a non-empty string';
  // Bounded so the worst-case serialized patch stays inside MaxPatchFileBytes; also well past any
  // path a real filesystem accepts.
  if (Buffer.byteLength(candidate) > MaxPathBytes) return `exceeds ${MaxPathBytes} bytes`;
  if (ControlCharacterPattern.test(candidate)) return 'contains control characters';
  if (candidate.startsWith('/')) return 'is absolute';
  if (candidate.includes('\\')) return 'contains a backslash';
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'contains an empty, "." or ".." segment';
  }
  if (ForbiddenTopLevelDirectories.has(segments[0])) return `targets the protected "${segments[0]}" directory`;
  return undefined;
}

// Bound the file before reading it: every later cap is computed from DECODED bytes, so a patch
// padded with megabytes of base64 filler (which decodes to nothing) would otherwise exhaust
// memory in readFile/JSON.parse before any validation runs. Base64 costs ~4/3, plus JSON overhead.
const { size: patchFileBytes } = await stat(patchFile);
if (patchFileBytes > MaxPatchFileBytes) {
  fail(`Patch file is ${patchFileBytes} bytes, exceeding the ${MaxPatchFileBytes} limit.`);
}
const patch = JSON.parse(await readFile(patchFile, 'utf8'));
if (patch.version !== 1) fail(`Unsupported patch version: ${JSON.stringify(patch.version)}`);
// The patch is bound to the commit it was computed from. Applying it onto a different head would
// silently resurrect changes the author already superseded.
if (patch.headSha !== expectedHeadOid) {
  fail(`Patch was produced for ${patch.headSha}, but the run's head is ${expectedHeadOid}.`);
}

const additions = patch.changes?.additions ?? [];
const deletions = patch.changes?.deletions ?? [];
if (!Array.isArray(additions) || !Array.isArray(deletions)) fail('changes.additions/deletions must be arrays.');
if (additions.length + deletions.length === 0) {
  console.log('Patch contains no changes; nothing to apply.');
  process.exit(0);
}
if (additions.length + deletions.length > MaxFileCount) {
  fail(`Patch changes ${additions.length + deletions.length} files, exceeding the ${MaxFileCount} limit.`);
}

let totalBytes = 0;
for (const addition of additions) {
  const reason = validatePath(addition?.path);
  if (reason) fail(`Rejected addition path ${JSON.stringify(addition?.path)}: it ${reason}.`);
  if (typeof addition.contents !== 'string') fail(`Addition ${addition.path} has non-string contents.`);
  // Buffer.from silently DROPS invalid base64 characters rather than throwing, so the round trip
  // is what actually rejects a malformed payload. The comparison is EXACT: normalizing away
  // trailing '=' on both sides would accept arbitrarily long runs of padding ("====" decodes to
  // zero bytes), letting a hostile patch inflate the artifact without moving the byte counter.
  // The producer emits Node's canonical padded base64, so exact equality rejects nothing valid.
  const decoded = Buffer.from(addition.contents, 'base64');
  if (decoded.toString('base64') !== addition.contents) {
    fail(`Addition ${addition.path} is not canonical base64.`);
  }
  totalBytes += decoded.length;
  // Checked inside the loop so an oversized patch stops here instead of after decoding all of it.
  if (totalBytes > MaxTotalBytes) fail(`Patch decodes to more than the ${MaxTotalBytes} byte limit.`);
}
for (const deletion of deletions) {
  const reason = validatePath(deletion?.path);
  if (reason) fail(`Rejected deletion path ${JSON.stringify(deletion?.path)}: it ${reason}.`);
}
console.log(`Applying ${additions.length} addition(s) and ${deletions.length} deletion(s) to ${repository}@${branch}.`);

const response = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${appToken}`,
    'content-type': 'application/json',
    'user-agent': 'willbooster-autofix-apply',
  },
  body: JSON.stringify({
    query: `mutation ($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid url } }
    }`,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        message: { headline: commitMessage },
        // Optimistic concurrency: if anything else pushed since the patch was computed, the
        // mutation fails instead of clobbering that work with stale contents.
        expectedHeadOid,
        // Rebuilt field by field so nothing else from the untrusted patch reaches the API.
        fileChanges: {
          additions: additions.map(({ path, contents }) => ({ path, contents })),
          deletions: deletions.map(({ path }) => ({ path })),
        },
      },
    },
  }),
});

if (!response.ok) fail(`GraphQL request failed: ${response.status} ${await response.text()}`);
const result = await response.json();
if (result.errors?.length) fail(`GraphQL reported: ${JSON.stringify(result.errors)}`);

const commit = result.data?.createCommitOnBranch?.commit;
if (!commit) fail(`GraphQL returned no commit: ${JSON.stringify(result)}`);
console.log(`Committed ${commit.oid}: ${commit.url}`);
