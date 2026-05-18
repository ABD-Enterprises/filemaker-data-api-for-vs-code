import * as vscode from 'vscode';

import { registerBatchCommands } from './commands/batch';
import { registerCircuitBreakerCommands } from './commands/circuitBreaker';
import { registerDiagnosticsCommands } from './commands/diagnostics';
import { registerEnterpriseCommands } from './commands/enterprise';
import { registerFmWebProjectCommands } from './commands/fmWebProject';
import { registerCoreCommands } from './commands';
import { registerHistoryCommands } from './commands/history';
import { registerJobsCommands } from './commands/jobs';
import { registerOfflineCommands } from './commands/offline';
import { registerPluginCommands } from './commands/plugins';
import { registerRecordEditCommands } from './commands/recordEdit';
import { registerSavedQueriesCommands } from './commands/savedQueries';
import { registerSchemaCommands } from './commands/schema';
import { registerSchemaSnapshotCommands } from './commands/schemaSnapshots';
import { registerScriptRunnerCommands } from './commands/scriptRunner';
import { registerTypeGenCommands } from './commands/typeGen';
import { BatchService } from './services/batchService';
import { FMClient } from './services/fmClient';
import { HistoryStore } from './services/historyStore';
import { JobRunner } from './services/jobRunner';
import { Logger } from './services/logger';
import { ProfileStore } from './services/profileStore';
import { SavedQueriesStore } from './services/savedQueriesStore';
import { SchemaService, normalizeSchemaCacheTtlMs } from './services/schemaService';
import { SchemaSnapshotStore } from './services/schemaSnapshotStore';
import { SecretStore } from './services/secretStore';
import { SettingsService } from './services/settingsService';
import { TypeGenService } from './services/typeGenService';
import { FmWebProjectService } from './services/fmWebProjectService';
import { FmWebRuntimeGenerator } from './services/fmWebRuntimeGenerator';
import { FmBridgeServer } from './services/fmBridgeServer';
import { EnvironmentSetStore } from './enterprise/environmentSetStore';
import { EnvironmentCompareService } from './enterprise/environmentCompareService';
import { RoleGuard } from './enterprise/roleGuard';
import { MetricsStore } from './diagnostics/metricsStore';
import { OfflineModeService } from './offline/offlineModeService';
import { CircuitBreakerRegistry } from './performance/circuitBreakerRegistry';
import { PluginRegistry } from './plugins/pluginRegistry';
import { FMExplorerProvider } from './views/fmExplorer';
import { OfflineStatusBar } from './views/offlineStatusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settingsService = new SettingsService();
  const logger = new Logger('FileMaker Data API Tools', settingsService);
  const roleGuard = new RoleGuard(logger);
  await roleGuard.applyContexts();

  const profileStore = new ProfileStore(context.globalState, context.workspaceState);
  const secretFallbackMode = settingsService.getSecretsFallbackMode();
  const secretStore = new SecretStore(context.secrets, {
    fallbackMode: secretFallbackMode,
    workspaceState:
      secretFallbackMode === 'workspace-state' ? context.workspaceState : undefined,
    machineId: vscode.env.machineId,
    logger,
    onFallbackEngaged: (mode, reason) => {
      const text =
        mode === 'workspace-state'
          ? `FileMaker: SecretStorage unavailable (${reason}); falling back to encrypted workspace state.`
          : `FileMaker: SecretStorage unavailable (${reason}); secret persistence is disabled.`;
      void vscode.window.showWarningMessage(text);
    }
  });
  const offlineModeService = new OfflineModeService(logger);
  const environmentSetStore = new EnvironmentSetStore(context.workspaceState);
  const savedQueriesStore = new SavedQueriesStore(context.globalState, context.workspaceState, {
    getScope: () => settingsService.getSavedQueriesScope()
  });

  const historyStore = new HistoryStore(context.workspaceState, {
    getMaxEntries: () => settingsService.getHistoryMaxEntries()
  });
  const metricsStore = new MetricsStore(context.workspaceState, {
    getMaxEntries: () => 200
  });
  const jobRunner = new JobRunner(context.workspaceState);

  const timeoutMs = settingsService.getRequestTimeoutMs();

  const fmClient = new FMClient(
    secretStore,
    logger,
    timeoutMs,
    undefined,
    undefined,
    historyStore,
    metricsStore,
    () => ({
      maxAgeMs: settingsService.getSessionMaxAgeMs(),
      refreshLeadMs: settingsService.getSessionRefreshLeadMs()
    })
  );
  const schemaService = new SchemaService(fmClient, logger, {
    getCacheTtlMs: () =>
      normalizeSchemaCacheTtlMs(settingsService.getSchemaCacheTtlSeconds()),
    isMetadataEnabled: () => settingsService.isSchemaMetadataEnabled(),
    offlineModeService
  });
  const environmentCompareService = new EnvironmentCompareService(fmClient, schemaService, logger);
  const snapshotStore = new SchemaSnapshotStore(context.workspaceState, logger, {
    getStorageMode: () =>
      settingsService.getSchemaSnapshotsStorage(),
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted
  });
  const typeGenService = new TypeGenService(schemaService, fmClient, logger, {
    getOutputDir: () => settingsService.getTypegenOutputDir(),
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted
  });
  const circuitBreakerRegistry = new CircuitBreakerRegistry();
  const batchService = new BatchService(fmClient, {
    getMaxRecords: () => {
      const configured = settingsService.getBatchMaxRecords();
      return roleGuard.resolvePerformanceMode() === 'high-scale'
        ? Math.min(configured, 10_000)
        : configured;
    },
    getConcurrency: () => settingsService.getBatchConcurrency(),
    getDryRunDefault: () => settingsService.getBatchDryRunDefault(),
    getPerformanceMode: () => roleGuard.resolvePerformanceMode(),
    circuitBreakerRegistry
  });
  const pluginRegistry = new PluginRegistry(profileStore, fmClient, roleGuard, logger);
  const fmWebProjectService = new FmWebProjectService(
    profileStore,
    fmClient,
    schemaService,
    logger
  );
  const fmBridgeServer = new FmBridgeServer(profileStore, fmClient, fmWebProjectService, logger, {
    getRateLimitConfig: () => settingsService.getBridgeRateLimitConfig()
  });
  const fmWebRuntimeGenerator = new FmWebRuntimeGenerator(context, fmWebProjectService, logger);

  await environmentSetStore.ensureSeeded(roleGuard.getDefaultEnvironmentSetSeeds());
  await pluginRegistry.reload();

  const fmExplorerProvider = new FMExplorerProvider(
    profileStore,
    savedQueriesStore,
    fmClient,
    schemaService,
    snapshotStore,
    jobRunner,
    environmentSetStore,
    offlineModeService,
    logger
  );

  const treeViewDisposable = vscode.window.registerTreeDataProvider(
    'filemakerExplorer',
    fmExplorerProvider
  );

  const refreshExplorer = (): void => {
    fmExplorerProvider.refresh();
  };

  const coreCommandDisposables = registerCoreCommands({
    context,
    profileStore,
    secretStore,
    savedQueriesStore,
    fmClient,
    logger,
    roleGuard,
    refreshExplorer,
    onProfileDisconnected: (profileId) => {
      schemaService.invalidateProfile(profileId);
    },
    getConnectBackoffPolicy: () => settingsService.getConnectBackoffPolicy(),
    getConnectionWizardTestPolicy: () => settingsService.getConnectionWizardTestPolicy()
  });

  const savedQueryDisposables = registerSavedQueriesCommands({
    context,
    profileStore,
    savedQueriesStore,
    fmClient,
    logger,
    refreshExplorer
  });

  const schemaDisposables = registerSchemaCommands({
    profileStore,
    fmClient,
    schemaService,
    logger,
    refreshExplorer
  });
  const diagnostics = vscode.languages.createDiagnosticCollection('filemaker-schema-diff');
  const schemaSnapshotDisposables = registerSchemaSnapshotCommands({
    context,
    profileStore,
    fmClient,
    schemaService,
    snapshotStore,
    settingsService,
    logger,
    refreshExplorer,
    diagnostics
  });

  const scriptRunnerDisposables = registerScriptRunnerCommands({
    context,
    profileStore,
    fmClient,
    roleGuard,
    logger
  });
  const recordEditDisposables = registerRecordEditCommands({
    context,
    profileStore,
    fmClient,
    schemaService,
    settingsService,
    roleGuard,
    logger
  });

  const typeGenDisposables = registerTypeGenCommands({
    profileStore,
    fmClient,
    typeGenService,
    settingsService,
    logger
  });
  const batchDisposables = registerBatchCommands({
    profileStore,
    fmClient,
    batchService,
    jobRunner,
    roleGuard,
    settingsService,
    logger
  });
  const jobsDisposables = registerJobsCommands({
    jobRunner
  });

  const historyDisposables = registerHistoryCommands({
    historyStore
  });
  const enterpriseDisposables = registerEnterpriseCommands({
    profileStore,
    environmentSetStore,
    compareService: environmentCompareService,
    roleGuard,
    settingsService,
    logger,
    refreshExplorer
  });
  const diagnosticsDisposables = registerDiagnosticsCommands({
    metricsStore,
    historyStore
  });
  const offlineDisposables = registerOfflineCommands({
    profileStore,
    fmClient,
    offlineModeService,
    roleGuard,
    logger,
    refreshExplorer
  });
  const pluginDisposables = registerPluginCommands({
    pluginRegistry
  });
  const circuitBreakerDisposables = registerCircuitBreakerCommands({
    registry: circuitBreakerRegistry
  });
  const fmWebProjectDisposables = registerFmWebProjectCommands({
    context,
    profileStore,
    fmClient,
    schemaService,
    fmWebProjectService,
    fmWebRuntimeGenerator,
    fmBridgeServer,
    logger,
    refreshExplorer
  });

  const jobsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
  jobsStatusBar.command = 'filemakerDataApiTools.showJobs';
  jobsStatusBar.text = '$(history) FM Jobs: idle';
  jobsStatusBar.tooltip = 'FileMaker Data API jobs';
  jobsStatusBar.show();

  const jobsSubscription = jobRunner.onDidChange(() => {
    refreshExplorer();
    const running = jobRunner.listJobs().find((job) => job.status === 'running' || job.status === 'queued');
    if (!running) {
      jobsStatusBar.text = '$(history) FM Jobs: idle';
      return;
    }

    jobsStatusBar.text = `$(sync~spin) FM Job: ${running.name} ${running.progress}%`;
  });

  const offlineStatusBar = new OfflineStatusBar(offlineModeService, {
    getStaleHours: () => settingsService.getOfflineStaleCacheWarnHours()
  });
  offlineStatusBar.start();

  context.subscriptions.push(
    offlineStatusBar,
    treeViewDisposable,
    ...coreCommandDisposables,
    ...savedQueryDisposables,
    ...schemaDisposables,
    ...schemaSnapshotDisposables,
    ...scriptRunnerDisposables,
    ...recordEditDisposables,
    ...typeGenDisposables,
    ...batchDisposables,
    ...jobsDisposables,
    ...historyDisposables,
    ...enterpriseDisposables,
    ...diagnosticsDisposables,
    ...offlineDisposables,
    ...pluginDisposables,
    ...circuitBreakerDisposables,
    ...fmWebProjectDisposables,
    diagnostics,
    jobsStatusBar,
    jobsSubscription,
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await roleGuard.applyContexts();
      await pluginRegistry.reload();
      refreshExplorer();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration('filemaker.enterprise.mode') ||
        event.affectsConfiguration('filemaker.enterprise.role') ||
        event.affectsConfiguration('filemaker.offline.mode') ||
        event.affectsConfiguration('filemaker.performance.mode')
      ) {
        await roleGuard.applyContexts();
        await pluginRegistry.reload();
        refreshExplorer();
      }
    }),
    pluginRegistry,
    new vscode.Disposable(() => fmBridgeServer.dispose()),
    new vscode.Disposable(() => logger.dispose())
  );

  logger.info('FileMaker Data API Tools activated.');
}

export function deactivate(): void {
  // no-op
}
