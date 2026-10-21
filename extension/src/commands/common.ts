import { GenerationCancelledError, GenerationSkippedError } from '../services/generatedFileWriter';
import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { ProfileStore } from '../services/profileStore';
import type { ConnectionProfile } from '../types/fm';
import { type ShowErrorOptions, showErrorWithDetails, toUserErrorMessage } from '../utils/errorUx';
import { describeTlsSettings } from '../utils/tlsProfile';

export interface ProfileCommandArg {
  profileId?: string;
}

export interface LayoutCommandArg extends ProfileCommandArg {
  layout?: string;
  layoutName?: string;
}

export interface SavedQueryCommandArg extends ProfileCommandArg {
  queryId?: string;
  savedQueryId?: string;
}

export async function resolveProfileFromArg(
  arg: unknown,
  profileStore: ProfileStore,
  preferActive = false
): Promise<ConnectionProfile | undefined> {
  const profileId = parseProfileId(arg);

  if (profileId) {
    const profile = await profileStore.getProfile(profileId);
    if (!profile) {
      vscode.window.showErrorMessage(`Connection profile ${profileId} not found.`);
    }

    return profile;
  }

  return pickProfile(profileStore, preferActive);
}

export async function pickProfile(
  profileStore: ProfileStore,
  preferActive = false
): Promise<ConnectionProfile | undefined> {
  const profiles = await profileStore.listProfiles();

  if (profiles.length === 0) {
    const action = await vscode.window.showWarningMessage(
      'No FileMaker connection profiles configured.',
      'Add Connection Profile'
    );
    if (action === 'Add Connection Profile') {
      await vscode.commands.executeCommand('filemakerDataApiTools.addConnectionProfile');
    }
    return undefined;
  }

  if (preferActive) {
    const activeProfileId = profileStore.getActiveProfileId();
    if (activeProfileId) {
      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
      if (activeProfile) {
        return activeProfile;
      }
    }

    if (profiles.length === 1) {
      return profiles[0];
    }
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: profile.id === profileStore.getActiveProfileId() ? 'Active' : undefined,
      detail: [
        `${profile.database} • ${new URL(profile.serverUrl).origin} • ${profile.authMode}`,
        describeTlsSettings(profile)
      ]
        .filter(Boolean)
        .join(' • '),
      profile
    })),
    {
      title: 'Select FileMaker Connection Profile',
      placeHolder: 'Choose a connection profile',
      matchOnDetail: true,
      ignoreFocusOut: true
    }
  );

  return picked?.profile;
}

export async function promptForLayout(
  profile: ConnectionProfile,
  fmClient: FMClient
): Promise<string | undefined> {
  let layouts: string[];
  try {
    layouts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `FileMaker: Loading layouts for ${profile.name}`
      },
      () => fmClient.listLayouts(profile)
    );
  } catch (error) {
    await showCommandError(error, {
      fallbackMessage: `Failed to load layouts for "${profile.name}".`,
      actions: { profileId: profile.id, settingsKey: 'filemaker.requestTimeoutMs' }
    });
    return undefined;
  }

  if (layouts.length === 0) {
    vscode.window.showWarningMessage(
      `No layouts available for "${profile.name}" (${profile.database}).`
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(layouts, {
    title: `Select Layout — ${profile.name}`,
    placeHolder: `Choose a layout in ${profile.database}`,
    ignoreFocusOut: true
  });

  return picked;
}

export async function resolveLayoutContext(
  arg: unknown,
  profileStore: ProfileStore,
  fmClient: FMClient
): Promise<{ profile: ConnectionProfile; layout: string } | undefined> {
  const contextArg = parseLayoutArg(arg);
  const profile = await resolveProfileFromArg(contextArg, profileStore, true);
  if (!profile) {
    return undefined;
  }

  const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
  return layout ? { profile, layout } : undefined;
}

export function parseProfileId(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }

  const value = arg as ProfileCommandArg;
  return typeof value.profileId === 'string' ? value.profileId : undefined;
}

export function parseLayoutArg(arg: unknown): LayoutCommandArg {
  if (!arg || typeof arg !== 'object') {
    return {};
  }

  const value = arg as LayoutCommandArg;
  const resolvedLayout =
    typeof value.layout === 'string'
      ? value.layout
      : typeof value.layoutName === 'string'
        ? value.layoutName
        : undefined;

  return {
    profileId: typeof value.profileId === 'string' ? value.profileId : undefined,
    layout: resolvedLayout
  };
}

/**
 * Runs a task behind a progress notification so long operations show that work
 * is under way. Not cancellable: the services underneath take no cancel token.
 */
export function withProgressNotification<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `FileMaker: ${title}` },
    task
  );
}

/** Record ID passed by a caller that already knows it (e.g. a Query Builder row). */
export function parseRecordIdArg(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }

  const value = (arg as { recordId?: unknown }).recordId;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  return typeof value === 'string' && /^\d+$/.test(value.trim()) ? value.trim() : undefined;
}

export function parseSavedQueryArg(arg: unknown): SavedQueryCommandArg {
  if (!arg || typeof arg !== 'object') {
    return {};
  }

  const value = arg as SavedQueryCommandArg;
  const queryId =
    typeof value.queryId === 'string'
      ? value.queryId
      : typeof value.savedQueryId === 'string'
        ? value.savedQueryId
        : undefined;

  return {
    profileId: typeof value.profileId === 'string' ? value.profileId : undefined,
    queryId
  };
}

export async function openJsonDocument(content: unknown): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(content, null, 2)
  });

  await vscode.window.showTextDocument(doc, { preview: false });
}

export function formatError(error: unknown): string {
  return toUserErrorMessage(error, 'Unexpected error.');
}

export async function showCommandError(error: unknown, options?: ShowErrorOptions): Promise<void> {
  if (error instanceof GenerationCancelledError || error instanceof GenerationSkippedError) {
    await vscode.window.showInformationMessage(error.message);
    return;
  }
  await showErrorWithDetails(error, options);
}
