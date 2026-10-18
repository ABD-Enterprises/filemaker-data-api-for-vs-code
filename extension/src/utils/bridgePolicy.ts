import type { RoleGuard } from '../enterprise/roleGuard';
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
  const feature = isScript ? 'scriptRunner' : isWrite ? 'writeOperations' : undefined;
  const guard = feature ? roleGuard.getFeatureGuard(feature) : undefined;
  return guard && !guard.allowed
    ? (guard.reason ?? 'Not allowed by enterprise policy.')
    : undefined;
}
