#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const packageJsonPath = path.join(extensionRoot, 'package.json');
const packageNlsPath = path.join(extensionRoot, 'package.nls.json');
const runtimeMessagesPath = path.join(extensionRoot, 'i18n', 'messages.json');
const checkMode = process.argv.includes('--check');

const packageJson = readJson(packageJsonPath);
const existingPackageBundle = fs.existsSync(packageNlsPath) ? readJson(packageNlsPath) : {};
const packageBundle = {};
localizePackageJson(packageJson, packageBundle, existingPackageBundle);

const runtimeMessages = extractRuntimeMessages();

writeOrCheckJson(packageJsonPath, packageJson);
writeOrCheckJson(packageNlsPath, sortObject(packageBundle));
writeOrCheckJson(runtimeMessagesPath, sortObject(runtimeMessages));

if (checkMode) {
  console.log('i18n bundles are up to date.');
} else {
  console.log(`Extracted ${Object.keys(packageBundle).length} package strings.`);
  console.log(`Extracted ${Object.keys(runtimeMessages).length} runtime strings.`);
}

function localizePackageJson(root, bundle, existingBundle) {
  localizeField(root, ['displayName'], 'extension.displayName', bundle, existingBundle);
  localizeField(root, ['description'], 'extension.description', bundle, existingBundle);
  localizeField(
    root,
    ['capabilities', 'untrustedWorkspaces', 'description'],
    'capabilities.untrustedWorkspaces.description',
    bundle,
    existingBundle
  );

  const contributes = root.contributes;
  if (!contributes || typeof contributes !== 'object') {
    return;
  }

  for (const [container, items] of Object.entries(contributes.viewsContainers ?? {})) {
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!isObject(item) || typeof item.id !== 'string') {
        continue;
      }
      localizeStringProperty(
        item,
        'title',
        `viewsContainers.${container}.${item.id}.title`,
        bundle,
        existingBundle
      );
    }
  }

  for (const [viewGroup, items] of Object.entries(contributes.views ?? {})) {
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!isObject(item) || typeof item.id !== 'string') {
        continue;
      }
      localizeStringProperty(
        item,
        'name',
        `views.${viewGroup}.${item.id}.name`,
        bundle,
        existingBundle
      );
      localizeStringProperty(
        item,
        'contextualTitle',
        `views.${viewGroup}.${item.id}.contextualTitle`,
        bundle,
        existingBundle
      );
    }
  }

  for (const item of contributes.viewsWelcome ?? []) {
    if (!isObject(item) || typeof item.view !== 'string') {
      continue;
    }
    localizeStringProperty(
      item,
      'contents',
      `viewsWelcome.${item.view}.contents`,
      bundle,
      existingBundle
    );
  }

  for (const walkthrough of contributes.walkthroughs ?? []) {
    if (!isObject(walkthrough) || typeof walkthrough.id !== 'string') {
      continue;
    }
    localizeStringProperty(
      walkthrough,
      'title',
      `walkthroughs.${walkthrough.id}.title`,
      bundle,
      existingBundle
    );
    localizeStringProperty(
      walkthrough,
      'description',
      `walkthroughs.${walkthrough.id}.description`,
      bundle,
      existingBundle
    );

    for (const step of walkthrough.steps ?? []) {
      if (!isObject(step) || typeof step.id !== 'string') {
        continue;
      }
      localizeStringProperty(
        step,
        'title',
        `walkthroughs.${walkthrough.id}.steps.${step.id}.title`,
        bundle,
        existingBundle
      );
      localizeStringProperty(
        step,
        'description',
        `walkthroughs.${walkthrough.id}.steps.${step.id}.description`,
        bundle,
        existingBundle
      );
    }
  }

  for (const command of contributes.commands ?? []) {
    if (!isObject(command) || typeof command.command !== 'string') {
      continue;
    }
    localizeStringProperty(
      command,
      'title',
      `commands.${command.command}.title`,
      bundle,
      existingBundle
    );
  }

  const configuration = contributes.configuration;
  if (isObject(configuration)) {
    localizeStringProperty(configuration, 'title', 'configuration.title', bundle, existingBundle);
    for (const [setting, definition] of Object.entries(configuration.properties ?? {})) {
      if (!isObject(definition)) {
        continue;
      }
      for (const field of ['description', 'markdownDescription', 'markdownDeprecationMessage']) {
        localizeStringProperty(
          definition,
          field,
          `configuration.${setting}.${field}`,
          bundle,
          existingBundle
        );
      }
      localizeStringArray(
        definition,
        'enumDescriptions',
        `configuration.${setting}.enumDescriptions`,
        bundle,
        existingBundle
      );
      localizeStringArray(
        definition,
        'enumItemLabels',
        `configuration.${setting}.enumItemLabels`,
        bundle,
        existingBundle
      );
    }
  }
}

function localizeField(root, pathSegments, key, bundle, existingBundle) {
  let target = root;
  for (const segment of pathSegments.slice(0, -1)) {
    target = isObject(target) ? target[segment] : undefined;
  }

  if (isObject(target)) {
    localizeStringProperty(
      target,
      pathSegments[pathSegments.length - 1],
      key,
      bundle,
      existingBundle
    );
  }
}

function localizeStringProperty(target, property, key, bundle, existingBundle) {
  const value = target[property];
  if (typeof value !== 'string' || value.length === 0) {
    return;
  }

  const placeholderKey = parsePlaceholder(value) ?? key;
  const fallback = parsePlaceholder(value) ? existingBundle[placeholderKey] : value;
  if (typeof fallback !== 'string') {
    throw new Error(`Missing package.nls.json entry for %${placeholderKey}%`);
  }

  bundle[placeholderKey] = fallback;
  target[property] = `%${placeholderKey}%`;
}

function localizeStringArray(target, property, keyPrefix, bundle, existingBundle) {
  const values = target[property];
  if (!Array.isArray(values)) {
    return;
  }

  target[property] = values.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0) {
      return value;
    }

    const placeholderKey = parsePlaceholder(value) ?? `${keyPrefix}.${index}`;
    const fallback = parsePlaceholder(value) ? existingBundle[placeholderKey] : value;
    if (typeof fallback !== 'string') {
      throw new Error(`Missing package.nls.json entry for %${placeholderKey}%`);
    }

    bundle[placeholderKey] = fallback;
    return `%${placeholderKey}%`;
  });
}

function extractRuntimeMessages() {
  const messages = {};
  const files = listFiles(path.join(extensionRoot, 'src')).filter((file) => {
    return /\.(ts|js)$/.test(file) && !file.includes(`${path.sep}dist${path.sep}`);
  });

  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8');
    const scriptKind = file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
    visitSource(source, file, messages);
  }

  return messages;
}

function visitSource(source, file, messages) {
  const visit = (node) => {
    if (ts.isCallExpression(node) && isLocalizeCall(node.expression)) {
      const key = getStringLiteralText(node.arguments[0]);
      const message = getStringLiteralText(node.arguments[1]);
      if (key && message) {
        addRuntimeMessage(messages, key, message, file, source, node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

function isLocalizeCall(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'localize' || expression.text === 't';
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 'localize';
  }

  return false;
}

function getStringLiteralText(node) {
  if (!node) {
    return undefined;
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function addRuntimeMessage(messages, key, message, file, source, node) {
  const existing = messages[key];
  if (existing !== undefined && existing !== message) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    throw new Error(
      `Duplicate i18n key "${key}" has conflicting messages at ${path.relative(
        extensionRoot,
        file
      )}:${line + 1}:${character + 1}`
    );
  }

  messages[key] = message;
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function parsePlaceholder(value) {
  const match = /^%([^%]+)%$/.exec(value);
  return match ? match[1] : undefined;
}

function writeOrCheckJson(filePath, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;

  if (checkMode) {
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    if (current !== next) {
      throw new Error(
        `${path.relative(extensionRoot, filePath)} is out of date. Run npm run i18n:extract.`
      );
    }
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
