import { readFileSync } from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const extensionDir = path.resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8')) as {
  homepage: string;
  keywords: string[];
  author: { url: string };
  capabilities: {
    virtualWorkspaces?: { supported: unknown; description?: string };
    untrustedWorkspaces: { description: string; restrictedConfigurations: string[] };
  };
  contributes: {
    commands: Array<{ title: string }>;
    configuration: Array<{ properties: Record<string, { enum?: unknown[]; enumDescriptions?: unknown[]; scope?: string }> }>;
  };
};
const settings = Object.assign({}, ...manifest.contributes.configuration.map((section) => section.properties)) as Record<
  string,
  { enum?: unknown[]; enumDescriptions?: unknown[]; scope?: string }
>;

describe('marketplace manifest', () => {
  it('does not advertise unsupported FileMaker Cloud sign-in in search keywords', () => {
    expect(manifest.keywords).not.toContain('filemaker cloud');
  });

  it('documents every contributed command in the User Guide command reference', () => {
    const guide = readFileSync(path.join(extensionDir, 'docs/USER_GUIDE.md'), 'utf8');
    const reference = guide.split(/^## Command reference\r?\n/m)[1]?.split(/^## /m)[0] ?? '';
    const rows = reference.split(/\r?\n/).filter((line) => line.startsWith('| '))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
    for (const { title } of manifest.contributes.commands) {
      const row = rows.find(([command]) => command === title);
      expect(row, `Missing command reference row: ${title}`).toBeDefined();
      expect(row?.[1], `Missing description: ${title}`).toBeTruthy();
      expect(row?.[2], `Missing availability: ${title}`).toBeTruthy();
    }
  });

  it('links to URLs that resolve (no ?ref= query on the home page)', () => {
    expect(manifest.homepage).toBe('https://abdenterprises.com');
    expect(manifest.author.url).toBe('https://abdenterprises.com');
    expect(readFileSync(path.join(extensionDir, 'README.md'), 'utf8')).not.toContain('abdenterprises.com?ref=');
  });

  it('declares virtual and untrusted workspace support truthfully', () => {
    expect(manifest.capabilities.virtualWorkspaces?.supported).toBe(false);
    expect(manifest.capabilities.virtualWorkspaces?.description).toBeTruthy();
    expect(manifest.capabilities.untrustedWorkspaces.description).toMatch(/AI tools are not registered/);
    expect(manifest.capabilities.untrustedWorkspaces.description).toMatch(/Script Runner/);
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain('filemaker.typegen.outputDir');
  });

  it('describes every choice of every enum setting', () => {
    const missing = Object.entries(settings)
      .filter(([, setting]) => Array.isArray(setting.enum))
      .filter(([, setting]) => setting.enumDescriptions?.length !== setting.enum?.length)
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('keeps the secret-storage fallback out of workspace settings', () => {
    expect(settings['filemaker.secrets.fallback']?.scope).toBe('application');
    // The fallback is obfuscation keyed from the machine id; no user-facing text may call it encryption.
    expect(JSON.stringify(settings['filemaker.secrets.fallback'])).not.toMatch(/encrypt/i);
    expect(readFileSync(path.join(extensionDir, 'src/extension.ts'), 'utf8')).not.toMatch(/encrypted workspace state/);
  });

  it('carries the Claris trademark statement in the README', () => {
    expect(readFileSync(path.join(extensionDir, 'README.md'), 'utf8')).toContain(
      'Claris and FileMaker are trademarks of Claris International Inc., registered in the U.S. and other countries. This extension is independent and is not affiliated with or endorsed by Claris.'
    );
  });
});
