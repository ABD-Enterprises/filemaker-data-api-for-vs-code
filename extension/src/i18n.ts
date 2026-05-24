import * as fs from 'fs';
import * as path from 'path';
import * as nls from 'vscode-nls';

nls.config({
  messageFormat: nls.MessageFormat.bundle,
  bundleFormat: nls.BundleFormat.standalone
})();

const fallbackLocalize = nls.loadMessageBundle();
let runtimeMessages: Record<string, string> | undefined;
let translatedMessages: Record<string, string> | undefined;

export function localize(
  key: string,
  message: string,
  ...args: (string | number | boolean | undefined | null)[]
): string {
  const translated = getTranslatedMessages()[key];
  return fallbackLocalize(key, translated ?? message, ...args);
}

export function getWebviewI18nScript(nonce: string): string {
  const messages = getLocalizedRuntimeMessages();
  const serialized = JSON.stringify(messages).replace(/</g, '\\u003c');
  return `<script nonce="${nonce}">window.fileMakerI18n=${serialized};</script>`;
}

function getLocalizedRuntimeMessages(): Record<string, string> {
  const sourceMessages = getRuntimeMessages();
  const localized: Record<string, string> = {};

  for (const [key, message] of Object.entries(sourceMessages)) {
    localized[key] = localize(key, message);
  }

  return localized;
}

function getRuntimeMessages(): Record<string, string> {
  if (runtimeMessages) {
    return runtimeMessages;
  }

  runtimeMessages = readMessageFile(path.join(getExtensionRoot(), 'i18n', 'messages.json'));
  return runtimeMessages;
}

function getTranslatedMessages(): Record<string, string> {
  if (translatedMessages) {
    return translatedMessages;
  }

  translatedMessages = {};
  for (const locale of getLocaleCandidates()) {
    const candidate = path.join(getExtensionRoot(), 'i18n', `messages.${locale}.json`);
    translatedMessages = readMessageFile(candidate);
    if (Object.keys(translatedMessages).length > 0) {
      break;
    }
  }

  return translatedMessages;
}

function getLocaleCandidates(): string[] {
  const candidates = new Set<string>();
  const rawConfig = process.env.VSCODE_NLS_CONFIG;

  if (rawConfig) {
    try {
      const config = JSON.parse(rawConfig) as {
        locale?: unknown;
        availableLanguages?: Record<string, unknown>;
      };
      const language = config.availableLanguages?.['*'];
      if (typeof language === 'string' && language !== 'en') {
        addLocaleCandidate(candidates, language);
      }
      if (typeof config.locale === 'string') {
        addLocaleCandidate(candidates, config.locale);
      }
    } catch {
      // Ignore malformed host config and fall back to source strings.
    }
  }

  return Array.from(candidates).filter((locale) => locale !== 'en');
}

function addLocaleCandidate(candidates: Set<string>, locale: string): void {
  const normalized = locale.toLowerCase();
  candidates.add(normalized);

  const language = normalized.split('-')[0];
  if (language) {
    candidates.add(language);
  }
}

function getExtensionRoot(): string {
  return path.resolve(__dirname, '..');
}

function readMessageFile(filePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
      })
    );
  } catch {
    return {};
  }
}
