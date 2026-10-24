import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import { deliverSnippet, type SnippetDelivery } from '../snippets/deliver';
import { includeAuthByDefault } from '../snippets/settings';
import {
  SNIPPET_FORMATS,
  SNIPPET_OPERATION_LABELS,
  isSnippetFormat,
  type SnippetOperation,
  type SnippetOperationKind
} from '../snippets/model';
import { parseFindRequest, parseSnippetOperation } from '../snippets/operationInput';
import { promptForLayout, resolveProfileFromArg, showCommandError } from './common';

interface RegisterCopyRequestCommandDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  logger: Logger;
}

const OPERATION_ORDER: SnippetOperationKind[] = [
  'find',
  'getRecord',
  'createRecord',
  'editRecord',
  'deleteRecord',
  'runScript',
  'login',
  'listLayouts',
  'listScripts',
  'layoutMetadata',
  'uploadContainer'
];

const EDITOR_CHOICE = 'editor';

/**
 * `FileMaker: Copy Request as Code…`. It asks for the operation, what the operation needs, and the
 * format, then copies the request for the active profile (or opens it in a new editor). A caller can
 * pass `{ profileId, operation, format, destination }` to skip the questions. Nothing is sent to the
 * server by this command except listing layouts to pick from, and nothing is written to a file.
 */
export function registerCopyRequestCommands(deps: RegisterCopyRequestCommandDeps): vscode.Disposable[] {
  const { profileStore, fmClient, logger } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.copyRequestAsCode', async (arg: unknown) => {
      try {
        await copyRequestAsCode(arg, profileStore, fmClient);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to copy the request.',
          logger,
          logMessage: 'Failed to copy the request as code.'
        });
      }
    })
  ];
}

async function copyRequestAsCode(arg: unknown, profileStore: ProfileStore, fmClient: FMClient): Promise<void> {
  const profile = await resolveProfileFromArg(arg, profileStore, true);
  if (!profile) {
    return;
  }

  const given = typeof arg === 'object' && arg !== null ? (arg as Record<string, unknown>) : {};
  const includeAuthHeader = includeAuthByDefault();

  // Programmatic use: a validated operation and format skip every question.
  const givenOperation = given.operation === undefined ? undefined : parseSnippetOperation(given.operation);
  if (given.operation !== undefined && !givenOperation) {
    void vscode.window.showErrorMessage('Copy Request as Code: the operation argument is not valid.');
    return;
  }
  if (givenOperation && isSnippetFormat(given.format)) {
    await deliverSnippet(profile, givenOperation, {
      format: given.format,
      destination: given.destination === 'editor' ? 'editor' : 'clipboard',
      includeAuthHeader
    });
    return;
  }

  const kind = await pickOperation();
  if (!kind) {
    return;
  }
  const operation = await askForOperation(kind, profile, fmClient);
  if (!operation) {
    return;
  }
  const delivery = await pickDelivery(includeAuthHeader);
  if (!delivery) {
    return;
  }

  await deliverSnippet(profile, operation, delivery);
}

async function pickOperation(): Promise<SnippetOperationKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    OPERATION_ORDER.map((operation) => ({ label: SNIPPET_OPERATION_LABELS[operation], operation })),
    { title: 'Copy Request as Code: which request?', placeHolder: 'Choose the Data API request to copy', ignoreFocusOut: true }
  );
  return picked?.operation;
}

async function pickDelivery(includeAuthHeader: boolean): Promise<SnippetDelivery | undefined> {
  const items = [
    ...SNIPPET_FORMATS.map((format) => ({ label: format.label, id: format.id as string })),
    { label: 'Open as a .http file in a new editor (save it where you want)', id: EDITOR_CHOICE }
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Copy Request as Code: which format?',
    placeHolder: 'Choose the format. Passwords and tokens are never included.',
    ignoreFocusOut: true
  });
  if (!picked) {
    return undefined;
  }
  return picked.id === EDITOR_CHOICE
    ? { format: 'http', destination: 'editor', includeAuthHeader }
    : { format: picked.id as SnippetDelivery['format'], destination: 'clipboard', includeAuthHeader };
}

async function askText(title: string, prompt: string, options: { required?: boolean; value?: string } = {}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt,
    value: options.value,
    ignoreFocusOut: true,
    validateInput: options.required ? (text) => (text.trim() ? undefined : 'Enter a value.') : undefined
  });
}

async function askJsonObject(title: string, prompt: string, value: string): Promise<Record<string, unknown> | undefined> {
  const text = await vscode.window.showInputBox({
    title,
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (candidate) => {
      try {
        const parsed: unknown = JSON.parse(candidate);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? undefined : 'Enter a JSON object.';
      } catch {
        return 'Enter valid JSON.';
      }
    }
  });
  if (text === undefined) {
    return undefined;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function askForOperation(
  kind: SnippetOperationKind,
  profile: Parameters<typeof promptForLayout>[0],
  fmClient: FMClient
): Promise<SnippetOperation | undefined> {
  const title = `Copy Request as Code: ${SNIPPET_OPERATION_LABELS[kind]}`;
  if (kind === 'login' || kind === 'listLayouts' || kind === 'listScripts') {
    return { kind };
  }

  const layout = await promptForLayout(profile, fmClient);
  if (!layout) {
    return undefined;
  }

  switch (kind) {
    case 'layoutMetadata':
      return { kind, layout };
    case 'find': {
      let request: ReturnType<typeof parseFindRequest>;
      const text = await vscode.window.showInputBox({
        title,
        prompt: 'Find request: a JSON list of requests, for example [{ "Name": "Smith" }]',
        value: '[{}]',
        ignoreFocusOut: true,
        validateInput: (candidate) => {
          try {
            request = parseFindRequest(JSON.parse(candidate));
          } catch {
            return 'Enter valid JSON.';
          }
          return request ? undefined : 'Enter a list of find requests, or an object with a "query" list.';
        }
      });
      if (text === undefined) {
        return undefined;
      }
      request = parseFindRequest(JSON.parse(text));
      return request ? { kind, layout, request } : undefined;
    }
    case 'createRecord': {
      const fieldData = await askJsonObject(title, 'Field data to create the record with (JSON object)', '{"<field name>": "<value>"}');
      return fieldData ? { kind, layout, fieldData } : undefined;
    }
    case 'editRecord': {
      const recordId = await askText(title, 'Record ID', { required: true });
      if (recordId === undefined) {
        return undefined;
      }
      const fieldData = await askJsonObject(title, 'Fields to change (JSON object). The modId is left for you to fill in.', '{"<field name>": "<new value>"}');
      return fieldData ? { kind, layout, recordId: recordId.trim(), fieldData } : undefined;
    }
    case 'getRecord':
    case 'deleteRecord': {
      const recordId = await askText(title, 'Record ID', { required: true });
      return recordId === undefined ? undefined : { kind, layout, recordId: recordId.trim() };
    }
    case 'runScript': {
      const scriptName = await askText(title, 'Script name, exactly as it appears in FileMaker', { required: true });
      if (scriptName === undefined) {
        return undefined;
      }
      const scriptParam = await askText(title, 'Script parameter (optional)');
      if (scriptParam === undefined) {
        return undefined;
      }
      const recordId = await askText(title, 'Record ID (optional; blank for no record context)');
      if (recordId === undefined) {
        return undefined;
      }
      return {
        kind,
        layout,
        scriptName,
        scriptParam: scriptParam.length > 0 ? scriptParam : undefined,
        recordId: recordId.trim() || undefined
      };
    }
    case 'uploadContainer': {
      const recordId = await askText(title, 'Record ID', { required: true });
      if (recordId === undefined) {
        return undefined;
      }
      const fieldName = await askText(title, 'Container field name', { required: true });
      if (fieldName === undefined) {
        return undefined;
      }
      return { kind, layout, recordId: recordId.trim(), fieldName, withModId: true };
    }
  }
  return undefined;
}
