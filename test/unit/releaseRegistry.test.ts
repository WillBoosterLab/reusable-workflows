import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('release workflow registry', () => {
  test('publishes public packages to npmjs when Takumi Guard is enabled', async () => {
    const workflow = Bun.YAML.parse(await Bun.file('.github/workflows/release.yml').text());
    const releaseStep = workflow.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release');

    const temporaryRoot = join(process.cwd(), '.tmp');
    await mkdir(temporaryRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(temporaryRoot, 'release-registry-'));
    temporaryDirectories.push(temporaryDirectory);
    const npmrcPath = join(temporaryDirectory, '.npmrc');
    await Bun.write(npmrcPath, 'registry=https://npm.flatt.tech/\n');

    const childProcess = Bun.spawn(['npm', 'config', 'get', 'registry', '--userconfig', npmrcPath], {
      env: {
        ...Bun.env,
        NPM_CONFIG_REGISTRY: releaseStep.env.NPM_CONFIG_REGISTRY,
      },
      stdout: 'pipe',
    });

    expect(await new Response(childProcess.stdout).text()).toBe('https://registry.npmjs.org/\n');
    expect(await childProcess.exited).toBe(0);
  });
});
