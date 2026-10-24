import { expect, it } from 'vitest';
import { describeNetworkFailure } from '../../src/utils/networkErrors';

it('explains dropped connections without claiming that http servers are https-only', () => {
  const http = describeNetworkFailure('ECONNRESET', { host: 'fm.local', port: '8080', protocol: 'http:' })!;
  const https = describeNetworkFailure('ECONNRESET', { host: 'fm.local', port: '443', protocol: 'https:' })!;
  expect(http.message).toContain('http://fm.local:8080');
  expect(http.message).not.toContain('only accept https');
  expect(https.message).not.toContain('try an https');
  expect(https.message).toContain('firewall or proxy');
});
