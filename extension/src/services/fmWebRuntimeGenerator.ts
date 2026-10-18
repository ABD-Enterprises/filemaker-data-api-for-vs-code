import { createHash } from 'crypto';
import { access, chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import path from 'path';

import type * as vscode from 'vscode';

import { migrateLayoutDefinition } from '../fmweb/layoutSchema';
import type { Logger } from './logger';
import type { FmWebProjectService } from './fmWebProjectService';

interface TemplateCopySummary {
  created: string[];
  skipped: string[];
  /** Managed files that were refreshed from an older template version. */
  updated: string[];
  /** Managed files left alone because they were edited; the preview may not work until updated. */
  needsManualUpdate: string[];
  outputRoot: string;
}

interface GeneratedLayoutSummary {
  id: string;
  name: string;
  sourcePath: string;
  outputPath: string;
}

/** Values that are safe to write to a `.env` line: no whitespace, quotes or line breaks. */
const SAFE_ENV_VALUE = /^[A-Za-z0-9:/._~%+=@-]+$/;

/** Bump together with the `fmweb-managed: runtime template vN` line in the managed files. */
export const RUNTIME_TEMPLATE_VERSION = 2;
const MANAGED_MARKER = /^\/\/ fmweb-managed: runtime template v(\d+)/;

/**
 * Files of the runtime template that the extension owns and keeps current in apps that were
 * generated earlier: the bridge client and the code that hands it the address and token. Each
 * value lists SHA-256 hashes (line endings normalised) of the shipped versions that had no
 * version marker, so an unmodified old copy can be recognised and refreshed safely.
 */
const MANAGED_TEMPLATE_FILES: Record<string, string[]> = {
  'lib/bridge-client.ts': ['5498ff7031a1e12b4c74b1d1a5d8c08f286754732f5c26006760f8ea95d58d1f'],
  'lib/runtime-data.ts': ['3e382ec9f700d98c480e30fa714f1fdb322a758b3d71b431ef07624c37b400aa'],
  'lib/runtime-behavior.ts': ['6d5794b937c78c15a1a2f97ab4fec42d88f9a6fb0d366c6d0625c80aad8cef95'],
  'app/layouts/[id]/runtime-layout-client.tsx': [
    'c640219eb6fd4fdd673f0a4e1982545774af0a40a0007ca51caa1f0ebd3de2e0',
    'f1638379856babcb38394bc83b0a77eb46b757f8eab54501b469a93bee447668'
  ]
};

function normalizedHash(content: Buffer): string {
  return createHash('sha256').update(content.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}

/** Raised when the runtime template is not part of this installation of the extension. */
export class RuntimeTemplateUnavailableError extends Error {
  public constructor() {
    super(
      'The FM Web preview is not available in this installation. It needs the runtime-next and shared packages from the filemaker-data-api-for-vs-code repository, which the Marketplace extension does not include. Open that repository (or run the extension from source) to use the preview.'
    );
    this.name = 'RuntimeTemplateUnavailableError';
  }
}

export class FmWebRuntimeGenerator {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fmWebProjectService: FmWebProjectService,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  ) {}

  public async generateRuntimeAppTemplate(): Promise<TemplateCopySummary> {
    this.assertWorkspaceTrusted();

    // Without the template there is nothing that could work: an older built-in fallback app
    // had no bridge client and depended on a `shared` package that only the repository has.
    const templateRoot = await this.resolveTemplateRoot();
    if (!templateRoot) {
      throw new RuntimeTemplateUnavailableError();
    }

    await this.fmWebProjectService.ensureProjectInitialized();

    const outputRoot = this.getGeneratedRuntimeRoot();
    await mkdir(outputRoot, { recursive: true });

    const templateFiles = await collectFiles(templateRoot, templateRoot);
    const created: string[] = [];
    const skipped: string[] = [];
    const updated: string[] = [];
    const needsManualUpdate: string[] = [];

    for (const relativePath of templateFiles) {
      const sourcePath = path.join(templateRoot, relativePath);
      const outputPath = path.join(outputRoot, relativePath);
      const managedKey = relativePath.split(path.sep).join('/');
      const content = await readFile(sourcePath);

      if (await exists(outputPath)) {
        const legacyHashes = MANAGED_TEMPLATE_FILES[managedKey];
        const decision = legacyHashes
          ? this.decideManagedRefresh(await readFile(outputPath), legacyHashes)
          : 'skip';
        if (decision === 'refresh') {
          await writeFile(outputPath, content);
          updated.push(relativePath);
        } else {
          skipped.push(relativePath);
          if (decision === 'edited') {
            needsManualUpdate.push(relativePath);
          }
        }
        continue;
      }

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content);
      created.push(relativePath);
    }

    return {
      created,
      skipped,
      updated,
      needsManualUpdate,
      outputRoot
    };
  }

  /**
   * An existing copy of a managed file is refreshed when it carries an older version marker, or
   * has no marker and is byte-for-byte (line endings aside) a version the extension shipped
   * before markers existed. Anything else was edited by the user and is left alone.
   */
  private decideManagedRefresh(existing: Buffer, legacyHashes: string[]): 'refresh' | 'current' | 'edited' {
    const firstLine = existing.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
    const marker = MANAGED_MARKER.exec(firstLine);
    if (marker) {
      return Number(marker[1]) < RUNTIME_TEMPLATE_VERSION ? 'refresh' : 'current';
    }
    return legacyHashes.includes(normalizedHash(existing)) ? 'refresh' : 'edited';
  }

  public async listLayoutDefinitions(): Promise<Array<{ id: string; name: string; filePath: string }>> {
    this.assertWorkspaceTrusted();
    await this.fmWebProjectService.ensureProjectInitialized();

    const layoutsDir = this.fmWebProjectService.getLayoutsDirPath();
    const entries = await readdir(layoutsDir);
    const layouts: Array<{ id: string; name: string; filePath: string }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.layout.json')) {
        continue;
      }

      const filePath = path.join(layoutsDir, entry);
      try {
        const raw = await readFile(filePath, 'utf8');
        const layout = migrateLayoutDefinition(JSON.parse(raw));
        layouts.push({
          id: layout.id,
          name: layout.name,
          filePath
        });
      } catch (error) {
        this.logger.warn('Skipping invalid layout definition while generating runtime artifacts.', {
          filePath,
          error
        });
      }
    }

    return layouts.sort((left, right) => left.name.localeCompare(right.name));
  }

  public async generateLayoutPage(layoutId?: string): Promise<GeneratedLayoutSummary> {
    this.assertWorkspaceTrusted();
    await this.fmWebProjectService.ensureProjectInitialized();

    const layouts = await this.listLayoutDefinitions();
    if (layouts.length === 0) {
      throw new Error('No layouts found. Create and save a layout first.');
    }

    const selected = layoutId ? layouts.find((entry) => entry.id === layoutId) : layouts[0];
    if (!selected) {
      throw new Error(`Layout with id "${layoutId}" was not found.`);
    }

    const raw = await readFile(selected.filePath, 'utf8');
    const layout = migrateLayoutDefinition(JSON.parse(raw));
    const outputDir = this.getGeneratedLayoutsRoot();
    const outputPath = path.join(outputDir, `${layout.id}.layout.json`);

    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');

    return {
      id: layout.id,
      name: layout.name,
      sourcePath: selected.filePath,
      outputPath
    };
  }

  /**
   * Writes the bridge address and its per-session token into the generated runtime's
   * `.env.local` so the preview app can reach the bridge (it refuses requests without the
   * token). The file holds a secret: it is created owner-only and a `.gitignore` next to it
   * keeps it out of git. Nothing here logs the token.
   */
  public async writeBridgeEnv(baseUrl: string, token?: string): Promise<string> {
    this.assertWorkspaceTrusted();
    if (!SAFE_ENV_VALUE.test(baseUrl) || (token !== undefined && !SAFE_ENV_VALUE.test(token))) {
      throw new Error('The bridge address or token contains characters that cannot be written to an env file.');
    }

    const runtimeRoot = this.getGeneratedRuntimeRoot();
    await mkdir(runtimeRoot, { recursive: true });
    await this.ensureRuntimeGitignore(runtimeRoot);
    const envPath = path.join(runtimeRoot, '.env.local');

    const managed: Record<string, string | undefined> = {
      NEXT_PUBLIC_FMWEB_BRIDGE_URL: baseUrl,
      NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN: token
    };

    await refuseSymlink(envPath);
    const existing = (await exists(envPath)) ? await readFile(envPath, 'utf8') : '';
    const kept = existing
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !Object.keys(managed).some((key) => line.startsWith(`${key}=`)));
    const lines = [
      ...kept,
      ...Object.entries(managed)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`)
    ];

    await writeOwnerOnlyFile(envPath, `${lines.join('\n')}\n`);
    return envPath;
  }

  private async ensureRuntimeGitignore(runtimeRoot: string): Promise<void> {
    const gitignorePath = path.join(runtimeRoot, '.gitignore');
    const required = ['.env.local', '.env*.local', 'node_modules', '.next'];
    const current = (await exists(gitignorePath)) ? await readFile(gitignorePath, 'utf8') : '';
    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const missing = required.filter((line) => !present.has(line));
    if (missing.length === 0) {
      return;
    }

    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await refuseSymlink(gitignorePath);
    await writeFile(gitignorePath, `${current}${prefix}${missing.join('\n')}\n`, 'utf8');
  }

  public getGeneratedRuntimeRoot(): string {
    return path.join(this.fmWebProjectService.getGeneratedDirPath(), 'runtime-next');
  }

  public getGeneratedLayoutsRoot(): string {
    return path.join(this.fmWebProjectService.getGeneratedDirPath(), 'layouts');
  }

  private async resolveTemplateRoot(): Promise<string | undefined> {
    const extensionRoot = this.context.extensionUri.fsPath;
    const candidates = [
      path.join(extensionRoot, '..', 'runtime-next'),
      path.join(extensionRoot, 'runtime-next'),
      path.join(extensionRoot, 'src', 'runtime-template')
    ];

    for (const candidate of candidates) {
      if (await exists(path.join(candidate, 'package.json'))) {
        return candidate;
      }
    }

    return undefined;
  }

  private assertWorkspaceTrusted(): void {
    if (!this.fmWebProjectService.isWorkspaceTrusted()) {
      throw new Error('Workspace trust is required for FM Web runtime generation.');
    }
  }
}

async function collectFiles(rootDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries) {
    // Never copy local env files (they can hold a bridge token) or build output.
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.vite' || entry.name.startsWith('.env')) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(rootDir, fullPath);
      result.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    result.push(path.relative(rootDir, fullPath));
  }

  return result.sort((left, right) => left.localeCompare(right));
}

/**
 * The generated folder can arrive with a repository, so a link planted at a file we are about to
 * write could redirect the write (and the token in it) elsewhere. Refuse a link at the target.
 */
async function refuseSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`${path.basename(target)} in the generated runtime is a symbolic link; remove it and try again.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** Writes via a new owner-only temporary file and renames it over the target (never follows a link). */
async function writeOwnerOnlyFile(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
