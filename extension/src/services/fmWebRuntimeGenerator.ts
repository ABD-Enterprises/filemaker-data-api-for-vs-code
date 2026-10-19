import { createHash, randomBytes } from 'crypto';
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import path from 'path';

import type * as vscode from 'vscode';

import { migrateLayoutDefinition } from '../fmweb/layoutSchema';
import { renameReplacing } from '../utils/renameReplacing';
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

/**
 * SHA-256 hashes (line endings normalised) of every version of each managed file that the
 * extension shipped WITH a version marker, the current one included. A copy that carries an older
 * marker is only refreshed when it matches one of these; otherwise the user edited it (the marker
 * line survives an edit) and it is left alone and reported. When you change a managed file in
 * runtime-next, bump RUNTIME_TEMPLATE_VERSION and ADD the new hash here without removing the old
 * one; the runtime-template test fails until you do.
 */
export const SHIPPED_MARKED_HASHES: Record<string, string[]> = {
  'lib/bridge-client.ts': ['4c1b977065ac9689fc4992c7139f685e16f6489240d1f195ebe4044c20e99b07'],
  'lib/runtime-data.ts': ['17ef4bdd043cd5e61fc23bee9516acb66696f4775f53c347048277c32693de3b'],
  'lib/runtime-behavior.ts': ['84f4d5c3c7c0f01e033d48476e419150ba1ed28fc28542c61f319613f8d59609'],
  'app/layouts/[id]/runtime-layout-client.tsx': ['12d62d25e10b9a94af9e23f997c0bfc1f522c5d50906d67cc6b13a10de6748e5']
};

export function normalizedHash(content: Buffer): string {
  return createHash('sha256').update(content.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Whether an existing copy of a managed file may be replaced by the shipped one.
 * - older marker: refreshed only if it is byte-for-byte (line endings aside) a version we shipped
 *   with a marker; an edited copy keeps its marker line, so the marker alone proves nothing;
 * - current or newer marker: nothing to do;
 * - no marker: refreshed only if it is a version we shipped before markers existed.
 * Anything else is the user's and is left alone ('edited').
 */
export function decideManagedRefresh(
  existing: Buffer,
  legacyHashes: string[],
  markedHashes: string[],
  currentVersion: number = RUNTIME_TEMPLATE_VERSION
): 'refresh' | 'current' | 'edited' {
  const firstLine = existing.toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  const marker = MANAGED_MARKER.exec(firstLine);
  const hash = normalizedHash(existing);
  if (marker) {
    if (Number(marker[1]) >= currentVersion) {
      return 'current';
    }
    return markedHashes.includes(hash) ? 'refresh' : 'edited';
  }
  return legacyHashes.includes(hash) ? 'refresh' : 'edited';
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

/**
 * Where the runtime template lives for an extension installed at `extensionRoot`, or undefined when
 * this installation does not carry it (the Marketplace package leaves out runtime-next). The
 * generator and the activation-time context key both use this, so a command is hidden exactly when
 * invoking it would fail with RuntimeTemplateUnavailableError.
 */
export async function resolveRuntimeTemplateRoot(extensionRoot: string): Promise<string | undefined> {
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

/** The context key the preview commands' menu entries depend on. */
export const PREVIEW_AVAILABLE_CONTEXT_KEY = 'filemaker.fmWebPreviewAvailable';

/** Sets the context key from what this installation carries. Returns the value it set. */
export async function publishPreviewAvailability(
  extensionRoot: string,
  setContext: (key: string, value: boolean) => Thenable<unknown> | void
): Promise<boolean> {
  const available = await resolveRuntimeTemplateRoot(extensionRoot).then(
    (root) => root !== undefined,
    () => false
  );
  await setContext(PREVIEW_AVAILABLE_CONTEXT_KEY, available);
  return available;
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

      // lstat, not access: a link (even a dangling one) is something the user or the repository put
      // there, and a write would follow it to wherever it points. Leave it alone; for a managed
      // file say so, because the preview may then run with a stale or foreign copy.
      const present = await lstat(outputPath).catch(() => undefined);
      if (present) {
        const legacyHashes = MANAGED_TEMPLATE_FILES[managedKey];
        if (present.isDirectory()) {
          throw new Error(`${relativePath} in the generated runtime is a folder, not a file; remove it and try again.`);
        }
        if (present.isSymbolicLink()) {
          skipped.push(relativePath);
          if (legacyHashes) {
            needsManualUpdate.push(relativePath);
            this.logger.warn('A managed runtime file is a symbolic link; it was not refreshed.', { file: relativePath });
          }
          continue;
        }
        const decision = legacyHashes
          ? decideManagedRefresh(await readFile(outputPath), legacyHashes, SHIPPED_MARKED_HASHES[managedKey] ?? [])
          : 'skip';
        if (decision === 'refresh') {
          await assertInsideRoot(outputRoot, path.dirname(outputPath));
          await writeManagedFile(outputPath, content);
          updated.push(relativePath);
        } else {
          skipped.push(relativePath);
          if (decision === 'edited') {
            needsManualUpdate.push(relativePath);
            this.logger.warn('A managed runtime file was edited and was not refreshed.', { file: relativePath });
          }
        }
        continue;
      }

      await mkdir(path.dirname(outputPath), { recursive: true });
      await assertInsideRoot(outputRoot, path.dirname(outputPath));
      await writeManagedFile(outputPath, content);
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

  private resolveTemplateRoot(): Promise<string | undefined> {
    return resolveRuntimeTemplateRoot(this.context.extensionUri.fsPath);
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

/**
 * Writes a generated file so that a link planted at the target cannot redirect the write: the content
 * goes to a new temporary file in the same folder and is renamed over the target. `rename` replaces
 * the directory entry (a symbolic link is replaced, never followed), so there is no moment between a
 * check and the write at which a link can take effect; the result is checked afterwards. A hard link
 * is not written through either: the other name keeps the old content. A folder at the target is
 * reported in plain words instead of as a raw EISDIR.
 */
export async function writeManagedFile(target: string, content: Buffer | string): Promise<void> {
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isDirectory()) {
    throw new Error(`${path.basename(target)} in the generated runtime is a folder, not a file; remove it and try again.`);
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    // The replacement keeps the permission bits of the file it replaces (an executable stays one, a
    // file the user made owner-only stays owner-only); a new file gets the usual default.
    if (existing?.isFile()) {
      await chmod(temporary, existing.mode & 0o7777).catch(() => undefined);
    }
    await renameReplacing(temporary, target);
  } catch (error) {
    // Also reached when the write itself failed part way (disk full): never leave the .tmp behind.
    await rm(temporary, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EISDIR' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      throw new Error(`${path.basename(target)} in the generated runtime is a folder, not a file; remove it and try again.`, { cause: error });
    }
    throw error;
  }
  const written = await lstat(target);
  if (!written.isFile()) {
    throw new Error(`${path.basename(target)} in the generated runtime could not be written as a regular file; remove it and try again.`);
  }
}

/** Writes via a new owner-only temporary file and renames it over the target (never follows a link). */
async function writeOwnerOnlyFile(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await renameReplacing(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A folder inside the generated runtime that is really a link elsewhere must not receive writes. */
async function assertInsideRoot(root: string, dir: string): Promise<void> {
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
  const relative = path.relative(realRoot, realDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${path.relative(root, dir) || '.'} in the generated runtime is a link to a folder outside it; remove it and try again.`);
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
