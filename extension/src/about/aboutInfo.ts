import { redactString } from '../utils/redact';

export const REPO_URL = 'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code';
export const UNKNOWN = 'unknown';

/** Keeps the whole new-issue URL well under what browsers and GitHub accept. */
export const MAX_ISSUE_URL_LENGTH = 6000;

export interface BuildInfo {
  commit: string;
  date: string;
}

/** The commit and commit date embedded at build time; 'unknown' for a dev build or a build outside git. */
export function readBuildInfo(): BuildInfo {
  const commit = typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__ ? __BUILD_COMMIT__ : UNKNOWN;
  const date = typeof __BUILD_DATE__ === 'string' && __BUILD_DATE__ ? __BUILD_DATE__ : UNKNOWN;
  return { commit, date };
}

export type InstallKind = 'installed' | 'development host' | 'test host';

export interface AboutInputs {
  extensionVersion: string | undefined;
  buildCommit: string | undefined;
  buildDate: string | undefined;
  vscodeVersion: string;
  appName: string;
  nodeVersion: string;
  electronVersion: string | undefined;
  platform: string;
  arch: string;
  remoteName: string | undefined;
  workspaceTrusted: boolean;
  language: string;
  installKind: InstallKind;
  aiEnabled: boolean;
  enterpriseMode: boolean;
}

export interface AboutFact {
  label: string;
  value: string;
}

/** A value that must be one short, harmless token: no spaces, paths or credentials survive. */
function token(value: string | undefined, max = 40): string {
  const text = (value ?? '').trim();
  if (!text) {
    return UNKNOWN;
  }
  return /^[A-Za-z0-9._+-]+$/.test(text) && text.length <= max ? text : UNKNOWN;
}

/** Free text from the host (app name, remote name): cleaned of paths and secrets, then bounded. */
function text(value: string | undefined, max = 60): string {
  return scrubPaths(redactString((value ?? '').replace(/[\r\n|`]+/g, ' ').trim())).slice(0, max) || UNKNOWN;
}

/** Replaces a user's home directory (and a bare `user@`) in any text with `~`. */
export function scrubPaths(input: string): string {
  return input
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '~')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
    .replace(/\b[\w.-]+@[\w.-]+/g, '<redacted>');
}

/**
 * The facts for the About screen and bug reports. Pure: everything comes in as an argument and
 * only an allowlist of non-sensitive fields comes out, so a profile name, server address, user
 * name or path cannot reach the block even if the caller passes extra data.
 */
export function buildAboutFacts(inputs: AboutInputs): AboutFact[] {
  const remote = inputs.remoteName ? text(inputs.remoteName, 30) : 'none (local window)';
  return [
    { label: 'Extension', value: `FileMaker Data API Tools ${token(inputs.extensionVersion)}` },
    { label: 'Build', value: `${token(inputs.buildCommit, 12)} (${token(inputs.buildDate, 30)})` },
    { label: 'VS Code', value: `${token(inputs.vscodeVersion)} (${text(inputs.appName, 30)})` },
    {
      label: 'Extension host',
      value: `Node ${token(inputs.nodeVersion)}, Electron ${token(inputs.electronVersion)}`
    },
    { label: 'OS', value: `${token(inputs.platform)} ${token(inputs.arch)}` },
    { label: 'Remote', value: remote },
    { label: 'Workspace trust', value: inputs.workspaceTrusted ? 'trusted' : 'restricted mode' },
    { label: 'UI language', value: token(inputs.language, 20) },
    { label: 'Install', value: inputs.installKind },
    { label: 'AI tools', value: inputs.aiEnabled ? 'on' : 'off' },
    { label: 'Enterprise mode', value: inputs.enterpriseMode ? 'on' : 'off' }
  ];
}

/** The compact Markdown block pasted into a bug report. Passed through the redaction helper last. */
export function formatFactsMarkdown(facts: AboutFact[]): string {
  const lines = facts.map((fact) => `- **${fact.label}:** ${fact.value}`);
  return redactString(scrubPaths(['**FileMaker Data API Tools: version details**', ...lines].join('\n')));
}

/** One line for the Output channel at activation. */
export function formatActivationLine(inputs: AboutInputs): string {
  return redactString(
    scrubPaths(
      `FileMaker Data API Tools v${token(inputs.extensionVersion)} (${token(inputs.buildCommit, 12)}) ` +
        `on VS Code ${token(inputs.vscodeVersion)}, ${token(inputs.platform)}-${token(inputs.arch)}`
    )
  );
}

/** Tooltip suffix for the status bar item and similar short labels. */
export function versionLabel(version: string | undefined): string {
  return `v${token(version)}`;
}

/**
 * A GitHub new-issue URL for the bug-report form. A form template prefills by field id (a
 * free-form `body` is ignored), so the facts go into `extension-version`, `vscode-version`,
 * `operating-system` and the `version-details` textarea. https only; the optional long field is
 * dropped first, then everything but the template, when the URL would be too long.
 */
export function buildIssueUrl(facts: AboutFact[], markdown: string, maxLength = MAX_ISSUE_URL_LENGTH): string {
  const pick = (label: string): string => facts.find((fact) => fact.label === label)?.value ?? UNKNOWN;
  const base = `${REPO_URL}/issues/new`;
  const build = (fields: Array<[string, string]>): string =>
    `${base}?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
  const core: Array<[string, string]> = [
    ['template', 'bug_report.yml'],
    ['extension-version', pick('Extension').replace('FileMaker Data API Tools ', '')],
    ['vscode-version', pick('VS Code')],
    ['operating-system', pick('OS')]
  ];
  let url = build([...core, ['version-details', markdown]]);
  if (url.length > maxLength) {
    url = build(core);
  }
  if (url.length > maxLength) {
    url = build([['template', 'bug_report.yml']]);
  }
  return url;
}
