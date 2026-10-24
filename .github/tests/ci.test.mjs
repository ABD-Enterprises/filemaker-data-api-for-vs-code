import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const ci = parse(read('workflows/ci.yml'));

test('both CI test jobs run workspace tests after shared is built', () => {
  for (const name of ['build-test', 'cross-platform']) {
    const steps = ci.jobs[name].steps;
    const build = steps.findIndex((step) => step.name === 'Build');
    assert.ok(build >= 0);
    assert.ok(steps.findIndex((step) => step.run === 'npm test -w designer-ui -w runtime-next') > build);
  }
});

test('only PR runs cancel predecessors; branch pushes do not duplicate PR runs', () => {
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.deepEqual(ci.on.push.tags, ['v*']);
  assert.ok('pull_request' in ci.on);
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.equal(ci.concurrency.group, '${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}');
});

test('CI checks the mock contract and enforces a 3 MiB VSIX budget', () => {
  const steps = ci.jobs['build-test'].steps;
  assert.ok(steps.some((step) => step.run === 'npm run mock:check -w extension'));
  assert.equal(steps.find((step) => step.name === 'Enforce VSIX size budget').env.VSIX_BUDGET_BYTES, '3145728');
});

test('runner routing keeps check names; cross-platform uses hosted runners because the repository is public', () => {
  assert.equal(ci.jobs['build-test']['runs-on'], '${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}');
  assert.equal(ci.jobs['cross-platform'].name, 'cross-platform (${{ matrix.os }})');
  assert.equal(ci.jobs['cross-platform']['runs-on'], '${{ matrix.os }}');
  assert.deepEqual(ci.jobs['cross-platform'].strategy.matrix.os, ['windows-latest', 'ubuntu-latest']);
});

test('both workflows use the trusted composite GitHub CLI action', () => {
  const dependency = parse(read('workflows/dependency-auto-merge.yml'));
  for (const steps of [ci.jobs.release.steps, dependency.jobs['dependabot-dev-deps'].steps]) {
    const action = steps.findIndex((step) => step.uses === './.github/actions/ensure-gh');
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(action >= 0);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(steps.indexOf(checkout) < action);
  }
  const checkout = dependency.jobs['dependabot-dev-deps'].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.base.sha }}');
  const composite = parse(read('actions/ensure-gh/action.yml'));
  assert.equal(composite.runs.using, 'composite');
  const step = composite.runs.steps[0];
  assert.equal(step.shell, 'bash');
  assert.match(step.run, /GH_VERSION=2\.102\.0/);
  assert.match(step.run, /grep " \$\{ASSET\}\$" "\$\{CHECKSUMS\}" \| sha256sum -c -/);
  assert.match(step.run, /ln -sf "\$\(command -v gh\)"/);
});

test('Dependabot does not ignore uuid when neither lockfile contains it', () => {
  for (const file of ['../package-lock.json', '../tools/publish/package-lock.json']) {
    assert.doesNotMatch(read(file), /"(?:[^"\n]*\/)?uuid"\s*:/);
  }
  const dependabot = parse(read('dependabot.yml'));
  assert.ok(!dependabot.updates[0].ignore.some((entry) => entry['dependency-name'] === 'uuid'));
});

test('the secret rotation reminder tests the parser, installs nothing and files issues with narrow permissions', () => {
  const rotation = parse(read('workflows/secret-rotation-reminder.yml'));
  const job = rotation.jobs.remind;
  assert.equal(job['runs-on'], '${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}');
  assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });

  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const setupNode = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(setupNode.with['node-version'], 22);
  const ciSteps = ci.jobs['build-test'].steps;
  assert.equal(checkout.uses, ciSteps.find((step) => step.uses?.startsWith('actions/checkout@')).uses);
  assert.equal(setupNode.uses, ciSteps.find((step) => step.uses?.startsWith('actions/setup-node@')).uses);

  assert.ok(job.steps.some((step) => step.run === 'node --test scripts/'));
  const file = job.steps.find((step) => step.run === 'node scripts/secret-rotation-remind.mjs');
  assert.ok(file);
  assert.equal(file.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(file.env.GH_REPO, '${{ github.repository }}');
  for (const step of job.steps) {
    assert.doesNotMatch(step.run ?? '', /npm (ci|install|run)/, 'the job must not install or run dependencies');
  }
  assert.equal(rotation.on.workflow_dispatch.inputs['dry-run'].default, true);
});

test('CI runs the rotation calendar tests on every pull request', () => {
  const steps = ci.jobs['build-test'].steps;
  const scripts = steps.find((step) => step.run === 'node --test scripts/');
  assert.ok(scripts, 'the build-test job must run the parser and runner tests');
  const setupNode = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.ok(steps.indexOf(scripts) > setupNode);
});

test('the secret rotation reminder stays monthly, dry by default and serialized', () => {
  const rotation = parse(read('workflows/secret-rotation-reminder.yml'));
  assert.deepEqual(rotation.on.schedule, [{ cron: '0 9 1 * *' }]);

  const file = rotation.jobs.remind.steps.find(
    (step) => step.run === 'node scripts/secret-rotation-remind.mjs'
  );
  assert.ok(file);
  assert.equal(file.env.DRY_RUN, '${{ inputs.dry-run }}');
  assert.equal(rotation.on.workflow_dispatch.inputs['dry-run'].default, true);

  assert.ok(rotation.concurrency?.group, 'the workflow must serialize its runs');
  assert.equal(rotation.concurrency['cancel-in-progress'], false);
});
