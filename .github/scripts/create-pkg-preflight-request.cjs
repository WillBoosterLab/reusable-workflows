const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MaxFilesPerRequest = 100;
const PkgPreflightUrl = 'https://pkg-preflight.up.railway.app';
const PkgPreflightRetryAttempts = 5;
const PkgPreflightRetryDelaySeconds = 10;
const KnownLockfileNames = new Set([
  'constraints.txt',
  'go.sum',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pom.xml',
  'pylock.toml',
  'requirements.txt',
]);

const event = readGitHubEvent();
const base = event?.pull_request?.base?.sha ?? event?.before ?? process.env.GITHUB_BASE_REF;
if (!base || /^0+$/u.test(base)) process.exit(0);
if (!fetchBase(base)) process.exit(0);

const changedFiles = listChangedFiles(event).filter(
  (file) => isLockfilePath(file.path) || (file.beforePath !== undefined && isLockfilePath(file.beforePath))
);
if (changedFiles.length === 0) {
  console.log('No supported lockfile changes found.');
  process.exit(0);
}

const requestDir = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'pkg-preflight-requests');
fs.rmSync(requestDir, { recursive: true, force: true });
fs.mkdirSync(requestDir, { recursive: true });
for (let index = 0; index < changedFiles.length; index += MaxFilesPerRequest) {
  const files = changedFiles.slice(index, index + MaxFilesPerRequest).map((file) => ({
    path: file.path,
    // Keep this undefined for new files because the API schema accepts an optional string, not null.
    before: readBaseFile(file.beforePath ?? file.path),
    after: fs.readFileSync(file.path, 'utf8'),
  }));
  fs.writeFileSync(path.join(requestDir, `${index / MaxFilesPerRequest}.json`), JSON.stringify({ json: { files } }));
}

for (const requestPath of fs
  .readdirSync(requestDir)
  .sort()
  .map((fileName) => path.join(requestDir, fileName))) {
  const response = postRequest(requestPath);
  console.log(response);

  const verdict = JSON.parse(response).json.verdict;
  if (verdict === 'fail') {
    console.error(`pkg-preflight rejected dependency lockfile changes with verdict: ${verdict}`);
    process.exit(1);
  }
}

function fetchBase(base) {
  try {
    execFileSync('git', ['fetch', '--depth', '1', 'origin', base], { stdio: 'ignore' });
    return true;
  } catch (error) {
    console.error(`Failed to fetch base commit for pkg-preflight; skipping inspection: ${error.message}`);
    return false;
  }
}

function listChangedFiles(event) {
  const pullRequestNumber = event?.pull_request?.number;
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;

  if (pullRequestNumber && token && repository) {
    try {
      const { changedFiles, totalFetched } = listPullRequestChangedFiles({ pullRequestNumber, repository, token });

      if (event.pull_request.changed_files > totalFetched) {
        return listGitChangedFiles();
      }

      return changedFiles;
    } catch (error) {
      console.error(`Failed to list PR files for pkg-preflight; falling back to git diff: ${error.message}`);
      return listGitChangedFiles();
    }
  }

  return listGitChangedFiles();
}

function listPullRequestChangedFiles({ pullRequestNumber, repository, token }) {
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const changedFiles = [];
  let totalFetched = 0;

  for (let page = 1; ; page += 1) {
    const response = execFileSync(
      'curl',
      [
        '--fail',
        '--max-time',
        '60',
        '--show-error',
        '--silent',
        '-H',
        `authorization: Bearer ${token}`,
        '-H',
        'accept: application/vnd.github+json',
        `${apiUrl}/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const files = JSON.parse(response);
    totalFetched += files.length;
    changedFiles.push(
      ...files
        .filter((file) => file.status === 'added' || file.status === 'modified' || file.status === 'renamed')
        .map((file) => ({
          path: file.filename,
          beforePath: file.status === 'renamed' ? file.previous_filename : undefined,
        }))
        .filter((file) => file.path)
    );

    if (files.length < 100) {
      return { changedFiles, totalFetched };
    }
  }
}

function listGitChangedFiles() {
  const records = execFileSync('git', ['diff', '-z', '--name-status', '--diff-filter=AMR', 'FETCH_HEAD'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const changedFiles = [];

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];

    if (!status) {
      continue;
    }

    if (status.startsWith('R')) {
      const beforePath = records[index + 1];
      const filePath = records[index + 2];
      index += 2;

      if (beforePath && filePath) {
        changedFiles.push({ path: filePath, beforePath });
      }
      continue;
    }

    const filePath = records[index + 1];
    index += 1;

    if (filePath) {
      changedFiles.push({ path: filePath });
    }
  }

  return changedFiles;
}

function isLockfilePath(filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const pathParts = normalizedPath.split('/');
  const basename = pathParts.at(-1);

  return (
    !pathParts.some((part) => part === '.git' || part === 'node_modules' || part === 'vendor') &&
    basename !== undefined &&
    (KnownLockfileNames.has(basename) ||
      basename.endsWith('.lock') ||
      basename.endsWith('.lockfile') ||
      basename.endsWith('-lock.json') ||
      basename.endsWith('.lock.json') ||
      /^requirements[-_.].+\.txt$/u.test(basename) ||
      /^constraints[-_.].+\.txt$/u.test(basename))
  );
}

function postRequest(requestPath) {
  return execFileSync(
    'curl',
    [
      '--fail-with-body',
      '--max-time',
      '60',
      '--retry',
      String(PkgPreflightRetryAttempts),
      '--retry-all-errors',
      '--retry-delay',
      String(PkgPreflightRetryDelaySeconds),
      '--show-error',
      '--silent',
      `${PkgPreflightUrl}/rpc/inspectLockfileDiff`,
      '-H',
      'content-type: application/json',
      '--data-binary',
      `@${requestPath}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
}

function readBaseFile(filePath) {
  try {
    return execFileSync('git', ['show', `FETCH_HEAD:${filePath}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

function readGitHubEvent() {
  if (!process.env.GITHUB_EVENT_PATH) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
}
