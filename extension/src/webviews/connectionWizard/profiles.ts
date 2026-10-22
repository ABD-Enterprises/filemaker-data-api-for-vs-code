import * as vscode from 'vscode';
import { loadConnectionProfileTemplate, PROFILE_TEMPLATE_LOCKED_FIELDS } from '../../services/profileTemplate';
import { originOf } from './credentials';
import type { WizardContext } from './context';
import { certificateAddress, sendCertificateState } from './certificates';

export async function sendInit(ctx: WizardContext): Promise<void> {
  await ctx.panel.webview.postMessage({
    type: 'init',
    testPolicy: ctx.options.getTestPolicy?.() ?? 'warn',
    // In Restricted Mode the page shows a notice at the top (see RESTRICTED_NOTICE in the page).
    restricted: !vscode.workspace.isTrusted
  });
}

export async function sendLoadProfile(ctx: WizardContext): Promise<void> {
  ctx.templateOrigins.clear();
  ctx.certificateTarget = ctx.editingProfile ? certificateAddress(ctx.editingProfile) : undefined;
  ctx.certState = ctx.editingProfile
    ? {
        pin: ctx.editingProfile.pinnedCertSha256
          ? {
              sha256: ctx.editingProfile.pinnedCertSha256,
              allowExpired: ctx.editingProfile.pinnedCertAllowExpired === true
            }
          : undefined,
        legacy: ctx.editingProfile.allowSelfSigned === true
      }
    : { legacy: false };
  if (ctx.editingProfile) {
    await ctx.panel.webview.postMessage({
      type: 'loadProfile',
      payload: ctx.editingProfile,
      hasPassword: Boolean(await ctx.secretStore.getPassword(ctx.editingProfile.id))
    });
    await sendCertificateState(ctx);
    return;
  }
  await sendCertificateState(ctx);

  const result = await loadConnectionProfileTemplate();
  if (result.warning) {
    ctx.logger.warn('Profile template ignored.', {
      sourcePath: result.sourcePath,
      message: result.warning
    });
    await ctx.panel.webview.postMessage({
      type: 'templateWarning',
      message: result.warning
    });
    return;
  }

  if (result.template) {
    for (const origin of [originOf(result.template.serverUrl), originOf(result.template.proxyEndpoint)]) {
      if (origin) {
        ctx.templateOrigins.add(origin);
      }
    }
    await ctx.panel.webview.postMessage({
      type: 'loadTemplate',
      payload: {
        template: result.template,
        sourcePath: result.sourcePath,
        hosts: [...ctx.templateOrigins],
        lockedFields: result.template.locked ? PROFILE_TEMPLATE_LOCKED_FIELDS : []
      }
    });
  }
}
