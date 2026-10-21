import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerSchemaSnapshotCommands } from '../../../src/commands/schemaSnapshots';
import { diffSchemaFieldsInWorker, diffSchemaSnapshotsInWorker, SchemaDiffCancelledError } from '../../../src/services/schemaDiff';
import type * as SchemaDiff from '../../../src/services/schemaDiff';
import { SchemaDiffPanel } from '../../../src/webviews/schemaDiff';
import { command, expectSafeError, layout, logger, profile, profileStore, resetCommandMocks, serviceError } from '../../helpers/commandHarness';

vi.mock('../../../src/services/schemaDiff', async (importOriginal) => ({
  ...await importOriginal<typeof SchemaDiff>(),
  diffSchemaFieldsInWorker: vi.fn(), diffSchemaSnapshotsInWorker: vi.fn()
}));
vi.mock('../../../src/webviews/schemaDiff', () => ({ SchemaDiffPanel: { createOrShow: vi.fn() } }));

const arg = { profileId: profile.id, layout };
const metadata = { fieldMetaData: [{ name: ' Field ', type: 'normal', result: 'text' }] };
const older = { id: 'older-id', profileId: profile.id, layout, capturedAt: '2026-10-01', source: 'manual', schemaVersion: 1, metadata };
const newer = { ...older, id: 'newer-id', capturedAt: '2026-10-02' };
const diff = {
  profileId: profile.id, layout, comparedAt: '2026-10-20',
  added: [{ name: ' Added ' }], removed: [{ name: ' Removed ' }],
  changed: [{ fieldName: ' Changed ', before: { name: ' Changed ' }, after: { name: ' Changed ' }, changes: [{ attribute: 'result', before: 'text', after: 'number' }] }],
  summary: { added: 1, removed: 1, changed: 1 }, hasChanges: true
};

function setup() {
  const profiles = profileStore();
  const schemaService = { getLayoutSchema: vi.fn().mockResolvedValue({ supported: true, metadata, fields: metadata.fieldMetaData }) };
  const snapshotStore = {
    captureSnapshot: vi.fn().mockResolvedValue(newer), listSnapshots: vi.fn().mockResolvedValue([older, newer]),
    getSnapshot: vi.fn().mockImplementation(async (id: string) => id === older.id ? older : newer),
    getLatestSnapshot: vi.fn().mockResolvedValue(older)
  };
  const diagnostics = { set: vi.fn(), delete: vi.fn() };
  const settings = { isSchemaDiagnosticsEnabled: vi.fn().mockReturnValue(true) };
  const client = { listLayouts: vi.fn().mockResolvedValue([layout]) };
  const log = logger();
  const refreshExplorer = vi.fn();
  const context = {} as vscode.ExtensionContext;
  vi.mocked(diffSchemaFieldsInWorker).mockReset().mockResolvedValue(diff);
  vi.mocked(diffSchemaSnapshotsInWorker).mockReset().mockResolvedValue(diff);
  registerSchemaSnapshotCommands({ context, profileStore: profiles as never, fmClient: client as never,
    schemaService: schemaService as never, snapshotStore: snapshotStore as never, settingsService: settings as never,
    logger: log as never, refreshExplorer, diagnostics: diagnostics as never });
  return { profiles, schemaService, snapshotStore, diagnostics, settings, log, refreshExplorer, context };
}

function pickSnapshots() {
  vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ snapshot: older } as never).mockResolvedValueOnce({ snapshot: newer } as never);
}

describe('schema snapshot commands', () => {
  beforeEach(resetCommandMocks);

  it('captures the exact layout metadata and refreshes the explorer', async () => {
    const { schemaService, snapshotStore, refreshExplorer } = setup();
    await command('captureSchemaSnapshot')(arg);
    expect(schemaService.getLayoutSchema).toHaveBeenCalledWith(profile, layout);
    expect(snapshotStore.captureSnapshot).toHaveBeenCalledWith({ profileId: profile.id, layout, source: 'manual', metadata });
    expect(refreshExplorer).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Captured schema snapshot newer-id for ${layout}.`);
  });

  it.each(['captureSchemaSnapshot', 'diffSchemaSnapshots', 'diffAgainstLatestSnapshot'])(
    '%s stops for a missing profile or cancelled layout picker', async (name) => {
      const { profiles, schemaService, snapshotStore } = setup();
      profiles.getProfile.mockResolvedValueOnce(undefined);
      await command(name)(arg);
      await command(name)({ profileId: profile.id });
      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(schemaService.getLayoutSchema).not.toHaveBeenCalled();
      expect(snapshotStore.listSnapshots).not.toHaveBeenCalled();
      expect(snapshotStore.getLatestSnapshot).not.toHaveBeenCalled();
    }
  );

  it.each(['captureSchemaSnapshot', 'diffAgainstLatestSnapshot'])('%s explains unsupported metadata without writing or diffing', async (name) => {
    const { schemaService, snapshotStore } = setup();
    schemaService.getLayoutSchema.mockResolvedValue({ supported: false, message: 'Metadata unavailable' });
    await command(name)(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Metadata unavailable');
    expect(snapshotStore.captureSnapshot).not.toHaveBeenCalled();
    expect(diffSchemaFieldsInWorker).not.toHaveBeenCalled();
  });

  it('uses the default unsupported-metadata message', async () => {
    const { schemaService } = setup();
    schemaService.getLayoutSchema.mockResolvedValue({ supported: true });
    await command('captureSchemaSnapshot')(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Metadata is not available on this server/profile.');
  });

  it.each(['schema', 'store'])('reports a capture %s failure safely', async (failure) => {
    const { schemaService, snapshotStore, refreshExplorer } = setup();
    if (failure === 'schema') schemaService.getLayoutSchema.mockRejectedValue(serviceError());
    else snapshotStore.captureSnapshot.mockRejectedValue(serviceError());
    await expect(command('captureSchemaSnapshot')(arg)).resolves.toBeUndefined();
    expectSafeError();
    expect(refreshExplorer).not.toHaveBeenCalled();
  });

  it('requires at least two snapshots', async () => {
    const { snapshotStore } = setup();
    snapshotStore.listSnapshots.mockResolvedValue([older]);
    await command('diffSchemaSnapshots')(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('At least two snapshots are required to diff.');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(diffSchemaSnapshotsInWorker).not.toHaveBeenCalled();
  });

  it.each(['older', 'newer'])('does not diff when the %s snapshot picker is cancelled', async (which) => {
    const { snapshotStore } = setup();
    if (which === 'newer') vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ snapshot: older } as never);
    await command('diffSchemaSnapshots')(arg);
    expect(snapshotStore.getSnapshot).not.toHaveBeenCalled();
    expect(diffSchemaSnapshotsInWorker).not.toHaveBeenCalled();
  });

  it('excludes the older selection from newer choices and sends both exact snapshots to the worker', async () => {
    const { snapshotStore, context } = setup();
    pickSnapshots();
    await command('diffSchemaSnapshots')(arg);
    expect(snapshotStore.listSnapshots).toHaveBeenCalledWith({ profileId: profile.id, layout });
    const offers = vi.mocked(vscode.window.showQuickPick).mock.calls[1]![0] as unknown as Array<{ snapshot: unknown }>;
    expect(offers.map((item) => item.snapshot)).toEqual([newer]);
    expect(diffSchemaSnapshotsInWorker).toHaveBeenCalledWith(older, newer,
      [expect.objectContaining({ name: ' Field ' })], [expect.objectContaining({ name: ' Field ' })], undefined);
    expect(vscode.window.withProgress).toHaveBeenCalledWith(expect.objectContaining({ cancellable: true, title: 'Diffing schema snapshots' }), expect.any(Function));
    expect(SchemaDiffPanel.createOrShow).toHaveBeenCalledWith(context, diff);
  });

  it.each(['older', 'newer'])('reports a missing %s snapshot without invoking the diff worker', async (which) => {
    const { snapshotStore } = setup();
    snapshotStore.getSnapshot.mockImplementation(async (id: string) => id === `${which}-id` ? undefined : older);
    pickSnapshots();
    await command('diffSchemaSnapshots')(arg);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Unable to load one or both selected snapshots.');
    expect(diffSchemaSnapshotsInWorker).not.toHaveBeenCalled();
  });

  it('reports a worker failure safely without opening a diff panel', async () => {
    setup();
    pickSnapshots();
    vi.mocked(diffSchemaSnapshotsInWorker).mockRejectedValue(serviceError());
    await command('diffSchemaSnapshots')(arg);
    expectSafeError();
    expect(SchemaDiffPanel.createOrShow).not.toHaveBeenCalled();
  });

  it.each(['diffSchemaSnapshots', 'diffAgainstLatestSnapshot'])('%s treats worker cancellation as cancellation, not an error', async (name) => {
    const { log, diagnostics } = setup();
    pickSnapshots();
    const worker = name === 'diffSchemaSnapshots' ? diffSchemaSnapshotsInWorker : diffSchemaFieldsInWorker;
    vi.mocked(worker).mockRejectedValue(new SchemaDiffCancelledError());
    await command(name)(arg);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(SchemaDiffPanel.createOrShow).not.toHaveBeenCalled();
    expect(diagnostics.set).not.toHaveBeenCalled();
  });

  it('explains when there is no latest snapshot', async () => {
    const { snapshotStore, schemaService } = setup();
    snapshotStore.getLatestSnapshot.mockResolvedValue(undefined);
    await command('diffAgainstLatestSnapshot')(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No snapshot found. Capture one first.');
    expect(schemaService.getLayoutSchema).not.toHaveBeenCalled();
  });

  it('diffs the current exact layout and publishes field diagnostics with correct severities', async () => {
    const { snapshotStore, diagnostics, context } = setup();
    const token = { isCancellationRequested: false };
    vi.mocked(vscode.window.withProgress).mockImplementation(((_options: unknown, task: (p: unknown, t: unknown) => unknown) => task({}, token)) as never);
    await command('diffAgainstLatestSnapshot')(arg);
    expect(snapshotStore.getLatestSnapshot).toHaveBeenCalledWith(profile.id, layout);
    expect(diffSchemaFieldsInWorker).toHaveBeenCalledWith({ profileId: profile.id, layout, olderSnapshotId: older.id,
      beforeFields: [expect.objectContaining({ name: ' Field ' })], afterFields: metadata.fieldMetaData }, token);
    expect(SchemaDiffPanel.createOrShow).toHaveBeenCalledWith(context, diff);
    expect(diagnostics.set).toHaveBeenCalledWith(expect.objectContaining({ fsPath: `filemaker-schema://p1/${encodeURIComponent(layout)}.json` }), [
      expect.objectContaining({ message: 'Schema added field:  Added ', severity: vscode.DiagnosticSeverity.Warning }),
      expect.objectContaining({ message: 'Schema removed field:  Removed ', severity: vscode.DiagnosticSeverity.Warning }),
      expect.objectContaining({ message: 'Schema changed field  Changed : result', severity: vscode.DiagnosticSeverity.Information })
    ]);
    expect(diagnostics.delete).not.toHaveBeenCalled();
  });

  it('clears existing diagnostics when the setting is disabled', async () => {
    const { settings, diagnostics } = setup();
    settings.isSchemaDiagnosticsEnabled.mockReturnValue(false);
    await command('diffAgainstLatestSnapshot')(arg);
    expect(diagnostics.delete).toHaveBeenCalledWith(expect.objectContaining({ fsPath: `filemaker-schema://p1/${encodeURIComponent(layout)}.json` }));
    expect(diagnostics.set).not.toHaveBeenCalled();
  });

  it.each(['schema', 'worker'])('reports a current-schema %s failure safely', async (failure) => {
    const { schemaService, diagnostics } = setup();
    if (failure === 'schema') schemaService.getLayoutSchema.mockRejectedValue(serviceError());
    else vi.mocked(diffSchemaFieldsInWorker).mockRejectedValue(serviceError());
    await command('diffAgainstLatestSnapshot')(arg);
    expectSafeError();
    expect(SchemaDiffPanel.createOrShow).not.toHaveBeenCalled();
    expect(diagnostics.set).not.toHaveBeenCalled();
  });

  it('opens snapshot JSON by ID without prompting', async () => {
    setup();
    await command('openSchemaSnapshotJson')({ snapshotId: older.id });
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'json', content: JSON.stringify(older, null, 2) });
  });

  it('opens snapshot JSON selected from the picker', async () => {
    const { snapshotStore } = setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ snapshot: newer } as never);
    await command('openSchemaSnapshotJson')();
    expect(snapshotStore.listSnapshots).toHaveBeenCalledWith({ profileId: profile.id });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'json', content: JSON.stringify(newer, null, 2) });
  });

  it.each(['cancel', 'empty', 'profile'])('does not open snapshot JSON after %s', async (reason) => {
    const { profiles, snapshotStore } = setup();
    if (reason === 'empty') snapshotStore.listSnapshots.mockResolvedValue([]);
    if (reason === 'profile') profiles.listProfiles.mockResolvedValue([]);
    await command('openSchemaSnapshotJson')();
    expect(snapshotStore.getSnapshot).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('reports an unavailable snapshot ID', async () => {
    const { snapshotStore } = setup();
    snapshotStore.getSnapshot.mockResolvedValue(undefined);
    await command('openSchemaSnapshotJson')({ snapshotId: 'missing' });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Snapshot not found.');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});
