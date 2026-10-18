import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const t = (label, fn) => Promise.resolve().then(fn).then((r) => console.log(`[${label}]`, r), (e) => console.log(`[${label}] ERR`, e && e.message));
const run = (cmd, args, opts) => new Promise((res) => { const s = Date.now(); execFile(cmd, args, { timeout: 20000, windowsHide: true, ...opts }, (err, so, se) => res({ ms: Date.now() - s, err: err && (err.code ?? err.message), signal: err && err.signal, stdout: String(so).trim(), stderr: String(se).trim().slice(0, 300) })); });

const pid = process.pid;
const ps = ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`];
await t('ps-plain', () => run('powershell.exe', ps, {}));
await t('ps-env', () => run('powershell.exe', ps, { env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }));
await t('ps-again', () => run('powershell.exe', ps, {}));
await t('pwsh', () => run('pwsh', ['-NoProfile', '-Command', 'echo hi'], {}));
await t('which-sh', () => run('where', ['sh'], {}));
await t('os', () => ({ tmp: os.tmpdir(), home: os.homedir(), uid: typeof process.getuid, platform: process.platform, node: process.version }));
await t('env-case', () => ({ Path: !!process.env.Path, PATH: !!process.env.PATH, spreadKeys: Object.keys({ ...process.env }).filter((k) => /^path$/i.test(k)) }));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
// named pipe
await t('pipe', () => new Promise((resolve, reject) => {
  const name = `\\\\.\\pipe\\fm-ai-dbg${Date.now()}`;
  const srv = net.createServer((s) => { s.on('data', (d) => s.write(d)); });
  srv.listen(name, () => {
    const c = net.connect(name);
    c.once('connect', () => c.write('x\n'));
    c.once('data', (d) => { c.destroy(); srv.close(); resolve(`echo ${String(d).trim()}`); });
    c.once('error', reject);
  });
  srv.once('error', reject);
}));
await t('unix-socket-in-tmp', () => new Promise((resolve, reject) => {
  const p = path.join(dir, 'a.sock');
  const srv = net.createServer(() => {});
  srv.once('error', (e) => resolve(`ERR ${e.code}`));
  srv.listen(p, () => { resolve(`listening, isSocket=${fs.lstatSync(p).isSocket()}`); srv.close(); });
}));
// mode / lstat
const f = path.join(dir, 'f.txt'); fs.writeFileSync(f, 'x', { mode: 0o600 });
await t('stat', () => ({ mode: (fs.statSync(f).mode & 0o777).toString(8), uid: fs.statSync(f).uid }));
await t('icacls', () => run('icacls', [f], {}));
// junction
const target = path.join(dir, 'target'); fs.mkdirSync(target);
const junc = path.join(dir, 'junc');
await t('junction', () => { fs.symlinkSync(target, junc, 'junction'); const s = fs.lstatSync(junc); return { isSymbolicLink: s.isSymbolicLink(), isDirectory: s.isDirectory(), real: fs.realpathSync(junc) === fs.realpathSync(target) }; });
await t('file-symlink', () => { try { fs.symlinkSync(f, path.join(dir, 'l.txt'), 'file'); return 'created'; } catch (e) { return `ERR ${e.code}`; } });
await t('whoami', () => run('whoami', ['/user'], {}));
await t('git-toplevel', () => { execFileSync('git', ['init', '-q'], { cwd: dir }); return { git: execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim(), dir, native: fs.realpathSync.native(dir), js: fs.realpathSync(dir) }; });
await t('autocrlf', () => run('git', ['config', '--show-origin', '--get', 'core.autocrlf'], {}));
