import { access, chmod, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

import type * as vscode from 'vscode';

import { migrateLayoutDefinition } from '../fmweb/layoutSchema';
import type { Logger } from './logger';
import type { FmWebProjectService } from './fmWebProjectService';

interface TemplateCopySummary {
  created: string[];
  skipped: string[];
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

export class FmWebRuntimeGenerator {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly fmWebProjectService: FmWebProjectService,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  ) {}

  public async generateRuntimeAppTemplate(): Promise<TemplateCopySummary> {
    this.assertWorkspaceTrusted();
    await this.fmWebProjectService.ensureProjectInitialized();

    const outputRoot = this.getGeneratedRuntimeRoot();
    await mkdir(outputRoot, { recursive: true });

    const templateRoot = await this.resolveTemplateRoot();
    if (!templateRoot) {
      return this.writeFallbackTemplate(outputRoot);
    }

    const templateFiles = await collectFiles(templateRoot, templateRoot);
    const created: string[] = [];
    const skipped: string[] = [];

    for (const relativePath of templateFiles) {
      const sourcePath = path.join(templateRoot, relativePath);
      const outputPath = path.join(outputRoot, relativePath);
      if (await exists(outputPath)) {
        skipped.push(relativePath);
        continue;
      }

      await mkdir(path.dirname(outputPath), { recursive: true });
      const content = await readFile(sourcePath);
      await writeFile(outputPath, content);
      created.push(relativePath);
    }

    return {
      created,
      skipped,
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

    await writeFile(envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(envPath, 0o600).catch(() => undefined);
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

  private async writeFallbackTemplate(outputRoot: string): Promise<TemplateCopySummary> {
    const files: Record<string, string> = {
      'package.json': `{
  "name": "fmweb-generated-runtime",
  "private": true,
  "scripts": {
    "dev": "next dev"
  },
  "dependencies": {
    "@fmweb/shared": "file:../../../shared",
    "next": "15.3.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
`,
      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "react", "react-dom"]
  },
  "include": ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "next-env.d.ts"]
}
`,
      'next-env.d.ts': `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`,
      'app/layout.tsx': `import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'FM Web Runtime',
  description: 'Generated runtime for FileMaker layouts'
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      'app/page.tsx': `import Link from 'next/link';

export default function HomePage(): JSX.Element {
  return (
    <main className="runtime-home">
      <h1>FM Web Runtime</h1>
      <p>Open a generated layout page.</p>
      <Link href="/layouts/example">Open Example Layout</Link>
    </main>
  );
}
`,
      'app/styles.css': `:root {
  color-scheme: light;
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
}

html,
body {
  margin: 0;
  padding: 0;
  background: #f4f8fb;
  color: #182a3a;
}

.runtime-home,
.runtime-layout-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}
`,
      'app/layouts/[id]/page.tsx': `import { notFound } from 'next/navigation';
import { LayoutContainer } from '@fmweb/shared';
import { readFile } from 'fs/promises';
import path from 'path';
import { migrateLayoutDefinition } from '@fmweb/shared';

interface LayoutPageProps {
  params: {
    id: string;
  };
}

export default async function LayoutPage({ params }: LayoutPageProps): Promise<JSX.Element> {
  const filePath = path.join(process.cwd(), '..', 'layouts', \`\${params.id}.layout.json\`);
  try {
    const raw = await readFile(filePath, 'utf8');
    const layout = migrateLayoutDefinition(JSON.parse(raw));
    return (
      <main className="runtime-layout-page">
        <h1>{layout.name}</h1>
        <LayoutContainer layout={layout} mode="runtime" />
      </main>
    );
  } catch {
    notFound();
  }
}
`
    };

    const created: string[] = [];
    const skipped: string[] = [];

    for (const [relativePath, content] of Object.entries(files)) {
      const outputPath = path.join(outputRoot, relativePath);
      if (await exists(outputPath)) {
        skipped.push(relativePath);
        continue;
      }

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content, 'utf8');
      created.push(relativePath);
    }

    return {
      created,
      skipped,
      outputRoot
    };
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
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.vite') {
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
