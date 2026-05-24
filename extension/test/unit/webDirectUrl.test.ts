import { describe, expect, it } from 'vitest';

import { buildWebDirectRecordUrl, normalizeWebDirectBasePath } from '../../src/utils/webDirectUrl';

describe('WebDirect URL helpers', () => {
  const profile = {
    serverUrl: 'https://fm.example.com',
    database: 'Contacts DB'
  };

  it('builds a record URL with encoded database, layout, and record id', () => {
    expect(
      buildWebDirectRecordUrl({
        profile,
        layout: 'Customer Detail',
        recordId: '42 9'
      })
    ).toBe('https://fm.example.com/fmi/webd/db/Contacts%20DB/Customer%20Detail#recordid=42%209');
  });

  it('uses a configured base path without trailing slash drift', () => {
    expect(
      buildWebDirectRecordUrl({
        profile,
        layout: 'Invoices',
        recordId: '1',
        basePath: 'custom/webdirect/'
      })
    ).toBe('https://fm.example.com/custom/webdirect/db/Contacts%20DB/Invoices#recordid=1');
  });

  it('normalizes blank base paths to the default', () => {
    expect(normalizeWebDirectBasePath('   ')).toBe('/fmi/webd');
  });

  it('rejects missing required inputs', () => {
    expect(() =>
      buildWebDirectRecordUrl({
        profile: { ...profile, database: '' },
        layout: 'Contacts',
        recordId: '1'
      })
    ).toThrow(/database/i);
  });
});
