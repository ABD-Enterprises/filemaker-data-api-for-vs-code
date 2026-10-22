export interface CertificateState {
  pin?: { sha256: string; allowExpired: boolean };
  /** The older setting that skips every certificate check. Kept readable; replaced by a pin. */
  legacy: boolean;
}

export type ConnectionWizardTestPolicy = 'off' | 'warn' | 'block';

export interface ConnectionWizardOptions {
  /** Resolved at message time so settings updates flow live. */
  getTestPolicy?: () => ConnectionWizardTestPolicy;
}

export interface WizardFormData {
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
}
