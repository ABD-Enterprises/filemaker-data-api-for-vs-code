import * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';
import { reviewAndTrustCertificate, withPinnedCertificate } from './certificateTrust';
import type { ProfileStore } from './profileStore';

const NOTIFIED_KEY = 'filemakerDataApiTools.legacyTlsNotified';

/** The older "skip all certificate checks" setting, without a pinned certificate replacing it. */
export function profilesSkippingCertificateChecks(profiles: ConnectionProfile[]): ConnectionProfile[] {
  return profiles.filter((profile) => profile.allowSelfSigned === true && !profile.pinnedCertSha256);
}

/**
 * Once per profile, tells the user that it skips every certificate check and offers to replace
 * that with a pinned certificate. The profile keeps working either way (and keeps its warning in
 * the profile list and status bar); "Not now" is remembered so the notification does not nag.
 */
export async function notifyAboutLegacyTlsProfiles(
  profileStore: ProfileStore,
  state: vscode.Memento,
  onChanged: () => void
): Promise<void> {
  const already = new Set(state.get<string[]>(NOTIFIED_KEY, []));
  const pending = profilesSkippingCertificateChecks(await profileStore.listProfiles()).filter((p) => !already.has(p.id));
  for (const profile of pending) {
    already.add(profile.id);
    await state.update(NOTIFIED_KEY, [...already]);
    const choice = await vscode.window.showWarningMessage(
      `"${profile.name}" skips all certificate checks (an older setting), so anyone on the network could impersonate the server. Convert it to trust just the server's certificate?`,
      'Convert to pinned certificate',
      'Not now'
    );
    if (choice !== 'Convert to pinned certificate') {
      continue;
    }
    const decision = await reviewAndTrustCertificate(profile, { previousSha256: undefined });
    if (decision) {
      await profileStore.upsertProfile(withPinnedCertificate(profile, decision));
      onChanged();
    }
  }
}
