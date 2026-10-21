import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeGeneratedFiles } from '../../src/services/generatedFileWriter';
import * as vscode from 'vscode';
import { registerTypeGenCommands } from '../../src/commands/typeGen';
import { command, profile, profileStore, resetCommandMocks } from '../helpers/commandHarness';
import { TypeGenService } from '../../src/services/typeGenService';
import { FmWebProjectService } from '../../src/services/fmWebProjectService';
import { FmWebRuntimeGenerator } from '../../src/services/fmWebRuntimeGenerator';

let root: string;
const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'fm-followups-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function project(workspace = root) {
  const service = new FmWebProjectService({} as never, {} as never, {} as never, logger);
  vi.spyOn(service, 'getWorkspaceRoot').mockReturnValue(workspace);
  return service;
}
function runtime(workspace = root) {
  return new FmWebRuntimeGenerator({ extensionUri: { fsPath: path.resolve(__dirname, '../..') } } as never, project(workspace), logger);
}

it('accepts a workspace reached through a symlink while refusing links below its canonical root', async () => {
  const workspace = path.join(root, 'actual'); await mkdir(workspace);
  const alias = path.join(root, 'alias'); await symlink(workspace, alias);
  const target = path.join(alias, 'out/types.ts');
  await writeGeneratedFiles([{ path: target, content: 'types' }], alias);
  expect(await readFile(path.join(workspace, 'out/types.ts'), 'utf8')).toBe('types');
  await mkdir(path.join(workspace, 'real')); await symlink(path.join(workspace, 'real'), path.join(alias, 'linked'));
  await expect(writeGeneratedFiles([{ path: path.join(alias, 'linked/types.ts'), content: 'no' }], alias)).rejects.toThrow(/symlink/);
  expect(await readdir(path.join(workspace, 'real'))).toEqual([]);
});

it.each(['.fmweb', '.fmweb/generated', '.fmweb/generated/runtime-next', '.fmweb/generated/runtime-next/app'])('refuses template and env writes through %s before creating outside folders', async (folder) => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  await mkdir(path.dirname(path.join(workspace, folder)), { recursive: true });
  await symlink(outside, path.join(workspace, folder));
  const gen = runtime(workspace);
  await expect(gen.generateRuntimeAppTemplate()).rejects.toThrow(/symlink|outside/);
  expect(await readdir(outside)).toEqual([]);
  // The env writer never traverses app; all other ancestors protect the secret too.
  if (!folder.endsWith('/app')) {
    await expect(gen.writeBridgeEnv('http://127.0.0.1:123/fm', 'private')).rejects.toThrow(/symlink|outside/);
    expect(await readdir(outside)).toEqual([]);
  }
});

it.each([false, true])('checks a linked project before initialization, including existing config=%s', async (existing) => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  if (existing) await writeFile(path.join(outside, 'project.json'), JSON.stringify({ name: 'Existing' }));
  await symlink(outside, path.join(root, '.fmweb'));
  await expect(project().ensureProjectInitialized()).rejects.toThrow(/symlink|outside/);
  expect(await readdir(outside)).toEqual(existing ? ['project.json'] : []);
});

it('refuses a project file symlink before overwriting its target', async () => {
  const service = project(); await service.ensureProjectInitialized();
  const outside = path.join(root, 'mine'); await writeFile(outside, 'keep');
  await rm(service.getProjectConfigPath()); await symlink(outside, service.getProjectConfigPath());
  await expect(service.initializeProject()).rejects.toThrow(/symlink/);
  expect(await readFile(outside, 'utf8')).toBe('keep');
});

it('allows project, template and env generation through a linked workspace', async () => {
  const alias = `${root}-alias`; await symlink(root, alias);
  try {
    const gen = runtime(alias);
    expect((await gen.generateRuntimeAppTemplate()).created.length).toBeGreaterThan(10);
    const env = await gen.writeBridgeEnv('http://127.0.0.1:123/fm', 'private');
    expect(await readFile(env, 'utf8')).toContain('NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN=private');
  } finally { await rm(alias); }
});

it('all-layout generation propagates an unsafe output refusal instead of returning zero files', async () => {
  await mkdir(path.join(root, 'real')); await symlink(path.join(root, 'real'), path.join(root, 'filemaker-types'));
  const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }] }) } as never,
    { listLayouts: async () => [' Contacts '] } as never, logger, { getWorkspaceRoot: () => root });
  await expect(service.generateTypesForAllLayouts(profile)).rejects.toThrow(/symlink/);
  resetCommandMocks();
  registerTypeGenCommands({ profileStore: profileStore() as never, fmClient: {} as never, typeGenService: service, settingsService: {} as never, logger: logger as never });
  await command('generateTypesForAllLayouts')({ profileId: profile.id });
  expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0]).toContain('symlink');
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  expect(await readdir(path.join(root, 'real'))).toEqual([]);
});

it('still skips unavailable metadata and files the user chose to skip in all-layout generation', async () => {
  const service = new TypeGenService({ getLayoutSchema: async (_profile: unknown, layout: string) => {
    if (layout === 'Missing') throw new Error('metadata unavailable');
    return { supported: true, fields: [] };
  } } as never, { listLayouts: async () => ['Missing', 'Keep', 'New'] } as never, logger, { getWorkspaceRoot: () => root });
  await mkdir(path.join(root, 'filemaker-types/layouts'), { recursive: true });
  await writeFile(path.join(root, 'filemaker-types/layouts/Keep.ts'), 'my types');
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Skip existing' as never);
  const files = await service.generateTypesForAllLayouts(profile);
  expect(files.map((file) => file.layout)).toEqual(['New']);
  expect(await readFile(path.join(root, 'filemaker-types/layouts/Keep.ts'), 'utf8')).toBe('my types');
});
