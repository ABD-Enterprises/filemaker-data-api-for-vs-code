import * as vscode from 'vscode';

import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SecretStore } from '../../services/secretStore';
import type { ConnectionProfile } from '../../types/fm';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { toRecord } from '../common/messageValidation';
import {
  isUnencryptedRemoteUrl,
  validateDatabaseName,
  validateServerUrl
} from '../../utils/jsonValidate';
import { toUserErrorMessage } from '../../utils/errorUx';
import { validateCaBundleFile } from '../../utils/tlsProfile';
import {
  loadConnectionProfileTemplate,
  PROFILE_TEMPLATE_LOCKED_FIELDS,
  PROFILE_TEMPLATE_RELATIVE_PATH
} from '../../services/profileTemplate';

export type ConnectionWizardTestPolicy = 'off' | 'warn' | 'block';

interface ConnectionWizardOptions {
  /** Resolved at message time so settings updates flow live. */
  getTestPolicy?: () => ConnectionWizardTestPolicy;
}

interface WizardFormData {
  name: string;
  authMode: 'direct' | 'proxy';
  serverUrl: string;
  database: string;
  apiBasePath: string;
  apiVersionPath: string;
  username?: string;
  password?: string;
  proxyEndpoint?: string;
  proxyApiKey?: string;
  /** Path to a PEM file of extra trusted CA certificates. Empty means none. */
  caBundlePath?: string;
  /** Accept any certificate for this connection (insecure). Asks for confirmation. */
  allowSelfSigned?: boolean;
}

const MAX_FORM_FIELD_LENGTH = 4096;

/** Checks the shape of a form sent by the page; the host never trusts it. */
function parseFormData(payload: unknown): WizardFormData | undefined {
  const value = toRecord(payload);
  if (!value) {
    return undefined;
  }

  const text = (field: string, required: boolean): string | undefined | null => {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      return required ? null : undefined;
    }
    return typeof raw === 'string' && raw.length <= MAX_FORM_FIELD_LENGTH ? raw : null;
  };

  const name = text('name', true);
  const serverUrl = text('serverUrl', true);
  const database = text('database', true);
  const apiBasePath = text('apiBasePath', true);
  const apiVersionPath = text('apiVersionPath', true);
  const username = text('username', false);
  const password = text('password', false);
  const proxyEndpoint = text('proxyEndpoint', false);
  const proxyApiKey = text('proxyApiKey', false);
  const caBundlePath = text('caBundlePath', false);
  const authMode = value.authMode;
  const rawSelfSigned = value.allowSelfSigned;

  if (
    name === null ||
    serverUrl === null ||
    database === null ||
    apiBasePath === null ||
    apiVersionPath === null ||
    username === null ||
    password === null ||
    proxyEndpoint === null ||
    proxyApiKey === null ||
    caBundlePath === null ||
    (rawSelfSigned !== undefined && typeof rawSelfSigned !== 'boolean') ||
    (authMode !== 'direct' && authMode !== 'proxy') ||
    name === undefined ||
    serverUrl === undefined ||
    database === undefined ||
    apiBasePath === undefined ||
    apiVersionPath === undefined
  ) {
    return undefined;
  }

  return {
    name,
    authMode,
    serverUrl,
    database,
    apiBasePath,
    apiVersionPath,
    username,
    password,
    proxyEndpoint,
    proxyApiKey,
    caBundlePath,
    allowSelfSigned: rawSelfSigned === true
  };
}

function originOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export class ConnectionWizardPanel {
  private static currentPanel: ConnectionWizardPanel | undefined;

  private editingProfile: ConnectionProfile | undefined;
  /** Origins that came from the workspace's profile template, not from the user. */
  private templateOrigins = new Set<string>();
  /** https origins for which the user already accepted "allow self-signed" in this panel. */
  private insecureConfirmedOrigins = new Set<string>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly secretStore: SecretStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    editingProfile?: ConnectionProfile,
    private readonly options: ConnectionWizardOptions = {}
  ) {
    this.editingProfile = editingProfile;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      ConnectionWizardPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    secretStore: SecretStore,
    fmClient: FMClient,
    logger: Logger,
    editingProfile?: ConnectionProfile,
    options: ConnectionWizardOptions = {}
  ): void {
    if (ConnectionWizardPanel.currentPanel) {
      ConnectionWizardPanel.currentPanel.editingProfile = editingProfile;
      ConnectionWizardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      void ConnectionWizardPanel.currentPanel.sendLoadProfile();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerConnectionWizard',
      editingProfile ? `Edit Profile — ${editingProfile.name}` : 'Add Connection Profile',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'connectionWizard', 'ui')
        ]
      }
    );

    ConnectionWizardPanel.currentPanel = new ConnectionWizardPanel(
      panel,
      context,
      profileStore,
      secretStore,
      fmClient,
      logger,
      editingProfile,
      options
    );
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const record = toRecord(raw);
    if (!record) {
      return;
    }

    switch (record.type) {
      case 'ready':
        await this.sendInit();
        await this.sendLoadProfile();
        break;
      case 'save': {
        const data = parseFormData(record.payload);
        if (!data) {
          await this.panel.webview.postMessage({ type: 'saveError', message: 'The form data was not valid.' });
          return;
        }
        await this.handleSave(data);
        break;
      }
      case 'testConnection': {
        const data = parseFormData(record.payload);
        if (!data) {
          await this.panel.webview.postMessage({ type: 'testError', message: 'The form data was not valid.' });
          return;
        }
        await this.handleTestConnection(data);
        break;
      }
      default:
        break;
    }
  }

  private async sendInit(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'init',
      testPolicy: this.options.getTestPolicy?.() ?? 'warn'
    });
  }

  private async sendLoadProfile(): Promise<void> {
    this.templateOrigins.clear();
    if (this.editingProfile) {
      await this.panel.webview.postMessage({
        type: 'loadProfile',
        payload: this.editingProfile
      });
      return;
    }

    const result = await loadConnectionProfileTemplate();
    if (result.warning) {
      this.logger.warn('Profile template ignored.', {
        sourcePath: result.sourcePath,
        message: result.warning
      });
      await this.panel.webview.postMessage({
        type: 'templateWarning',
        message: result.warning
      });
      return;
    }

    if (result.template) {
      for (const origin of [originOf(result.template.serverUrl), originOf(result.template.proxyEndpoint)]) {
        if (origin) {
          this.templateOrigins.add(origin);
        }
      }
      await this.panel.webview.postMessage({
        type: 'loadTemplate',
        payload: {
          template: result.template,
          sourcePath: result.sourcePath,
          hosts: [...this.templateOrigins],
          lockedFields: result.template.locked ? PROFILE_TEMPLATE_LOCKED_FIELDS : []
        }
      });
    }
  }

  private async handleSave(data: WizardFormData): Promise<void> {
    try {
      const serverValidation = validateServerUrl(data.serverUrl);
      if (!serverValidation.ok) {
        await this.panel.webview.postMessage({
          type: 'saveError',
          message: serverValidation.error ?? 'Invalid server URL.'
        });
        return;
      }

      const dbValidation = validateDatabaseName(data.database);
      if (!dbValidation.ok) {
        await this.panel.webview.postMessage({
          type: 'saveError',
          message: dbValidation.error ?? 'Invalid database name.'
        });
        return;
      }

      let proxyEndpoint: string | undefined;
      if (data.authMode === 'proxy') {
        const proxyValidation = validateServerUrl(data.proxyEndpoint ?? '', 'Proxy endpoint');
        if (!proxyValidation.ok) {
          await this.panel.webview.postMessage({
            type: 'saveError',
            message: proxyValidation.error ?? 'Invalid proxy endpoint.'
          });
          return;
        }
        proxyEndpoint = proxyValidation.value;
      }

      // In proxy mode the key goes to the proxy, which then talks to serverUrl: check both.
      const target = data.authMode === 'proxy' ? proxyEndpoint : serverValidation.value;
      if (!(await this.confirmCredentialTargets([target, serverValidation.value]))) {
        await this.panel.webview.postMessage({
          type: 'saveError',
          message: 'Not saved: you did not confirm the server address.'
        });
        return;
      }

      const tls = await this.resolveTlsSettings(data, [target, serverValidation.value]);
      if (!tls.ok) {
        await this.panel.webview.postMessage({ type: 'saveError', message: tls.message });
        return;
      }

      const typedSecret = data.authMode === 'direct' ? data.password : data.proxyApiKey;
      const bindingChanged = this.credentialBindingChanged(
        data.authMode,
        data.authMode === 'direct' ? serverValidation.value : proxyEndpoint,
        data.username,
        serverValidation.value
      );
      if (bindingChanged && !(typedSecret && typedSecret.length > 0)) {
        await this.panel.webview.postMessage({
          type: 'saveError',
          message:
            data.authMode === 'direct'
              ? 'The server address or user name changed. Enter the password again so the saved one is not sent to a different server.'
              : 'The proxy address changed. Enter the proxy API key again so the saved one is not sent to a different server.'
        });
        return;
      }

      const profile: ConnectionProfile = {
        id: this.editingProfile?.id ?? crypto.randomUUID(),
        name: data.name.trim(),
        authMode: data.authMode,
        serverUrl: serverValidation.value!,
        database: dbValidation.value!,
        apiBasePath: data.apiBasePath.trim(),
        apiVersionPath: data.apiVersionPath.trim()
      };
      if (tls.caBundlePath) {
        profile.caBundlePath = tls.caBundlePath;
      }
      if (tls.allowSelfSigned) {
        profile.allowSelfSigned = true;
      }
      // Editing must not silently drop what AI tools were allowed to do, unless the profile now
      // points at a different server, user, database or API path (then the earlier choice no
      // longer applies and access goes back to none).
      if (
        this.editingProfile?.aiAccess &&
        !bindingChanged &&
        !this.dataTargetChanged(this.editingProfile, profile)
      ) {
        profile.aiAccess = this.editingProfile.aiAccess;
      }

      if (data.authMode === 'direct') {
        profile.username = data.username?.trim();
      } else {
        profile.proxyEndpoint = proxyEndpoint;
      }

      if (bindingChanged) {
        // A session token belongs to the server it was issued by. Drop it before the profile
        // points somewhere else, so no request can pair the old token with the new address.
        await this.secretStore.deleteSessionToken(profile.id);
      }

      await this.profileStore.upsertProfile(profile);

      if (data.authMode === 'direct') {
        if (data.password && data.password.length > 0) {
          await this.secretStore.setPassword(profile.id, data.password);
        }
        await this.secretStore.deleteProxyApiKey(profile.id);
      } else {
        if (data.proxyApiKey && data.proxyApiKey.length > 0) {
          await this.secretStore.setProxyApiKey(profile.id, data.proxyApiKey);
        }
        await this.secretStore.deletePassword(profile.id);
      }

      const isNewProfile = !this.editingProfile;
      this.editingProfile = profile;

      await this.panel.webview.postMessage({
        type: 'saveSuccess',
        message: `Profile "${profile.name}" saved.`
      });

      // Close the gap between "saved" and "connected": the natural next step
      // after creating a profile is to open a session, but until now the user
      // had to discover and run FileMaker: Connect themselves. Offer it inline
      // as a native toast action so first-run onboarding flows straight through.
      void this.offerConnect(profile, isNewProfile);
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'saveError',
        message: toUserErrorMessage(error, 'Failed to save profile.')
      });
    }
  }

  /**
   * Surface a "Connect Now" toast after a save so the user can open a session
   * without hunting for the command. The connect command resolves the profile
   * from the `{ profileId }` arg, so we hand it the freshly-saved id directly.
   * Failures here are non-fatal — the profile is already persisted and the user
   * can connect later from the sidebar or Command Palette.
   */
  private async offerConnect(
    profile: ConnectionProfile,
    isNewProfile: boolean
  ): Promise<void> {
    try {
      const prompt = isNewProfile
        ? `Profile "${profile.name}" saved. Connect now to start a session?`
        : `Profile "${profile.name}" updated. Reconnect now?`;
      const choice = await vscode.window.showInformationMessage(
        prompt,
        'Connect Now'
      );
      if (choice === 'Connect Now') {
        await vscode.commands.executeCommand('filemakerDataApiTools.connect', {
          profileId: profile.id
        });
      }
    } catch (error) {
      this.logger.warn('Failed to offer post-save connect.', { error });
    }
  }

  private async postTestProgress(phase: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'testProgress', phase });
  }

  /**
   * True when the saved credentials of the profile being edited would now go to a different
   * server or user than the ones they were saved for.
   */
  private credentialBindingChanged(
    authMode: 'direct' | 'proxy',
    target: string | undefined,
    username: string | undefined,
    backend: string | undefined
  ): boolean {
    const editing = this.editingProfile;
    if (!editing) {
      return false;
    }

    const before = {
      authMode: editing.authMode,
      origin: originOf(editing.authMode === 'proxy' ? editing.proxyEndpoint : editing.serverUrl),
      backend: originOf(editing.serverUrl),
      username: editing.authMode === 'direct' ? (editing.username ?? '').trim() : ''
    };
    const after = {
      authMode,
      origin: originOf(target),
      backend: originOf(backend),
      username: authMode === 'direct' ? (username ?? '').trim() : ''
    };
    return (
      before.authMode !== after.authMode ||
      before.origin !== after.origin ||
      before.backend !== after.backend ||
      before.username !== after.username
    );
  }

  /** The database or API path (not only the address and user) decides what AI tools could reach. */
  private dataTargetChanged(before: ConnectionProfile, after: ConnectionProfile): boolean {
    const norm = (value: string | undefined, fallback: string): string => (value ?? '').trim() || fallback;
    return (
      before.database.trim() !== after.database.trim() ||
      norm(before.apiBasePath, '/fmi/data') !== norm(after.apiBasePath, '/fmi/data') ||
      norm(before.apiVersionPath, 'vLatest') !== norm(after.apiVersionPath, 'vLatest')
    );
  }

  private async isKnownOrigin(origin: string): Promise<boolean> {
    const profiles = await this.profileStore.listProfiles();
    return profiles.some(
      (profile) => originOf(profile.serverUrl) === origin || originOf(profile.proxyEndpoint) === origin
    );
  }

  /**
   * Credentials are about to be stored for, or sent to, this address. Ask first when the
   * address came from the workspace rather than from the user, or when it is a remote
   * http:// address that would carry them unencrypted.
   */
  private async confirmCredentialTargets(targets: Array<string | undefined>): Promise<boolean> {
    for (const target of new Set(targets)) {
      if (!(await this.confirmCredentialTarget(target))) {
        return false;
      }
    }
    return true;
  }

  private async confirmCredentialTarget(target: string | undefined): Promise<boolean> {
    const origin = originOf(target);
    if (!target || !origin) {
      return true;
    }

    if (this.templateOrigins.has(origin) && !(await this.isKnownOrigin(origin))) {
      const answer = await vscode.window.showWarningMessage(
        `Your credentials would go to ${origin}.\n\nThis address came from the workspace file ${PROFILE_TEMPLATE_RELATIVE_PATH}, not from you. Only continue if you trust this server.`,
        { modal: true },
        'Continue'
      );
      if (answer !== 'Continue') {
        return false;
      }
    }

    if (isUnencryptedRemoteUrl(target)) {
      const answer = await vscode.window.showWarningMessage(
        `${origin} uses unencrypted http://.\n\nYour password or API key would be sent in clear text and could be read on the network.`,
        { modal: true },
        'Continue anyway'
      );
      if (answer !== 'Continue anyway') {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks the certificate options from the form. The custom CA file must be a real PEM
   * certificate file. "Allow self-signed" is insecure, so enabling it asks once in a modal
   * naming the address (not again for the same address, whether on this profile already or
   * confirmed earlier in this panel). It only applies to https addresses (on an http:// address the form says so instead of ignoring the box). These two values
   * come from this form alone: neither the workspace's profile template nor any setting
   * can carry them.
   */
  private async resolveTlsSettings(
    data: WizardFormData,
    targets: Array<string | undefined>
  ): Promise<
    | { ok: true; caBundlePath?: string; allowSelfSigned: boolean }
    | { ok: false; message: string }
  > {
    let caBundlePath: string | undefined;
    if (data.caBundlePath && data.caBundlePath.trim().length > 0) {
      const validation = await validateCaBundleFile(data.caBundlePath);
      if (!validation.ok) {
        return { ok: false, message: validation.error ?? 'Invalid CA certificate file.' };
      }
      caBundlePath = validation.value;
    }

    const httpsOrigins = [
      ...new Set(
        targets
          .filter((target): target is string => Boolean(target) && target!.startsWith('https:'))
          .map((target) => originOf(target))
          .filter((origin): origin is string => Boolean(origin))
      )
    ];
    if (data.allowSelfSigned === true && httpsOrigins.length === 0) {
      return {
        ok: false,
        message:
          '"Allow self-signed certificate" only applies to https:// addresses. Untick it, or use an https:// server address.'
      };
    }
    if (data.allowSelfSigned !== true) {
      return { ok: true, caBundlePath, allowSelfSigned: false };
    }

    const editing = this.editingProfile;
    const savedOrigins = new Set(
      editing?.allowSelfSigned === true
        ? [originOf(editing.serverUrl), originOf(editing.proxyEndpoint)].filter((origin): origin is string =>
            Boolean(origin)
          )
        : []
    );
    const unconfirmed = httpsOrigins.filter(
      (origin) => !savedOrigins.has(origin) && !this.insecureConfirmedOrigins.has(origin)
    );
    if (unconfirmed.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Accept any certificate from ${unconfirmed.join(' and ')}?\n\nThis turns off certificate checking for this connection. Anyone on the network between you and the server could pretend to be it and read your password and data. Prefer "Custom CA certificate file", and only continue on a network you control.`,
        { modal: true },
        'Allow insecure connection'
      );
      if (answer !== 'Allow insecure connection') {
        return { ok: false, message: 'Not saved: you did not confirm accepting self-signed certificates.' };
      }
      unconfirmed.forEach((origin) => this.insecureConfirmedOrigins.add(origin));
    }

    return { ok: true, caBundlePath, allowSelfSigned: true };
  }

  private async handleTestConnection(data: WizardFormData): Promise<void> {
    const timeoutMs = vscode.workspace
      .getConfiguration('filemaker')
      .get<number>('requestTimeoutMs', 15_000);
    await this.panel.webview.postMessage({ type: 'testStarted', timeoutMs });

    // The test runs under a throwaway id with throwaway secrets, so it can never
    // read, overwrite or clear what is saved for a real profile.
    const testId = `test-connection-${crypto.randomUUID()}`;

    try {
      const serverValidation = validateServerUrl(data.serverUrl);
      if (!serverValidation.ok) {
        throw new Error(serverValidation.error ?? 'Invalid server URL.');
      }
      const dbValidation = validateDatabaseName(data.database);
      if (!dbValidation.ok) {
        throw new Error(dbValidation.error ?? 'Invalid database name.');
      }

      let proxyEndpoint: string | undefined;
      if (data.authMode === 'proxy') {
        const proxyValidation = validateServerUrl(data.proxyEndpoint ?? '', 'Proxy endpoint');
        if (!proxyValidation.ok) {
          throw new Error(proxyValidation.error ?? 'Invalid proxy endpoint.');
        }
        proxyEndpoint = proxyValidation.value;
      }

      const target = data.authMode === 'proxy' ? proxyEndpoint : serverValidation.value;
      if (!(await this.confirmCredentialTargets([target, serverValidation.value]))) {
        throw new Error('Test cancelled: you did not confirm the server address.');
      }

      const tls = await this.resolveTlsSettings(data, [target, serverValidation.value]);
      if (!tls.ok) {
        throw new Error(tls.message);
      }

      const tempProfile: ConnectionProfile = {
        id: testId,
        name: data.name.trim(),
        authMode: data.authMode,
        serverUrl: serverValidation.value!,
        database: dbValidation.value!,
        apiBasePath: data.apiBasePath.trim(),
        apiVersionPath: data.apiVersionPath.trim()
      };
      if (tls.caBundlePath) {
        tempProfile.caBundlePath = tls.caBundlePath;
      }
      if (tls.allowSelfSigned) {
        tempProfile.allowSelfSigned = true;
      }

      await this.postTestProgress('Preparing credentials…');
      const typedSecret = data.authMode === 'direct' ? data.password : data.proxyApiKey;
      const bindingChanged = this.credentialBindingChanged(
        data.authMode,
        target,
        data.username,
        serverValidation.value
      );
      let secret = typedSecret && typedSecret.length > 0 ? typedSecret : undefined;
      if (!secret && this.editingProfile && !bindingChanged) {
        // Unchanged server and user: the saved secret may be used for the test.
        secret =
          data.authMode === 'direct'
            ? await this.secretStore.getPassword(this.editingProfile.id)
            : await this.secretStore.getProxyApiKey(this.editingProfile.id);
      }
      if (!secret) {
        throw new Error(
          bindingChanged
            ? 'The server address or user changed. Enter the password (or API key) again to test it.'
            : data.authMode === 'direct'
              ? 'Enter a password to test the connection.'
              : 'Enter the proxy API key to test the connection.'
        );
      }

      if (data.authMode === 'direct') {
        tempProfile.username = data.username?.trim();
        await this.secretStore.setPassword(testId, secret);
      } else {
        tempProfile.proxyEndpoint = proxyEndpoint;
        await this.secretStore.setProxyApiKey(testId, secret);
      }

      await this.postTestProgress('Opening session…');
      await this.fmClient.createSession(tempProfile);

      await this.postTestProgress('Cleaning up…');
      await this.fmClient.deleteSession(tempProfile);

      await this.panel.webview.postMessage({
        type: 'testSuccess',
        message: 'Connection successful. Session opened and closed cleanly.'
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'testError',
        message: toUserErrorMessage(error, 'Connection test failed.')
      });
    } finally {
      try {
        await this.secretStore.deletePassword(testId);
        await this.secretStore.deleteProxyApiKey(testId);
        await this.secretStore.deleteSessionToken(testId);
      } catch (error) {
        this.logger.warn('Could not remove temporary test credentials.', { error });
      }
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = createNonce();
    const uiBase = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webviews',
      'connectionWizard',
      'ui'
    );
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'index.js'));
    const csp = buildWebviewCsp(webview, { nonce });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Connection Profile</title>
</head>
<body>
  <!--
    Wrapping <form id="wizardForm"> is load-bearing: the UI script
    (connectionWizard/ui/index.js) installs delegated input/change listeners
    on it to drive the "test result is stale" badge. Every nested <button>
    has type="button" so this never submits. Removing the form here would
    silently regress the badge state machine (the script would null-deref
    on document.getElementById('wizardForm')).
  -->
  <form id="wizardForm" class="container">
    <h1>Connection Profile</h1>
    <p class="subtitle">Configure a connection to your FileMaker Server.</p>

    <div class="form-section">
      <h2>Profile</h2>
      <div class="field">
        <label for="profileName">Profile Name <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="profileName" type="text" required aria-required="true"
               placeholder="e.g. Production Server" />
      </div>
    </div>

    <div class="form-section">
      <h2 id="auth-mode-heading">Authentication Mode</h2>
      <div class="mode-toggle" role="group" aria-labelledby="auth-mode-heading">
        <button type="button" id="modeDirectBtn" aria-pressed="true">Direct</button>
        <button type="button" id="modeProxyBtn" aria-pressed="false">Proxy</button>
      </div>
      <p class="hint" style="margin-top: -8px;">
        <strong>Direct</strong> connects to FileMaker Data API directly.
        <strong>Proxy</strong> connects through your middleware endpoint.
      </p>
    </div>

    <div class="form-section">
      <h2>Server</h2>
      <div class="field">
        <label for="serverUrl">Server URL <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="serverUrl" type="url" required aria-required="true"
               aria-describedby="serverUrl-hint"
               placeholder="https://fm.yourcompany.com" />
        <div id="serverUrl-hint" class="hint">The HTTPS address of your FileMaker Server.</div>
      </div>
      <div class="field">
        <label for="database">Database Name <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="database" type="text" required aria-required="true"
               aria-describedby="database-hint"
               placeholder="MyDatabase" />
        <div id="database-hint" class="hint">The hosted FileMaker database file name.</div>
      </div>
      <!--
        API Base Path and API Version are correct out of the box for 99% of
        servers. Surfacing them as top-level inputs makes new users second-
        guess whether they need to configure them, and they account for a
        chunk of "I don't know what to fill in" friction in the wizard.
        Hidden behind <details> so the defaults stay populated but the visual
        weight goes to fields that actually matter on first save.
      -->
      <details class="advanced-toggle">
        <summary>Advanced server options</summary>
        <div class="field">
          <label for="apiBasePath">API Base Path</label>
          <input id="apiBasePath" type="text" value="/fmi/data"
                 aria-describedby="apiBasePath-hint" />
          <div id="apiBasePath-hint" class="hint">Usually <code>/fmi/data</code>. Change only if your server uses a custom path.</div>
        </div>
        <div class="field">
          <label for="apiVersionPath">API Version</label>
          <input id="apiVersionPath" type="text" value="vLatest"
                 aria-describedby="apiVersionPath-hint" />
          <div id="apiVersionPath-hint" class="hint">Usually <code>vLatest</code>.</div>
        </div>
      </details>
    </div>

    <div class="form-section">
      <details class="advanced-toggle" id="certificateOptions">
        <summary>Certificates (advanced)</summary>
        <div class="field">
          <label for="caBundlePath">Custom CA certificate file</label>
          <input id="caBundlePath" type="text" autocomplete="off"
                 aria-describedby="caBundlePath-hint"
                 placeholder="/path/to/company-ca.pem" />
          <div id="caBundlePath-hint" class="hint">Optional. Absolute path to a PEM file with the certificate authority that signed your server's certificate. It is added to the system's trusted certificates, so public servers still work. This is the safe way to trust a private server.</div>
        </div>
        <div class="field insecure-field">
          <label class="checkbox-label" for="allowSelfSigned">
            <input id="allowSelfSigned" type="checkbox" aria-describedby="allowSelfSigned-hint" />
            Allow self-signed certificate (insecure)
          </label>
          <div id="allowSelfSigned-hint" class="hint warning-hint">Warning: this turns off certificate checking for this connection, so anyone on the network could impersonate the server and read your password and data. Use it only on a network you control; you will be asked to confirm. It applies to this profile only.</div>
        </div>
      </details>
    </div>

    <div id="directFields" class="form-section direct-fields">
      <h2>Credentials</h2>
      <div class="field">
        <label for="username">Username <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="username" type="text" required aria-required="true"
               aria-describedby="username-hint"
               placeholder="api_user" autocomplete="username" />
        <div id="username-hint" class="hint">The FileMaker account with fmrest privilege.</div>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password"
               aria-describedby="password-hint"
               autocomplete="current-password" />
        <div id="password-hint" class="hint">Stored securely in VS Code SecretStorage. Never written to disk.</div>
      </div>
    </div>

    <div id="proxyFields" class="form-section proxy-fields">
      <h2>Proxy Settings</h2>
      <div class="field">
        <label for="proxyEndpoint">Proxy Endpoint <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="proxyEndpoint" type="url" required aria-required="true"
               aria-describedby="proxyEndpoint-hint"
               placeholder="https://api.yourcompany.com/fm-proxy" />
        <div id="proxyEndpoint-hint" class="hint">Your middleware endpoint URL.</div>
      </div>
      <div class="field">
        <label for="proxyApiKey">API Key (optional)</label>
        <input id="proxyApiKey" type="password" autocomplete="off"
               aria-describedby="proxyApiKey-hint" />
        <div id="proxyApiKey-hint" class="hint">Sent as a Bearer token to your proxy. Stored securely.</div>
      </div>
    </div>

    <div class="actions">
      <button type="button" id="saveBtn" class="primary">Save Profile</button>
      <button type="button" id="testBtn" class="secondary">Test Connection</button>
    </div>

    <div id="status" class="status" role="status" aria-live="polite"></div>
  </form>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
