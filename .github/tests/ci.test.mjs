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

test('runner routing uses variables and preserves check names', () => {
  assert.equal(ci.jobs['build-test']['runs-on'], '${{ fromJSON(vars.LINUX_RUNNER_LABELS) }}');
  assert.equal(ci.jobs['cross-platform'].name, 'cross-platform (${{ matrix.os }})');
  assert.equal(ci.jobs['cross-platform']['runs-on'], '${{ fromJSON(matrix.labels) }}');
  for (const entry of ci.jobs['cross-platform'].strategy.matrix.include) {
    assert.match(entry.labels, /^\$\{\{ vars\.(WINDOWS|LINUX)_RUNNER_LABELS \}\}$/);
  }
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
