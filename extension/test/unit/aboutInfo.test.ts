import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildAboutFacts,
  buildIssueUrl,
  formatActivationLine,
  formatFactsMarkdown,
  readBuildInfo,
  scrubPaths,
  type AboutInputs
} from '../../src/about/aboutInfo';
import { getRuntimeVersion, setRuntimeVersion, versionFooterHtml } from '../../src/about/runtimeVersion';

const base: AboutInputs = {
  extensionVersion: '1.4.0',
  buildCommit: 'abc123def',
  buildDate: '2026-10-18',
  vscodeVersion: '1.96.2',
  appName: 'Visual Studio Code',
  nodeVersion: '20.18.1',
  electronVersion: '32.2.6',
  platform: 'darwin',
  arch: 'arm64',
  remoteName: undefined,
  workspaceTrusted: true,
  language: 'en',
  installKind: 'installed',
  aiEnabled: false,
  enterpriseMode: true
};

const markdown = (inputs: Partial<AboutInputs> = {}): string =>
  formatFactsMarkdown(buildAboutFacts({ ...base, ...inputs }));

describe('about facts', () => {
  it('lists the version, build, host, OS, trust and policy state', () => {
    const text = markdown();
    expect(text).toContain('FileMaker Data API Tools 1.4.0');
    expect(text).toContain('abc123def (2026-10-18)');
    expect(text).toContain('1.96.2 (Visual Studio Code)');
    expect(text).toContain('Node 20.18.1, Electron 32.2.6');
    expect(text).toContain('darwin arm64');
    expect(text).toContain('none (local window)');
    expect(text).toContain('**Workspace trust:** trusted');
    expect(text).toContain('**AI tools:** off');
    expect(text).toContain('**Enterprise mode:** on');
  });

  it('reports a remote window and restricted mode', () => {
    const text = markdown({ remoteName: 'ssh-remote', workspaceTrusted: false });
    expect(text).toContain('**Remote:** ssh-remote');
    expect(text).toContain('restricted mode');
  });

  it("falls back to 'unknown' for a dev build with no build constants or version", () => {
    const text = markdown({ buildCommit: undefined, buildDate: '', extensionVersion: undefined, electronVersion: undefined });
    expect(text).toContain('FileMaker Data API Tools unknown');
    expect(text).toContain('unknown (unknown)');
    expect(text).toContain('Electron unknown');
    expect(readBuildInfo()).toEqual({ commit: 'unknown', date: 'unknown' });
  });

  it('never lets a profile name, URL, user name, token or home path through, even from hostile inputs', () => {
    const hostile = {
      ...base,
      // Extra data a careless caller might pass; the builder must ignore it.
      profileNames: ['Acme Production'],
      serverUrl: 'https://fm.acme.example/fmi/data',
      username: 'alice',
      password: 'hunter2-secret',
      workspacePath: '/Users/alice/Code/acme',
      // Hostile values in the fields that ARE read.
      remoteName: 'ssh-remote+alice@fm.acme.example token=SECRETTOKEN123 /Users/alice/Code',
      appName: 'Code /home/bob/.vscode Bearer abcdefghijklmnop',
      extensionVersion: '1.4.0 https://alice:pw@host/',
      vscodeVersion: 'C:\\Users\\carol\\AppData'
    } as AboutInputs;
    const text = formatFactsMarkdown(buildAboutFacts(hostile));
    for (const secret of [
      'Acme',
      'fm.acme.example',
      'alice',
      'hunter2',
      '/Users/',
      '/home/',
      'carol',
      'SECRETTOKEN123',
      'abcdefghijklmnop',
      'C:\\Users',
      'pw@'
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('rejects an over-long build commit instead of printing it', () => {
    expect(markdown({ buildCommit: 'a'.repeat(40) })).toContain('unknown (2026-10-18)');
  });

  it('scrubs home paths and user@host from any text', () => {
    expect(scrubPaths('/Users/alice/x /home/bob/y C:\\Users\\Carol\\z a@b.example')).toBe('~/x ~/y ~\\z <redacted>');
  });

  it('runs the finished block through redaction and path scrubbing as a last step', () => {
    const text = formatFactsMarkdown([
      { label: 'Remote', value: 'https://h/x?api_token=SECRET123 Bearer abcdefghijklmnop /Users/alice/Code' }
    ]);
    expect(text).not.toContain('SECRET123');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('alice');
  });

  it('formats one activation log line', () => {
    expect(formatActivationLine(base)).toBe('FileMaker Data API Tools v1.4.0 (abc123def) on VS Code 1.96.2, darwin-arm64');
  });
});

describe('issue URL', () => {
  const facts = buildAboutFacts(base);
  const block = formatFactsMarkdown(facts);

  it('is https, targets the bug form and encodes the block', () => {
    const url = new URL(buildIssueUrl(facts, block));
    expect(url.protocol).toBe('https:');
    expect(url.origin + url.pathname).toBe('https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('extension-version')).toBe('1.4.0');
    expect(url.searchParams.get('version-details')).toBe(block);
  });

  it('stays under the length limit by dropping the long field, then the rest', () => {
    const huge = 'x&y '.repeat(5000);
    const url = buildIssueUrl(facts, huge);
    expect(url.length).toBeLessThanOrEqual(6000);
    expect(new URL(url).searchParams.has('version-details')).toBe(false);
    expect(new URL(url).searchParams.get('extension-version')).toBe('1.4.0');
    const tiny = buildIssueUrl(facts, huge, 150);
    expect(tiny.length).toBeLessThanOrEqual(150);
    expect(new URL(tiny).searchParams.has('extension-version')).toBe(false);
  });
});

describe('runtime version', () => {
  it('shows the version in the webview footer and refuses odd values', () => {
    setRuntimeVersion('1.4.0');
    expect(getRuntimeVersion()).toBe('1.4.0');
    expect(versionFooterHtml()).toContain('FileMaker Data API Tools v1.4.0');
    setRuntimeVersion('<script>');
    expect(getRuntimeVersion()).toBe('unknown');
    setRuntimeVersion(undefined);
    expect(versionFooterHtml()).toContain('vunknown');
  });
});

describe('About manifest and wiring', () => {
  const root = join(__dirname, '..', '..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string; category: string }>; menus: { commandPalette: Array<{ command: string; when: string }> } };
  };
  const id = 'filemakerDataApiTools.about';

  it('contributes the command, shows it in the palette and registers it in code', () => {
    const command = manifest.contributes.commands.find((entry) => entry.command === id);
    expect(command).toMatchObject({ title: 'About / Show Version', category: 'FileMaker' });
    // Always available: no palette `when` entry that could hide it.
    expect(manifest.contributes.menus.commandPalette.some((entry) => entry.command === id)).toBe(false);
    expect(readFileSync(join(root, 'src/about/aboutCommand.ts'), 'utf8')).toContain(`registerCommand('${id}'`);
    expect(readFileSync(join(root, 'src/extension.ts'), 'utf8')).toContain('registerAboutCommand(context)');
  });

  it('logs the version line at activation and shows it on the explorer', () => {
    const source = readFileSync(join(root, 'src/extension.ts'), 'utf8');
    expect(source).toContain('logger.info(activationLogLine(context))');
    expect(source).toContain('filemakerExplorerTree.description');
  });

  it('injects the build constants into every bundle from the commit, not the clock', () => {
    const config = readFileSync(join(root, 'scripts/esbuild-config.mjs'), 'utf8');
    expect(config).toContain('__BUILD_COMMIT__');
    expect(config).toContain("'log', '-1', '--format=%cs'");
    expect(config).not.toMatch(/new Date|Date\.now/);
  });
});
