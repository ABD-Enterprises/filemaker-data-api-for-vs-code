import * as vscode from 'vscode';

import { isAiFeatureSwitchOn } from '../ai/aiSettings';
import {
  buildAboutFacts,
  buildIssueUrl,
  formatActivationLine,
  formatFactsMarkdown,
  readBuildInfo,
  REPO_URL,
  type AboutFact,
  type AboutInputs,
  type InstallKind
} from './aboutInfo';

const COPY = 'Copy for bug report';
const CHANGELOG = 'Open Changelog';
const REPORT = 'Report an Issue';

function installKind(mode: vscode.ExtensionMode): InstallKind {
  if (mode === vscode.ExtensionMode.Development) {
    return 'development host';
  }
  if (mode === vscode.ExtensionMode.Test) {
    return 'test host';
  }
  return 'installed';
}

/** Reads the live host values. The only part of the About feature that touches VS Code. */
export function collectAboutInputs(context: vscode.ExtensionContext): AboutInputs {
  const config = vscode.workspace.getConfiguration('filemaker');
  const build = readBuildInfo();
  const versions = process.versions as Record<string, string | undefined>;
  return {
    extensionVersion: (context.extension.packageJSON as { version?: string }).version,
    buildCommit: build.commit,
    buildDate: build.date,
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    nodeVersion: versions.node ?? '',
    electronVersion: versions.electron,
    platform: process.platform,
    arch: process.arch,
    remoteName: vscode.env.remoteName,
    workspaceTrusted: vscode.workspace.isTrusted,
    language: vscode.env.language,
    installKind: installKind(context.extensionMode),
    aiEnabled: isAiFeatureSwitchOn(config),
    enterpriseMode: config.get<boolean>('enterprise.mode', false) === true
  };
}

export function aboutFactsMarkdown(context: vscode.ExtensionContext): { facts: AboutFact[]; markdown: string } {
  const facts = buildAboutFacts(collectAboutInputs(context));
  return { facts, markdown: formatFactsMarkdown(facts) };
}

export function activationLogLine(context: vscode.ExtensionContext): string {
  return formatActivationLine(collectAboutInputs(context));
}

export function registerAboutCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('filemakerDataApiTools.about', async () => {
    const { facts, markdown } = aboutFactsMarkdown(context);
    const value = (index: number): string => facts[index]?.value ?? 'unknown';
    const headline = `${value(0)}  |  Build ${value(1)}  |  VS Code ${value(2)}`;
    const choice = await vscode.window.showInformationMessage(headline, COPY, CHANGELOG, REPORT);
    if (choice === COPY) {
      await vscode.env.clipboard.writeText(markdown);
      void vscode.window.showInformationMessage('Version details copied. Paste them into your bug report.');
    } else if (choice === CHANGELOG) {
      try {
        await vscode.commands.executeCommand(
          'markdown.showPreview',
          vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md')
        );
      } catch {
        await vscode.env.openExternal(vscode.Uri.parse(`${REPO_URL}/releases`));
      }
    } else if (choice === REPORT) {
      await vscode.env.openExternal(vscode.Uri.parse(buildIssueUrl(facts, markdown)));
    }
  });
}
