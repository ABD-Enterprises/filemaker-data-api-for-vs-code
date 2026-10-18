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

  it('reports the AI flag on and off, and enterprise mode off', () => {
    expect(markdown({ aiEnabled: true })).toContain('**AI tools:** on');
    expect(markdown({ aiEnabled: false })).toContain('**AI tools:** off');
    expect(markdown({ enterpriseMode: false })).toContain('**Enterprise mode:** off');
    expect(markdown({ enterpriseMode: true })).toContain('**Enterprise mode:** on');
    // The two flags are independent of each other.
    const both = markdown({ aiEnabled: true, enterpriseMode: false });
    expect(both).toContain('**AI tools:** on');
    expect(both).toContain('**Enterprise mode:** off');
  });

  it('reports a remote window and restricted mode', () => {
    const text = markdown({ remoteName: 'ssh-remote', workspaceTrusted: false });
    expect(text).toContain('**Remote:** ssh-remote');
    for (const kind of ['wsl', 'codespaces', 'dev-container', 'tunnel', 'attached-container']) {
      expect(markdown({ remoteName: kind })).toContain(`**Remote:** ${kind}`);
    }
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

  it('scrubs a Windows profile folder with a space, UNC shares, /root and temp folders', () => {
    expect(scrubPaths('C:\\Users\\John Smith\\x')).toBe('~\\x');
    expect(scrubPaths('c:/Users/John Smith/x')).toBe('~/x');
    expect(scrubPaths('\\\\fileserver\\home\\jsmith\\doc')).toBe('~');
    expect(scrubPaths('/root/.vscode and /root')).toBe('~/.vscode and ~');
    expect(scrubPaths('/var/folders/ab/cdef12/T/x')).toBe('~');
    expect(scrubPaths('/private/var/folders/ab/cdef12/T/x')).toBe('~');
    expect(scrubPaths('/Users/Jane Doe/Code')).toBe('~/Code');
  });

  it('accepts only plain names for the app and remote, never free text', () => {
    for (const hostile of ['a|b', 'line\nbreak', 'x`y', 'ssh-remote+alice@host', '/Users/alice', 'k=v', 'C:\\Users\\a', 'x'.repeat(80)]) {
      const text = markdown({ appName: hostile, remoteName: hostile });
      expect(text, hostile).toContain('**Remote:** unknown');
      expect(text, hostile).toContain('(unknown)');
      expect(text, hostile).not.toContain('alice');
    }
    expect(markdown({ appName: 'Visual Studio Code - Insiders' })).toContain('(Visual Studio Code - Insiders)');
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

/** What VS Code's opener does to a URL: Uri.parse decodes the query, the open re-encodes with encodeURI. */
const replayOpener = (url: string): string => {
  const [head, query = ''] = url.split('?');
  return encodeURI(`${head}?${decodeURIComponent(query)}`);
};

describe('issue URL', () => {
  it('survives the VS Code opener round trip with every field intact', () => {
    const hostileFacts = buildAboutFacts({
      ...base,
      extensionVersion: '1.4.0+build.5',
      vscodeVersion: '1.96.2',
      platform: 'a&b#c=d+e',
    });
    const block = formatFactsMarkdown(hostileFacts) + '\nA&B #1 C=D 1+1 100% done';
    const sent = new URL(buildIssueUrl(hostileFacts, block));
    const replayed = new URL(replayOpener(buildIssueUrl(hostileFacts, block)));
    expect([...replayed.searchParams.keys()]).toEqual([...sent.searchParams.keys()]);
    for (const [key, value] of sent.searchParams) {
      expect(replayed.searchParams.get(key), key).toBe(value);
    }
    expect(replayed.hash).toBe('');
    expect(sent.searchParams.get('version-details')).toContain('A_B _1 C_D 1_1 100% done');
    expect(sent.searchParams.get('extension-version')).toBe('1.4.0_build.5');
  });

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
