import type * as vscode from 'vscode';
import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SecretStore } from '../../services/secretStore';
import type { ConnectionProfile } from '../../types/fm';
import type { CertificateState, ConnectionWizardOptions } from './types';

/** Internal access to the panel's services and state. Modules never import the panel. */
export interface WizardContext {
  readonly panel: vscode.WebviewPanel;
  readonly profileStore: ProfileStore;
  readonly secretStore: SecretStore;
  readonly fmClient: FMClient;
  readonly logger: Logger;
  readonly options: ConnectionWizardOptions;
  editingProfile: ConnectionProfile | undefined;
  templateOrigins: Set<string>;
  certificateTarget: string | undefined;
  certState: CertificateState;
}
