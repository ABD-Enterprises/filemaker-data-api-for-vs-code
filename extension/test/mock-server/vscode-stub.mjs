// Minimal stand-in for the `vscode` module so the extension's service code runs under plain Node.
export const window = {
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined
};
export const workspace = {
  getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined })
};
export const env = { machineId: 'test-machine', clipboard: { writeText: async () => undefined } };
export class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
export const Uri = { file: (p) => ({ fsPath: p }), parse: (p) => ({ fsPath: p }) };
export default {};
