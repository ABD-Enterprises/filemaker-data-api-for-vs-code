import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
    menus: Record<string, MenuEntry[]>;
    configuration: Array<{ title: string; properties: Record<string, unknown> }>;
    walkthroughs: Array<{ steps: Array<{ id: string; media?: { markdown?: string } }> }>;
  };
}

const extensionRoot = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')) as Manifest;
const { commands, keybindings, menus, configuration, walkthroughs } = manifest.contributes;
const commandIds = new Set(commands.map((command) => command.command));
const palette = new Map((menus.commandPalette ?? []).map((entry) => [entry.command, entry.when]));
const id = (name: string): string => `filemakerDataApiTools.${name}`;

describe('extension manifest UX contract', () => {
  it('groups every command under the FileMaker category without a duplicated prefix', () => {
    for (const command of commands) {
      expect(command.category, command.command).toBe('FileMaker');
      expect(command.title, command.command).not.toMatch(/^FileMaker:/);
    }
  });

  it('gives every Command Palette entry an explicit when clause', () => {
    for (const [command, when] of palette) {
      expect(commandIds.has(command), command).toBe(true);
      expect(typeof when === 'string' && when.length > 0, command).toBe(true);
    }
  });

  it('keeps primary workflows in the palette once profiles exist', () => {
    const alwaysVisible = ['addConnectionProfile', 'openWelcomeWalkthrough', 'openUserGuide', 'showDiagnostics'];
    for (const name of alwaysVisible) {
      expect(palette.has(id(name)), name).toBe(false);
    }

    const primary = ['connect', 'disconnect', 'openQueryBuilder', 'openRecordViewer', 'openScriptRunner', 'listLayouts'];
    for (const name of primary) {
      expect(palette.get(id(name)), name).toBe('filemaker.hasProfiles');
    }
  });

  it('hides advanced diagnostics, plugin, and import-export commands behind power-user mode', () => {
    const advanced = [
      'showJobs',
      'showRequestHistory',
      'openDiagnosticsDashboard',
      'showCircuitBreakerStatus',
      'reloadPlugins',
      'listActivePlugins'
    ];
    for (const name of advanced) {
      expect(palette.get(id(name)), name).toBe('filemaker.powerUserMode');
    }
  });

  it('only references contributed commands from menus and keybindings', () => {
    for (const [menu, entries] of Object.entries(menus)) {
      for (const entry of entries) {
        expect(commandIds.has(entry.command), `${menu}: ${entry.command}`).toBe(true);
      }
    }
    for (const binding of keybindings ?? []) {
      expect(commandIds.has(binding.command), binding.command).toBe(true);
      expect(binding.mac, binding.command).toBeTruthy();
    }
  });

  it('shows at most two inline actions on any Connections tree item', () => {
    const inlineCounts = new Map<string, number>();
    for (const entry of menus['view/item/context'] ?? []) {
      if (entry.group?.startsWith('inline') && entry.when) {
        inlineCounts.set(entry.when, (inlineCounts.get(entry.when) ?? 0) + 1);
      }
    }
    for (const [when, count] of inlineCounts) {
      expect(count, when).toBeLessThanOrEqual(2);
    }
  });

  it('never binds macOS system chords such as Log Out (Shift+Option+Cmd+Q)', () => {
    const reserved = new Set(['cmd+alt+shift+q', 'cmd+shift+q', 'cmd+q', 'cmd+alt+esc', 'ctrl+cmd+q']);
    for (const binding of keybindings ?? []) {
      const mac = (binding.mac ?? binding.key).toLowerCase().split('+').sort().join('+');
      for (const chord of reserved) {
        expect(mac, binding.command).not.toBe(chord.split('+').sort().join('+'));
      }
    }
  });

  it('splits settings into titled sections without duplicates', () => {
    expect(Array.isArray(configuration)).toBe(true);
    const seen = new Set<string>();
    for (const section of configuration) {
      expect(section.title).toBeTruthy();
      for (const key of Object.keys(section.properties)) {
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });

  it('points every walkthrough step at a markdown file that exists', () => {
    for (const step of walkthroughs[0]?.steps ?? []) {
      const markdown = step.media?.markdown;
      expect(markdown, step.id).toBeTruthy();
      expect(() => readFileSync(join(extensionRoot, markdown as string)), step.id).not.toThrow();
    }
  });

  it('declares the AI context command and keeps its path setting user-scope only', () => {
    expect(commandIds.has(id('writeAiContext'))).toBe(true);
    expect(commands.find((command) => command.command === id('writeAiContext'))?.title).toBe('Write AI Context');
    expect(palette.get(id('writeAiContext'))).toBe('filemaker.hasProfiles');

    const properties = Object.assign({}, ...configuration.map((section) => section.properties)) as Record<
      string,
      { scope?: string; default?: unknown }
    >;
    // An application-scoped setting cannot come from a workspace file; the extension also
    // reads only the user value (see userScopeSetting.test.ts).
    expect(properties['filemaker.ai.contextPath']?.scope).toBe('application');
    expect(properties['filemaker.ai.contextPath']?.default).toBe('');
  });

  it('declares the external-tools commands and builds the MCP shim as part of the build', () => {
    for (const name of ['toggleAiServer', 'copyAiMcpConfig']) {
      expect(commandIds.has(id(name)), name).toBe(true);
      expect(palette.get(id(name)), name).toBe('filemaker.hasProfiles');
    }
    const scripts = (JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    // The bundle itself is defined in scripts/esbuild-config.mjs.
    expect(scripts['bundle:ai-mcp-shim']).toContain('bundle.mjs aiMcpShim');
    const config = readFileSync(join(extensionRoot, 'scripts/esbuild-config.mjs'), 'utf8');
    expect(config).toContain('src/ai/mcp/shim.ts');
    expect(config).toContain('dist/aiMcpShim.js');
    expect(scripts.build).toContain('bundle:ai-mcp-shim');
  });
});
