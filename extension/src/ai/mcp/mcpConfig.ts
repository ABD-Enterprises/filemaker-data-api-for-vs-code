import { copyFile, mkdir, rename, rm } from 'fs/promises';
import { dirname, join } from 'path';

/** The folder (inside the extension's global storage) that holds discovery files. */
export function discoveryDirectory(globalStoragePath: string): string {
  return join(globalStoragePath, 'ai-mcp');
}

/**
 * Ready-to-paste MCP client configuration (Claude Code `.mcp.json` or `claude mcp add-json`,
 * Cursor `mcp.json`). It names the bundled shim, the discovery folder and the window to use.
 * It contains no token: the shim reads that from the discovery file.
 */
export function buildMcpConfig(args: { shimPath: string; discoveryDir: string; workspaceFolder?: string }): {
  mcpServers: { filemaker: { command: string; args: string[] } };
} {
  return {
    mcpServers: {
      filemaker: {
        command: 'node',
        args: [
          args.shimPath,
          '--dir',
          args.discoveryDir,
          ...(args.workspaceFolder ? ['--workspace', args.workspaceFolder] : [])
        ]
      }
    }
  };
}

/** A stable place for the shim, so a client configuration survives extension updates. */
export function installedShimPath(globalStoragePath: string): string {
  return join(globalStoragePath, 'ai-mcp-shim', 'aiMcpShim.js');
}

/**
 * Copies the shim from the extension folder (whose name changes with every version) to a
 * stable path in the extension's storage. Returns the stable path, or the original path if
 * the copy fails, so a configuration still works until the next update.
 */
export async function installShim(extensionShimPath: string, globalStoragePath: string): Promise<{ path: string; stable: boolean }> {
  const target = installedShimPath(globalStoragePath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(extensionShimPath, temporary);
    await rename(temporary, target);
    return { path: target, stable: true };
  } catch {
    await rm(temporary, { force: true });
    return { path: extensionShimPath, stable: false };
  }
}
