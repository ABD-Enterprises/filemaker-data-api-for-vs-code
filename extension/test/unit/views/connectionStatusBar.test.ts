import { describe, expect, it } from 'vitest';

import { computeConnectionStatus } from '../../../src/views/connectionStatusBar';

describe('computeConnectionStatus', () => {
  it('renders the disconnected state with a clear CTA tooltip', () => {
    const model = computeConnectionStatus(undefined);
    expect(model.text).toBe('$(circle-outline) FileMaker: Not connected');
    expect(model.tooltip).toContain('No active FileMaker profile');
    expect(model.tooltip).toContain('Click for actions');
  });

  it('renders the connected state with the profile name and database', () => {
    const model = computeConnectionStatus({
      name: 'Production',
      database: 'Contacts'
    });
    expect(model.text).toBe('$(plug) FileMaker: Production');
    expect(model.tooltip).toContain('Connected to Production');
    expect(model.tooltip).toContain('Contacts');
  });

  it('uses different icons for connected vs disconnected so users can distinguish at a glance', () => {
    const disc = computeConnectionStatus(undefined);
    const conn = computeConnectionStatus({ name: 'Dev', database: 'D' });
    expect(disc.text).toContain('$(circle-outline)');
    expect(conn.text).toContain('$(plug)');
    expect(disc.text).not.toBe(conn.text);
  });

  it('puts the profile name in the visible label so reload/restart shows current state', () => {
    // The whole point of this status bar item — it persists across reloads
    // and the user can tell at a glance which profile is active without
    // re-running Connect "to be sure".
    const model = computeConnectionStatus({ name: 'Staging-EU', database: 'Sales' });
    expect(model.text).toContain('Staging-EU');
  });
});
