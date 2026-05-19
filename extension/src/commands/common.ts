import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { ProfileStore } from '../services/profileStore';
import type { ConnectionProfile } from '../types/fm';
import { type ShowErrorOptions, showErrorWithDetails, toUserErrorMessage } from '../utils/errorUx';

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
    vscode.window.showWarningMessage('No FileMaker connection profiles configured.');
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
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      detail: `${profile.database} • ${profile.authMode}`,
      profile
    })),
    {
      title: 'Select FileMaker Connection Profile',
      placeHolder: 'Choose a connection profile'
    }
  );

  return picked?.profile;
}

export async function promptForLayout(
  profile: ConnectionProfile,
  fmClient: FMClient
): Promise<string | undefined> {
  const layouts = await fmClient.listLayouts(profile);

  if (layouts.length === 0) {
    vscode.window.showWarningMessage('No layouts available for the selected profile.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(layouts, {
    title: 'Select Layout',
    placeHolder: 'Choose a layout'
  });

  return picked;
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

export async function showCommandError(
  error: unknown,
  options?: ShowErrorOptions
): Promise<void> {
  await showErrorWithDetails(error, options);
}
