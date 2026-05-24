import type { BehaviorBinding } from '../../fmweb/layoutSchema';
import type { ConnectionProfile, RunScriptRequest } from '../../types/fm';
import { localize } from '../../i18n';

export interface ExecuteBehaviorBindingArgs {
  behavior: BehaviorBinding;
  objectName: string;
  layoutName: string;
  fmLayoutName?: string;
  profile?: ConnectionProfile;
  runScript: (profile: ConnectionProfile, request: RunScriptRequest) => Promise<unknown>;
}

export interface BehaviorExecutionResult {
  ok: boolean;
  action: string;
  stub: boolean;
  message: string;
  detail?: unknown;
}

export async function executeBehaviorBinding(
  args: ExecuteBehaviorBindingArgs
): Promise<BehaviorExecutionResult> {
  const action = args.behavior.type;
  const objectLabel =
    args.objectName.trim().length > 0
      ? args.objectName
      : localize('webviews.layoutMode.behavior.objectFallback', 'Object');

  if (!action) {
    return {
      ok: false,
      action: 'none',
      stub: true,
      message: localize(
        'webviews.layoutMode.behavior.noBinding',
        '{0} has no behavior binding.',
        objectLabel
      )
    };
  }

  if (action === 'runScript') {
    const scriptName = normalizeOptionalString(args.behavior.scriptName);
    if (!scriptName) {
      return {
        ok: false,
        action,
        stub: true,
        message: localize(
          'webviews.layoutMode.behavior.missingScriptName',
          '{0} is missing a script name.',
          objectLabel
        )
      };
    }

    if (!args.profile) {
      return {
        ok: true,
        action,
        stub: true,
        message: localize(
          'webviews.layoutMode.behavior.runScriptPreview',
          'Preview stub: would run script "{0}". Select an active profile to execute live.',
          scriptName
        )
      };
    }

    const layout =
      normalizeOptionalString(args.fmLayoutName) ?? normalizeOptionalString(args.layoutName);
    if (!layout) {
      return {
        ok: false,
        action,
        stub: true,
        message: localize(
          'webviews.layoutMode.behavior.noFmLayout',
          'Cannot run "{0}" because no FileMaker layout is mapped.',
          scriptName
        )
      };
    }

    const request: RunScriptRequest = {
      layout,
      scriptName,
      scriptParam: normalizeOptionalString(args.behavior.parameter)
    };

    try {
      const result = await args.runScript(args.profile, request);
      return {
        ok: true,
        action,
        stub: false,
        message: localize(
          'webviews.layoutMode.behavior.scriptExecuted',
          'Executed script "{0}" on "{1}" using profile "{2}".',
          scriptName,
          layout,
          args.profile.name
        ),
        detail: result
      };
    } catch (error) {
      return {
        ok: false,
        action,
        stub: false,
        message: formatError(error)
      };
    }
  }

  if (action === 'goToWebLayout') {
    const targetLayoutId = normalizeOptionalString(args.behavior.targetLayoutId);
    if (!targetLayoutId) {
      return {
        ok: false,
        action,
        stub: true,
        message: localize(
          'webviews.layoutMode.behavior.missingWebLayout',
          '{0} is missing a target web layout ID.',
          objectLabel
        )
      };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: localize(
        'webviews.layoutMode.behavior.webLayoutPreview',
        'Preview stub: would navigate to web layout "{0}".',
        targetLayoutId
      )
    };
  }

  if (action === 'goToFmLayout') {
    const targetLayoutName = normalizeOptionalString(args.behavior.targetFmLayoutName);
    if (!targetLayoutName) {
      return {
        ok: false,
        action,
        stub: true,
        message: localize(
          'webviews.layoutMode.behavior.missingFmLayout',
          '{0} is missing a target FileMaker layout name.',
          objectLabel
        )
      };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: localize(
        'webviews.layoutMode.behavior.fmLayoutPreview',
        'Preview stub: would open FileMaker layout "{0}".',
        targetLayoutName
      )
    };
  }

  if (action === 'openUrl') {
    const url = normalizeOptionalString(args.behavior.url);
    if (!url) {
      return {
        ok: false,
        action,
        stub: true,
        message: localize(
          'webviews.layoutMode.behavior.missingUrl',
          '{0} is missing a URL.',
          objectLabel
        )
      };
    }

    return {
      ok: true,
      action,
      stub: true,
      message: localize(
        'webviews.layoutMode.behavior.openUrlPreview',
        'Preview stub: would open {0}.',
        url
      )
    };
  }

  const dialogId = normalizeOptionalString(args.behavior.dialogId) ?? 'dialog';
  return {
    ok: true,
    action,
    stub: true,
    message: localize(
      'webviews.layoutMode.behavior.dialogPreview',
      'Preview stub: would show dialog "{0}".',
      dialogId
    )
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return localize(
    'webviews.layoutMode.behavior.unexpectedError',
    'Unexpected behavior execution error.'
  );
}
