import type { EnterpriseFeatureId, RoleGuard } from '../enterprise/roleGuard';
import { isFeatureEnabled, isOfflineModeOn, type ConfigurationReader } from './policySetting';

/**
 * Why the FM Web preview bridge must refuse a route, or undefined to allow it. The preview
 * app is repository code, so writes and script runs get the limits the user's own commands do.
 */
export function bridgeRouteRefusal(
  route: string,
  configuration: ConfigurationReader,
  roleGuard: Pick<RoleGuard, 'getFeatureGuard'>
): string | undefined {
  const isWrite = route === '/editRecord' || route === '/createRecord' || route === '/deleteRecord';
  const isScript = route === '/runScript';
  if ((isWrite || isScript) && isOfflineModeOn(configuration)) {
    return 'Offline mode is enabled; the preview app cannot change data or run scripts.';
  }
  if (isScript && !isFeatureEnabled(configuration, 'features.scriptRunner.enabled')) {
    return 'Script running is disabled by the setting filemaker.features.scriptRunner.enabled.';
  }
  if (isWrite && !isFeatureEnabled(configuration, 'features.recordEdit.enabled')) {
    return 'Record editing is disabled by the setting filemaker.features.recordEdit.enabled.';
  }
  // Writes need both the general write permission and record editing; scripts need the
  // script runner. Each is checked against enterprise policy.
  const features: EnterpriseFeatureId[] = isScript
    ? ['scriptRunner']
    : isWrite
      ? ['writeOperations', 'recordEdit']
      : [];
  for (const feature of features) {
    const guard = roleGuard.getFeatureGuard(feature);
    if (!guard.allowed) {
      return guard.reason ?? 'Not allowed by enterprise policy.';
    }
  }
  return undefined;
}
