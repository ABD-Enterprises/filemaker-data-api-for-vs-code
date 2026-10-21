import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerBatchCommands } from '../../../src/commands/batch';
import { command, expectSafeError, layout, logger, profile, profileStore, resetCommandMocks, serviceError } from '../../helpers/commandHarness';

const arg = { profileId: profile.id, layout };
const entries = [{ recordId: '42', fieldData: { ' Field ': ' value ' } }];

function setup() {
  const profiles = profileStore();
  const client = { listLayouts: vi.fn().mockResolvedValue([layout]) };
  const batchService = {
    batchExportFind: vi.fn().mockResolvedValue({ exportedRecords: 2, truncated: false }),
    getDefaultBatchUpdateOptions: vi.fn().mockResolvedValue({ dryRun: true }),
    batchUpdate: vi.fn().mockResolvedValue({ attempted: 1, successCount: 1, failureCount: 0 })
  };
  const tasks: Array<(context: never) => Promise<unknown>> = [];
  const jobRunner = { startJob: vi.fn((_name: string, task: (context: never) => Promise<unknown>) => {
    tasks.push(task);
    return { id: '12345678-abcd' };
  }) };
  const roleGuard = { assertFeature: vi.fn().mockResolvedValue(true), resolvePerformanceMode: vi.fn().mockReturnValue('balanced') };
  const settings = { isBatchEnabled: vi.fn().mockReturnValue(true), getBatchMaxRecords: vi.fn().mockReturnValue(250), getBatchConcurrency: vi.fn().mockReturnValue(3) };
  const log = logger();
  registerBatchCommands({ profileStore: profiles as never, fmClient: client as never, batchService: batchService as never,
    jobRunner: jobRunner as never, roleGuard: roleGuard as never, settingsService: settings as never, logger: log as never });
  return { profiles, client, batchService, jobRunner, roleGuard, settings, log, tasks };
}

function exportInputs(path = '/tmp/results.csv', find = '[{" Field ":"==value"}]', sort = '[{"fieldName":" Field ","sortOrder":"ascend"}]') {
  vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(find).mockResolvedValueOnce(sort);
  vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file(path));
}

function updateInputs(dryRun = true, path = '/tmp/input.json') {
  vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(path)]);
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(path.endsWith('.CSV') ? 'recordId, Field \n42, value ' : JSON.stringify(entries)));
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: dryRun } as never);
}

describe('batch commands', () => {
  beforeEach(resetCommandMocks);

  it.each(['batchExportFind', 'batchUpdateFromFile'])('%s refuses an untrusted workspace before touching services', async (name) => {
    const { jobRunner, profiles, roleGuard } = setup();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    await command(name)(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Batch operations are disabled in settings or untrusted workspace mode.', 'Learn More');
    expect(profiles.getProfile).not.toHaveBeenCalled();
    expect(roleGuard.assertFeature).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('refuses a disabled feature and opens trust help only on request', async () => {
    const { settings, jobRunner } = setup();
    settings.isBatchEnabled.mockReturnValue(false);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Learn More' as never);
    await command('batchExportFind')(arg);
    expect(vscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'https://code.visualstudio.com/docs/editor/workspace-trust' }));
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('enforces the batch update role guard before choosing a source', async () => {
    const { roleGuard, profiles, jobRunner } = setup();
    roleGuard.assertFeature.mockResolvedValue(false);
    await command('batchUpdateFromFile')(arg);
    expect(roleGuard.assertFeature).toHaveBeenCalledWith('batchUpdate', 'Batch update from CSV/JSON');
    expect(profiles.getProfile).not.toHaveBeenCalled();
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each(['batchExportFind', 'batchUpdateFromFile'])('%s stops on missing profile or cancelled layout selection', async (name) => {
    const { profiles, jobRunner } = setup();
    profiles.getProfile.mockResolvedValueOnce(undefined);
    await command(name)(arg);
    await command(name)({ profileId: profile.id });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Connection profile ${profile.id} not found.`);
    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('exports the exact selected layout and field names with the configured record limit', async () => {
    const { tasks, jobRunner, batchService } = setup();
    exportInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(layout as never);
    await command('batchExportFind')({ profileId: profile.id });
    expect(jobRunner.startJob).toHaveBeenCalledWith(`Batch Export ${layout}`, expect.any(Function));
    const context = { log: vi.fn() };
    await expect(tasks[0]!(context as never)).resolves.toEqual({ exportedRecords: 2, truncated: false });
    expect(batchService.batchExportFind).toHaveBeenCalledWith(profile, layout,
      { query: [{ ' Field ': '==value' }], sort: [{ fieldName: ' Field ', sortOrder: 'ascend' }] },
      { outputPath: '/tmp/results.csv', format: 'csv', maxRecords: 250 }, context);
    expect(context.log).toHaveBeenCalledWith('info', 'Finished export. Records=2, truncated=false');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Started job 12345678 for batch export.');
  });

  it.each(['/tmp/results.csv', '/tmp/results.jsonl'])('forces streaming JSONL in high-scale mode (%s)', async (path) => {
    const { roleGuard, tasks, batchService } = setup();
    roleGuard.resolvePerformanceMode.mockReturnValue('high-scale');
    exportInputs(path, '[{}]', '');
    await command('batchExportFind')(arg);
    await tasks[0]!({ log: vi.fn() } as never);
    expect(batchService.batchExportFind).toHaveBeenCalledWith(profile, layout, { query: [{}], sort: undefined },
      { outputPath: '/tmp/results.jsonl', format: 'jsonl', maxRecords: 250 }, expect.anything());
  });

  it('does not schedule an export when find input is cancelled', async () => {
    const { jobRunner } = setup();
    await command('batchExportFind')(arg);
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('does not schedule an export when the output dialog is cancelled', async () => {
    const { jobRunner } = setup();
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('[{}]');
    await command('batchExportFind')(arg);
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each([['broken', ''], ['[{}]', 'broken']])('rejects invalid find/sort (%s, %s) without scheduling', async (find, sort) => {
    const { jobRunner } = setup();
    exportInputs('/tmp/results.jsonl', find, sort);
    await command('batchExportFind')(arg);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each(['/tmp/input.json', '/tmp/input.CSV'])('schedules a dry-run with exact field names and opens a preview (%s)', async (path) => {
    const { tasks, batchService, jobRunner } = setup();
    updateInputs(true, path);
    await command('batchUpdateFromFile')(arg);
    expect(jobRunner.startJob).toHaveBeenCalledWith(`Batch Update ${layout}`, expect.any(Function));
    const context = { log: vi.fn() };
    await tasks[0]!(context as never);
    expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, entries, { dryRun: true, concurrency: 3 }, context);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    const doc = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]![0] as { content: string };
    expect(JSON.parse(doc.content)).toEqual({ dryRun: true, totalEntries: 1, layout, sample: entries });
    expect(context.log).toHaveBeenCalledWith('info', 'Batch update completed. Attempted=1, success=1, failures=0');
  });

  it.each([undefined, 'Cancel', 'Execute'])('requires a destructive modal before executing updates (%s)', async (choice) => {
    const { tasks, jobRunner, batchService } = setup();
    updateInputs(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(choice as never);
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(`Execute batch update for 1 records on ${layout}?`), { modal: true }, 'Execute');
    if (choice === 'Execute') {
      const context = { log: vi.fn() };
      await tasks[0]!(context as never);
      expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, entries, { dryRun: false, concurrency: 3 }, context);
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    } else {
      expect(jobRunner.startJob).not.toHaveBeenCalled();
      expect(batchService.batchUpdate).not.toHaveBeenCalled();
    }
  });

  it('includes early-stop guidance in the job log', async () => {
    const { batchService, tasks } = setup();
    batchService.batchUpdate.mockResolvedValue({ attempted: 1, successCount: 0, failureCount: 1, stoppedReason: 'cancelled', notAttempted: 4 });
    updateInputs();
    await command('batchUpdateFromFile')(arg);
    const context = { log: vi.fn() };
    await tasks[0]!(context as never);
    expect(context.log).toHaveBeenCalledWith('info', 'Batch update completed. Attempted=1, success=0, failures=1. Stopped early (4 not attempted): cancelled');
  });

  it('does not read or schedule when the source dialog is cancelled', async () => {
    const { jobRunner } = setup();
    await command('batchUpdateFromFile')(arg);
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('does not schedule when the update mode is cancelled', async () => {
    const { jobRunner } = setup();
    updateInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    await command('batchUpdateFromFile')(arg);
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('does not prompt for a mode or schedule an empty update file', async () => {
    const { jobRunner } = setup();
    updateInputs();
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('[]'));
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No valid update rows found.');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each(['read', 'defaults', 'schedule'])('reports a %s failure safely without crashing', async (failure) => {
    const { batchService, jobRunner, log } = setup();
    updateInputs();
    if (failure === 'read') vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(serviceError());
    if (failure === 'defaults') batchService.getDefaultBatchUpdateOptions.mockRejectedValue(serviceError());
    if (failure === 'schedule') jobRunner.startJob.mockImplementation(() => { throw serviceError(); });
    await expect(command('batchUpdateFromFile')(arg)).resolves.toBeUndefined();
    expectSafeError();
    expect(log.error).toHaveBeenCalledWith('Batch update failed to start.', expect.anything());
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(batchService.batchUpdate).not.toHaveBeenCalled();
  });
});
