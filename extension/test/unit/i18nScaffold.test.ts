import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const extensionRoot = process.cwd().endsWith(`${path.sep}extension`)
  ? process.cwd()
  : path.join(process.cwd(), 'extension');

describe('i18n scaffolding', () => {
  it('keeps generated bundles in sync', () => {
    expect(() => {
      execFileSync(process.execPath, ['scripts/extract-i18n.mjs', '--check'], {
        cwd: extensionRoot,
        stdio: 'pipe'
      });
    }).not.toThrow();
  });

  it('backs every package.json localization placeholder with package.nls.json', () => {
    const packageJson = readJson(path.join(extensionRoot, 'package.json'));
    const packageBundle = readJson(path.join(extensionRoot, 'package.nls.json'));
    const placeholders = collectPlaceholders(packageJson);

    expect(placeholders.size).toBeGreaterThan(0);
    for (const key of placeholders) {
      const value = packageBundle[key];
      expect(value, key).toEqual(expect.any(String));
      expect((value as string).length, key).toBeGreaterThan(0);
    }
  });

  it('extracts runtime localize keys for extension, commands, and webviews', () => {
    const messages = readJson(path.join(extensionRoot, 'i18n', 'messages.json'));

    expect(messages['extension.jobs.idleStatus']).toBe('$(history) FM Jobs: idle');
    expect(messages['commands.common.selectProfile.title']).toBe(
      'Select FileMaker Connection Profile'
    );
    expect(messages['webviews.queryBuilder.heading']).toBe('FileMaker Query Builder');
    expect(messages['webviews.connectionWizard.saveButton']).toBe('Save Profile');
  });
});

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function collectPlaceholders(value: unknown, keys = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const match = /^%([^%]+)%$/.exec(value);
    if (match) {
      keys.add(match[1]);
    }
    return keys;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPlaceholders(item, keys);
    }
    return keys;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectPlaceholders(item, keys);
    }
  }

  return keys;
}
