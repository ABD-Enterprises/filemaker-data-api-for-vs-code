import { join } from 'path';

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
