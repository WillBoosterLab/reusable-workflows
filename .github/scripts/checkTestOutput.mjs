import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const workflow = Bun.YAML.parse(await fs.readFile(".github/workflows/test.yml", "utf8"));
const script = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).find((step) => step.id === "test").run;
await fs.mkdir(".tmp", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".tmp/test-output-"));
try {
  await fs.writeFile(path.join(root, "emit.cjs"), "require('node:fs').writeFileSync(1, 'stdout-evidence\\n'.repeat(50_000)); require('node:fs').writeFileSync(2, 'stderr-evidence\\n'.repeat(50_000)); process.exit(Number(process.argv[2]));");
  for (const command of ["test", "test/ci", "custom"]) {
    for (const code of [0, 7]) {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { [command]: `node emit.cjs ${code}` } }));
      const outputPath = path.join(root, "outputs");
      await fs.writeFile(outputPath, "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
        cwd: root,
        env: { ...process.env, UPLOAD_TEST_LOG: "true", HAS_TEST_COMMAND: String(command === "custom"), CUSTOM_TEST_COMMAND: command, RUNNER: "bun", RUNNER_TEMP: root, GITHUB_OUTPUT: outputPath },
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.status, code, result.stderr);
      const outputs = await fs.readFile(outputPath, "utf8");
      const logPath = outputs.match(/^log_path=(.+)$/m)[1];
      const log = await fs.readFile(logPath, "utf8");
      for (const marker of ["stdout-evidence", "stderr-evidence"]) {
        assert.equal(log.split(marker).length - 1, 50_000);
        assert.equal(result.stdout.split(marker).length - 1, 50_000);
      }
    }
  }
  for (const code of [0, 7]) {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: `node emit.cjs ${code}` } }));
    const limited = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", `ulimit -f 1\n${script}`], {
      cwd: root,
      env: { ...process.env, UPLOAD_TEST_LOG: "true", HAS_TEST_COMMAND: "false", RUNNER: "bun", RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, `limited-outputs-${code}`) },
      encoding: "utf8",
      maxBuffer: 3 * 1024 * 1024,
    });
    assert.equal(limited.status, code || 1, limited.stderr);
    assert.equal(limited.stdout.split("stdout-evidence").length - 1, 50_000);
    assert.match(limited.stderr, /File.*(size|limit|large)/i);
  }
  for (const code of [0, 7]) {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: `printf '%4096s' x; exit ${code}` } }));
    const directOutputs = path.join(root, "direct-outputs");
    const direct = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: root,
      env: { ...process.env, UPLOAD_TEST_LOG: "false", HAS_TEST_COMMAND: "false", RUNNER: "bun", RUNNER_TEMP: path.join(root, "missing"), GITHUB_OUTPUT: directOutputs },
      encoding: "utf8",
    });
    assert.equal(direct.status, code, direct.stderr);
    assert.equal(direct.stdout.length, 4096);
    assert.equal(await Bun.file(directOutputs).exists(), false, "Opted-out runs must not allocate logs");
  }
  console.log("Test workflow preserves complete logs and exit codes for default and custom commands.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
