/**
 * The stdio shim that MCP clients (Claude Code, Cursor and others) launch:
 *
 *   node aiMcpShim.js --dir <discovery folder> [--workspace <folder or name>]
 *
 * It finds the VS Code window that runs the FileMaker AI server, checks that the process in
 * the discovery file is alive and is the same run (pid and start time) before it sends the
 * token, connects to the local socket, authenticates, and then only copies bytes between
 * stdin/stdout and the socket. It holds no credentials for FileMaker and applies no policy.
 * stdout carries nothing but protocol messages; every diagnostic goes to stderr.
 */
import { runShim } from './runShim';

void runShim(process).then((code) => process.exit(code));
