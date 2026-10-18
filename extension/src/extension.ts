import * as path from 'path';

import * as vscode from 'vscode';

import { registerBatchCommands } from './commands/batch';
import { registerCircuitBreakerCommands } from './commands/circuitBreaker';
import { registerDiagnosticsCommands } from './commands/diagnostics';
import { registerEnterpriseCommands } from './commands/enterprise';
import { registerFmWebProjectCommands } from './commands/fmWebProject';
import { registerCoreCommands } from './commands';
import { registerHistoryCommands } from './commands/history';
import { registerJobsCommands } from './commands/jobs';
import { registerLayoutInspectorCommands } from './commands/layoutInspector';
import { registerOfflineCommands } from './commands/offline';
import { registerPluginCommands } from './commands/plugins';
import { registerRecordEditCommands } from './commands/recordEdit';
import { registerSavedQueriesCommands } from './commands/savedQueries';
import { registerSchemaCommands } from './commands/schema';
import { AuditLog } from './ai/aiAudit';
import { AiToolsController, getLanguageModelApi } from './ai/aiRegistration';
import { isAiFeatureSwitchOn, isExternalServerEnabled, readAiSettings } from './ai/aiSettings';
import { AiMcpController, PERMISSION_EPOCH_KEY, PERMISSION_SEEN_KEY, STARTED_HERE_KEY } from './ai/mcp/aiMcpController';
import { AiToolService } from './ai/aiToolService';
import { registerAiMcpCommands, watchExternalServerSetting } from './commands/aiMcp';
import { AiStatusBar, auditLogPath, registerAiToolCommands } from './commands/aiTools';
import { registerAiContextCommands } from './commands/aiContext';
import { registerSchemaSnapshotCommands } from './commands/schemaSnapshots';
import { registerScriptRunnerCommands } from './commands/scriptRunner';
import { registerShowDiagnosticsCommand } from './commands/showDiagnostics';
import { registerTypeGenCommands } from './commands/typeGen';
import type { BatchService } from './services/batchService';
import type { FMClient } from './services/fmClient';
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
import { bridgeRouteRefusal } from './utils/bridgePolicy';
import { MetricsStore } from './diagnostics/metricsStore';
import { OfflineModeService } from './offline/offlineModeService';
import type { CircuitBreakerRegistry } from './performance/circuitBreakerRegistry';
import { PluginRegistry } from './plugins/pluginRegistry';
import { ConnectionStatusBar } from './views/connectionStatusBar';
import { FMExplorerProvider } from './views/fmExplorer';
import { LayoutInspectorProvider } from './views/layoutInspector';
import { OfflineStatusBar } from './views/offlineStatusBar';

function createLazyFmClient(
  loadClient: () => Promise<FMClient>,
  getLoadedClient: () => FMClient | undefined
): FMClient {
  return new Proxy({} as FMClient, {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }

      if (property === 'invalidateProfileCache') {
        return (profileId: string): void => {
          getLoadedClient()?.invalidateProfileCache(profileId);
        };
      }

      if (property === 'shouldRefreshSession') {
        return (profileId: string, now?: number): boolean =>
          getLoadedClient()?.shouldRefreshSession(profileId, now) ?? false;
      }

      return async (...args: unknown[]) => {
        const client = await loadClient();
        const value = (client as unknown as Record<PropertyKey, unknown>)[property];
        return typeof value === 'function' ? value.apply(client, args) : value;
      };
    }
  });
}

function createLazyBatchService(loadService: () => Promise<BatchService>): BatchService {
  return new Proxy({} as BatchService, {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }

      return async (...args: unknown[]) => {
        const service = await loadService();
        const value = (service as unknown as Record<PropertyKey, unknown>)[property];
        return typeof value === 'function' ? value.apply(service, args) : value;
      };
    }
  });
}

function createLazyCircuitBreakerRegistry(
  getLoadedRegistry: () => CircuitBreakerRegistry | undefined
): Pick<CircuitBreakerRegistry, 'list'> {
  return {
    list: (...args) => getLoadedRegistry()?.list(...args) ?? []
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const settingsService = new SettingsService();
  const logger = new Logger('FileMaker Data API Tools', settingsService);
  const roleGuard = new RoleGuard(logger);
  await roleGuard.applyContexts();

  // One-shot validation: surface an invalid hashAlgorithm setting as a toast.
  // The settings-service fallback to sha256 will keep working silently for
  // every other call site.
  settingsService.getSchemaHashAlgorithm((bad) => {
    void vscode.window.showWarningMessage(
      `FileMaker: schema.hashAlgorithm '${bad}' is not supported on this runtime. Falling back to sha256.`
    );
    logger.warn('Rejected unsupported schema.hashAlgorithm; falling back to sha256.', {
      configured: bad
    });
  });

  // Prime the settings reads so the deprecated-key tracker observes everything
  // before we ask for the report, then surface a one-time deprecation toast.
  settingsService.getLoggingLevel();
  settingsService.getRequestTimeoutMs();
  settingsService.getDefaultApiBasePath();
  settingsService.getDefaultApiVersionPath();
  const deprecatedKeys = settingsService.consumeDeprecatedSettingsUsed();
  if (deprecatedKeys.length > 0) {
    const newNames = deprecatedKeys.map((k) => k.replace('filemakerDataApiTools.', 'filemaker.'));
    void offerDeprecatedSettingsMigration(settingsService, deprecatedKeys, newNames, logger);
    logger.warn('Deprecated settings in use; falling back to the legacy values.', {
      deprecatedKeys,
      newNames
    });
  }

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
          ? `FileMaker: SecretStorage unavailable (${reason}); falling back to obfuscated workspace state (not protection against local access).`
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

  let loadedFmClient: FMClient | undefined;
  let fmClientLoad: Promise<FMClient> | undefined;
  const loadFmClient = (): Promise<FMClient> => {
    if (loadedFmClient) {
      return Promise.resolve(loadedFmClient);
    }

    fmClientLoad ??= import('./services/fmClient')
      .then(({ FMClient }) => {
        loadedFmClient = new FMClient(
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
        return loadedFmClient;
      })
      .catch((error) => {
        fmClientLoad = undefined;
        throw error;
      });

    return fmClientLoad;
  };
  const fmClient = createLazyFmClient(loadFmClient, () => loadedFmClient);

  let loadedCircuitBreakerRegistry: CircuitBreakerRegistry | undefined;
  let circuitBreakerRegistryLoad: Promise<CircuitBreakerRegistry> | undefined;
  const loadCircuitBreakerRegistry = (): Promise<CircuitBreakerRegistry> => {
    if (loadedCircuitBreakerRegistry) {
      return Promise.resolve(loadedCircuitBreakerRegistry);
    }

    circuitBreakerRegistryLoad ??= import('./performance/circuitBreakerRegistry')
      .then(({ CircuitBreakerRegistry }) => {
        loadedCircuitBreakerRegistry = new CircuitBreakerRegistry();
        return loadedCircuitBreakerRegistry;
      })
      .catch((error) => {
        circuitBreakerRegistryLoad = undefined;
        throw error;
      });

    return circuitBreakerRegistryLoad;
  };
  const circuitBreakerRegistry = createLazyCircuitBreakerRegistry(
    () => loadedCircuitBreakerRegistry
  );

  let loadedBatchService: BatchService | undefined;
  let batchServiceLoad: Promise<BatchService> | undefined;
  const loadBatchService = (): Promise<BatchService> => {
    if (loadedBatchService) {
      return Promise.resolve(loadedBatchService);
    }

    batchServiceLoad ??= Promise.all([
      import('./services/batchService'),
      loadCircuitBreakerRegistry()
    ])
      .then(([{ BatchService }, registry]) => {
        loadedBatchService = new BatchService(fmClient, {
          getMaxRecords: () => {
            const configured = settingsService.getBatchMaxRecords();
            return roleGuard.resolvePerformanceMode() === 'high-scale'
              ? Math.min(configured, 10_000)
              : configured;
          },
          getConcurrency: () => settingsService.getBatchConcurrency(),
          getDryRunDefault: () => settingsService.getBatchDryRunDefault(),
          getNeutralizeFormulas: () => settingsService.getNeutralizeExportFormulas(),
          getPerformanceMode: () => roleGuard.resolvePerformanceMode(),
          circuitBreakerRegistry: registry
        });
        return loadedBatchService;
      })
      .catch((error) => {
        batchServiceLoad = undefined;
        throw error;
      });

    return batchServiceLoad;
  };
  const batchService = createLazyBatchService(loadBatchService);

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
  const pluginRegistry = new PluginRegistry(profileStore, fmClient, roleGuard, logger, {
    approvalState: context.globalState
  });
  const fmWebProjectService = new FmWebProjectService(
    profileStore,
    fmClient,
    schemaService,
    logger
  );
  const fmBridgeServer = new FmBridgeServer(profileStore, fmClient, fmWebProjectService, logger, {
    getRateLimitConfig: () => settingsService.getBridgeRateLimitConfig(),
    authorizeRoute: async (route) =>
      bridgeRouteRefusal(route, vscode.workspace.getConfiguration('filemaker'), roleGuard)
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
  const layoutInspectorProvider = new LayoutInspectorProvider(profileStore, schemaService);

  const filemakerExplorerTree = vscode.window.createTreeView('filemakerExplorer', {
    treeDataProvider: fmExplorerProvider
  });
  const layoutInspectorTree = vscode.window.createTreeView('filemakerLayoutInspector', {
    treeDataProvider: layoutInspectorProvider
  });
  const layoutSelectionDisposable = filemakerExplorerTree.onDidChangeSelection((event) => {
    const layoutItem = event.selection.find(
      (item) => item.kind === 'layout' && item.profileId && item.layoutName
    );

    if (layoutItem?.profileId && layoutItem.layoutName) {
      layoutInspectorProvider.selectLayout(layoutItem.profileId, layoutItem.layoutName);
    }
  });

  // Forward-declared so refreshExplorer (called by registered command handlers)
  // can re-evaluate command-palette contexts after profile / snapshot / project
  // changes. The actual implementation is wired in below once all the stores
  // are constructed.
  let refreshPaletteContexts: () => Promise<void> = async () => {
    /* placeholder until wired below */
  };

  const refreshExplorer = (): void => {
    fmExplorerProvider.refresh();
    void refreshPaletteContexts();
  };

  // Persistent connection-state status bar — sits at priority 105 (above the
  // offline badge, below the transient connect-progress item). Created first
  // so we can hand its refresh callback to the commands registry.
  const connectionStatusBar = new ConnectionStatusBar(profileStore);

  const coreCommandDisposables = registerCoreCommands({
    context,
    profileStore,
    secretStore,
    savedQueriesStore,
    fmClient,
    logger,
    roleGuard,
    refreshExplorer,
    refreshConnectionStatus: () => connectionStatusBar.refresh(),
    onProfileDisconnected: (profileId) => {
      schemaService.invalidateProfile(profileId);
      layoutInspectorProvider.clearProfile(profileId);
    },
    onLayoutSelected: (profileId, layout) =>
      layoutInspectorProvider.selectLayout(profileId, layout),
    getConnectBackoffPolicy: () => settingsService.getConnectBackoffPolicy(),
    getConnectionWizardTestPolicy: () => settingsService.getConnectionWizardTestPolicy()
  });

  const layoutInspectorDisposables = registerLayoutInspectorCommands({
    profileStore,
    fmClient,
    layoutInspectorProvider,
    logger
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

  const aiContextDisposables = registerAiContextCommands({
    context,
    profileStore,
    fmClient,
    schemaService,
    logger
  });

  // AI tools (ADR-0004 phase 2). The core owns all policy; the controller only registers
  // language-model tools for what the core offers right now.
  const aiAudit = new AuditLog(() => auditLogPath(context.globalStorageUri.fsPath));
  const aiService = new AiToolService({
    settings: () => readAiSettings(vscode.workspace.getConfiguration('filemaker')),
    featureSwitchOn: () => isAiFeatureSwitchOn(vscode.workspace.getConfiguration('filemaker')),
    featureGuard: (feature) => roleGuard.getFeatureGuard(feature),
    isTrusted: () => vscode.workspace.isTrusted,
    isOffline: () => roleGuard.isOfflineModeEnabled(),
    getProfile: (id) => profileStore.getProfile(id),
    client: fmClient,
    schema: schemaService,
    ui: {
      confirm: async (spec) =>
        (await vscode.window.showWarningMessage(spec.message, { modal: true, detail: spec.detail }, spec.confirmLabel)) ===
        spec.confirmLabel,
      notifyCancelled: () =>
        void vscode.window.showInformationMessage(
          'An AI tool request was cancelled. Anything you approve in the dialog that is still open will not be applied.'
        ),
      input: async (spec) =>
        vscode.window.showInputBox({ title: spec.title, prompt: spec.prompt, ignoreFocusOut: true })
    },
    audit: aiAudit,
    now: () => Date.now()
  });
  const aiController = new AiToolsController(aiService, {
    lm: getLanguageModelApi(),
    setContext: (key, value) => vscode.commands.executeCommand('setContext', key, value)
  });
  // MCP transport (ADR-0004 phase 3): off unless the user setting is on; it only forwards to aiService.
  const aiMcp = new AiMcpController({
    core: aiService,
    globalStoragePath: context.globalStorageUri?.fsPath,
    extensionShimPath: context.extensionUri ? path.join(context.extensionUri.fsPath, 'dist', 'aiMcpShim.js') : undefined,
    serverInfo: { name: 'filemaker-data-api-tools', version: String(context.extension?.packageJSON?.version ?? '0') },
    isEnabled: () => isExternalServerEnabled(vscode.workspace.getConfiguration('filemaker')),
    remoteName: () => vscode.env.remoteName,
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    state: {
      get: () => context.workspaceState?.get<number>(STARTED_HERE_KEY),
      set: (value) => context.workspaceState?.update(STARTED_HERE_KEY, value)
    },
    permission: {
      epoch: () => context.globalState?.get<number>(PERMISSION_EPOCH_KEY, 0) ?? 0,
      bump: () => context.globalState?.update(PERMISSION_EPOCH_KEY, (context.globalState?.get<number>(PERMISSION_EPOCH_KEY, 0) ?? 0) + 1),
      seenEnabled: () => context.globalState?.get<boolean>(PERMISSION_SEEN_KEY),
      setSeenEnabled: (value) => context.globalState?.update(PERMISSION_SEEN_KEY, value)
    },
    log: (message) => logger.info(message),
    notify: (message) => void vscode.window.showInformationMessage(message)
  });
  const aiStatusBar = new AiStatusBar({ service: aiService, controller: aiController, profileStore }, aiMcp);
  const refreshAi = (): void => {
    aiController.refresh();
    void aiStatusBar.refresh();
  };
  const aiDisposables = [
    aiController,
    aiMcp,
    aiStatusBar,
    aiController.onDidChange(() => {
      aiMcp.notifyToolsChanged();
      void aiStatusBar.refresh();
    }),
    aiMcp.onDidChange(() => void aiStatusBar.refresh()),
    watchExternalServerSetting({
      onDidChangeConfiguration: (listener) => vscode.workspace.onDidChangeConfiguration(listener),
      controller: aiMcp,
      log: (message) => logger.warn(message)
    }),
    ...registerAiMcpCommands({
      controller: aiMcp,
      extensionPath: context.extensionUri?.fsPath ?? '',
      globalStoragePath: context.globalStorageUri?.fsPath,
      isEnabled: () => isExternalServerEnabled(vscode.workspace.getConfiguration('filemaker')),
      refresh: () => void aiStatusBar.refresh()
    }),
    ...registerAiToolCommands({
      service: aiService,
      controller: aiController,
      audit: aiAudit,
      profileStore,
      roleGuard,
      statusBar: aiStatusBar
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(refreshAi),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('filemaker.ai') ||
        event.affectsConfiguration('filemaker.features.ai') ||
        event.affectsConfiguration('filemaker.offline')
      ) {
        refreshAi();
      }
    })
  ];
  refreshAi();
  // The setting is only a permission: start only where the user started the server before.
  void aiMcp.autostart();

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
    roleGuard,
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

  let configChangeQueue: Promise<void> = Promise.resolve();
  let configChangesStopped = false;
  context.subscriptions.push(
    offlineStatusBar,
    connectionStatusBar,
    filemakerExplorerTree,
    layoutInspectorTree,
    layoutSelectionDisposable,
    ...coreCommandDisposables,
    ...layoutInspectorDisposables,
    ...savedQueryDisposables,
    ...schemaDisposables,
    ...schemaSnapshotDisposables,
    ...scriptRunnerDisposables,
    ...recordEditDisposables,
    ...typeGenDisposables,
    ...aiContextDisposables,
    ...aiDisposables,
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
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('filemaker.enterprise.mode') ||
        event.affectsConfiguration('filemaker.enterprise.role') ||
        event.affectsConfiguration('filemaker.offline.mode') ||
        event.affectsConfiguration('filemaker.performance.mode')
      ) {
        // Run one reapply at a time so overlapping changes cannot interleave
        // role contexts and plugin reloads; a failure is logged, not unhandled.
        configChangeQueue = configChangeQueue
          .then(async () => {
            if (configChangesStopped) {
              return; // the extension is shutting down; the registry may already be disposed
            }
            await roleGuard.applyContexts();
            await pluginRegistry.reload();
            refreshExplorer();
          })
          .catch((error: unknown) => {
            logger.error('Failed to apply FileMaker configuration change.', { error });
          });
      }
    }),
    new vscode.Disposable(() => {
      configChangesStopped = true;
    }),
    pluginRegistry,
    new vscode.Disposable(() => fmBridgeServer.dispose()),
    new vscode.Disposable(() => logger.dispose())
  );

  // Wire command-palette context keys now that all stores exist.
  refreshPaletteContexts = async (): Promise<void> => {
    try {
      const [profiles, snapshots, project] = await Promise.all([
        profileStore.listProfiles(),
        snapshotStore.listSnapshots().catch(() => []),
        fmWebProjectService.readProjectConfig().catch(() => undefined)
      ]);
      await Promise.all([
        vscode.commands.executeCommand('setContext', 'filemaker.hasProfiles', profiles.length > 0),
        vscode.commands.executeCommand(
          'setContext',
          'filemaker.hasSchemaSnapshots',
          snapshots.length > 0
        ),
        vscode.commands.executeCommand(
          'setContext',
          'filemaker.fmWebProjectInitialized',
          project !== undefined
        ),
        vscode.commands.executeCommand(
          'setContext',
          'filemaker.enterpriseMode',
          settingsService.isEnterpriseModeEnabled()
        ),
        vscode.commands.executeCommand(
          'setContext',
          'filemaker.powerUserMode',
          settingsService.isPowerUserModeEnabled()
        )
      ]);
    } catch (error) {
      logger.warn('Failed to refresh command-palette contexts.', { error });
    }
  };
  void refreshPaletteContexts();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('filemaker.enterprise.mode') ||
        event.affectsConfiguration('filemaker.advanced.powerUserMode')
      ) {
        void refreshPaletteContexts();
      }
    })
  );

  registerWalkthroughCommands(context, logger);
  void maybeOpenFirstRunWalkthrough(context, logger);

  logger.info('FileMaker Data API Tools activated.');
}

const WALKTHROUGH_STEP_ID = 'filemakerGettingStarted';
const FIRST_RUN_FLAG = 'filemaker.walkthrough.shownOnce';

async function offerDeprecatedSettingsMigration(
  settingsService: SettingsService,
  deprecatedKeys: string[],
  newNames: string[],
  logger: Logger
): Promise<void> {
  const plural = deprecatedKeys.length === 1 ? '' : 's';
  const choice = await vscode.window.showWarningMessage(
    `FileMaker: ${deprecatedKeys.length} deprecated setting${plural} in use (${deprecatedKeys.join(', ')}). They are now ${newNames.join(', ')}.`,
    'Migrate Settings',
    'Open Settings'
  );

  if (choice === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'filemakerDataApiTools');
    return;
  }
  if (choice !== 'Migrate Settings') {
    return;
  }

  try {
    const migrated = await settingsService.migrateDeprecatedSettings();
    void vscode.window.showInformationMessage(
      migrated.length > 0
        ? `FileMaker: migrated ${migrated.length} setting${migrated.length === 1 ? '' : 's'} to the filemaker.* names.`
        : 'FileMaker: nothing to migrate in user or workspace settings. Check folder-level settings.'
    );
  } catch (error) {
    logger.error('Failed to migrate deprecated settings.', { error });
    void vscode.window.showErrorMessage('FileMaker: could not migrate settings. Edit them in Settings instead.');
  }
}

/**
 * The fully qualified walkthrough id must match `publisher.name#stepId` exactly.
 * Computing it from context.extension.id at runtime avoids a silent break if
 * package.json publisher/name ever change (typo fix, fork, ownership transfer).
 */
function walkthroughId(context: vscode.ExtensionContext): string {
  return `${context.extension.id}#${WALKTHROUGH_STEP_ID}`;
}

function registerWalkthroughCommands(
  context: vscode.ExtensionContext,
  logger: { warn: (message: string, meta?: unknown) => void }
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('filemakerDataApiTools.openWelcomeWalkthrough', async () => {
      try {
        await vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          { category: walkthroughId(context) },
          false
        );
      } catch (error) {
        logger.warn('Failed to open getting-started walkthrough.', { error });
      }
    }),
    vscode.commands.registerCommand('filemakerDataApiTools.openUserGuide', async () => {
      try {
        const uri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'USER_GUIDE.md');
        await vscode.commands.executeCommand('markdown.showPreview', uri);
      } catch (error) {
        logger.warn('Failed to open user guide.', { error });
      }
    }),
    registerShowDiagnosticsCommand(context)
  );
}

async function maybeOpenFirstRunWalkthrough(
  context: vscode.ExtensionContext,
  logger: { info: (message: string, meta?: unknown) => void; warn: (message: string, meta?: unknown) => void }
): Promise<void> {
  if (context.globalState.get<boolean>(FIRST_RUN_FLAG, false)) {
    return;
  }
  try {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      { category: walkthroughId(context) },
      false
    );
    // Only persist the flag AFTER the walkthrough actually opens. A transient
    // failure on day one (host restart, missing markdown asset) used to flip
    // the flag and permanently suppress the walkthrough; the user would never
    // see it. Now we leave the flag off so the next activation can try again.
    await context.globalState.update(FIRST_RUN_FLAG, true);
    logger.info('First-run getting-started walkthrough opened.');
  } catch (error) {
    logger.warn('First-run walkthrough open failed; will retry next activation.', { error });
  }
}

export function deactivate(): void {
  // no-op
}
