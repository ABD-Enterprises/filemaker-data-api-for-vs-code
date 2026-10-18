// Test-only helper loaded with --extensionDevelopmentPath. The harness cannot call the VS Code API from
// outside the window, so it drops JSON requests into $FM_E2E_HELPER_DIR/requests and reads
// $FM_E2E_HELPER_DIR/responses/<id>.json. It never ships (extension/.vscodeignore excludes e2e-ui).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const dir = process.env.FM_E2E_HELPER_DIR;

async function handle(req) {
  switch (req.action) {
    case 'ping':
      return {
        ok: true,
        trusted: vscode.workspace.isTrusted,
        folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
      };
    case 'listTools':
      return vscode.lm.tools.map((t) => ({
        name: t.name,
        description: t.description,
        tags: t.tags
      }));
    case 'invokeTool': {
      const result = await vscode.lm.invokeTool(req.name, {
        input: req.input ?? {},
        toolInvocationToken: undefined
      });
      return {
        parts: result.content.map((p) =>
          p instanceof vscode.LanguageModelTextPart
            ? { type: 'text', value: p.value }
            : { type: 'other' }
        )
      };
    }
    case 'getConfig':
      return {
        value: vscode.workspace.getConfiguration().get(req.key),
        inspect: vscode.workspace.getConfiguration().inspect(req.key)
      };
    case 'extensions':
      return vscode.extensions.all
        .filter((e) => !e.packageJSON.isBuiltin)
        .map((e) => ({ id: e.id, version: e.packageJSON.version, active: e.isActive }));
    case 'executeCommand':
      return {
        result: JSON.parse(
          JSON.stringify(
            (await vscode.commands.executeCommand(req.command, ...(req.args ?? []))) ?? null
          )
        )
      };
    case 'commands': {
      const all = await vscode.commands.getCommands(true);
      return all.filter((c) => c.toLowerCase().includes((req.filter ?? '').toLowerCase()));
    }
    case 'textDocuments':
      return vscode.workspace.textDocuments.map((d) => ({
        uri: d.uri.toString(),
        languageId: d.languageId,
        length: d.getText().length
      }));
    default:
      throw new Error(`unknown action ${req.action}`);
  }
}

function activate(context) {
  if (!dir) return;
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'responses'), { recursive: true });
  const seen = new Set();
  const timer = setInterval(async () => {
    for (const name of fs.readdirSync(path.join(dir, 'requests'))) {
      if (seen.has(name) || !name.endsWith('.json')) continue;
      seen.add(name);
      let id = name.replace(/\.json$/, '');
      let out;
      try {
        const req = JSON.parse(fs.readFileSync(path.join(dir, 'requests', name), 'utf8'));
        out = { ok: true, data: await handle(req) };
      } catch (e) {
        out = { ok: false, error: String(e && e.message ? e.message : e) };
      }
      fs.writeFileSync(path.join(dir, 'responses', `${id}.json.tmp`), JSON.stringify(out));
      fs.renameSync(
        path.join(dir, 'responses', `${id}.json.tmp`),
        path.join(dir, 'responses', `${id}.json`)
      );
    }
  }, 150);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
module.exports = { activate };
