import { UNKNOWN } from './aboutInfo';

let runtimeVersion = UNKNOWN;

/** Set once at activation from the installed manifest, so no screen can show a stale number. */
export function setRuntimeVersion(version: string | undefined): void {
  runtimeVersion = version && /^[A-Za-z0-9._+-]{1,40}$/.test(version) ? version : UNKNOWN;
}

export function getRuntimeVersion(): string {
  return runtimeVersion;
}

/** The small muted footer shown at the bottom of each webview (styled by `.fm-version` in its stylesheet). */
export function versionFooterHtml(): string {
  return `<footer class="fm-version">FileMaker Data API Tools v${getRuntimeVersion()}</footer>`;
}
