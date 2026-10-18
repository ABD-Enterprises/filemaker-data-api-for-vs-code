import { describe, expect, it } from 'vitest';

import { scrub } from '../../../src/ai/aiToolService';
import { failure, makeHarness, makeProfile, SECRET_HOST, type Harness } from './harness';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ready = (): Harness => {
  const h = makeHarness();
  h.settings.readableLayouts = { p1: ['Contacts'] };
  return h;
};
const edit = (h: Harness, signal?: AbortSignal) =>
  h.service.invoke('fm_edit_record', { layout: 'Contacts', recordId: '1', fields: { Name: 'Z' } }, { signal });

describe('a cancelled request does not write', () => {
  it('edit: aborted while the dialog is open, then approved: nothing is sent, and the user is told', async () => {
    const h = ready();
    let release: (value: boolean) => void = () => undefined;
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const pending = edit(h, controller.signal);
    await wait(20);
    controller.abort();
    await wait(10);
    expect(h.notifyCancelled).toHaveBeenCalledTimes(1);
    release(true);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });

  it('create and script: the same', async () => {
    for (const run of [
      (h: Harness, signal: AbortSignal) => h.service.invoke('fm_create_record', { layout: 'Contacts', fields: { Name: 'Z' } }, { signal }),
      (h: Harness, signal: AbortSignal) => h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Archive Old' }, { signal })
    ]) {
      const h = ready();
      let release: (value: boolean) => void = () => undefined;
      h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
      const controller = new AbortController();
      const pending = run(h, controller.signal);
      await wait(20);
      controller.abort();
      release(true);
      await expect(pending).rejects.toThrow(/cancelled/);
      expect(h.client.createRecord).not.toHaveBeenCalled();
      expect(h.client.runScript).not.toHaveBeenCalled();
      expect(h.notifyCancelled).toHaveBeenCalledTimes(1);
    }
  });

  it('delete: aborted while the first dialog or the typed-id prompt is open deletes nothing', async () => {
    const first = ready();
    let release: (value: boolean) => void = () => undefined;
    first.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const a = new AbortController();
    const pendingFirst = first.service.invoke('fm_delete_record', { layout: 'Contacts', recordId: '1' }, { signal: a.signal });
    await wait(20);
    a.abort();
    release(true);
    await expect(pendingFirst).rejects.toThrow();
    expect(first.input).not.toHaveBeenCalled();

    const second = ready();
    const b = new AbortController();
    second.input.mockImplementation(async () => {
      b.abort();
      return '1';
    });
    await expect(second.service.invoke('fm_delete_record', { layout: 'Contacts', recordId: '1' }, { signal: b.signal })).rejects.toThrow();
    expect(second.client.deleteRecord).not.toHaveBeenCalled();
  });

  it('an abort followed by a "no" is a cancelled request, not a declined one', async () => {
    const h = ready();
    let release: (value: boolean) => void = () => undefined;
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const controller = new AbortController();
    const pending = edit(h, controller.signal);
    await wait(20);
    controller.abort();
    release(false);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(h.client.editRecord).not.toHaveBeenCalled();
  });

  it('does not tell the user about a request that finished normally', async () => {
    const h = ready();
    const controller = new AbortController();
    await edit(h, controller.signal);
    controller.abort();
    expect(h.notifyCancelled).not.toHaveBeenCalled();
  });
});

describe('session reset while a layout prompt is open', () => {
  it('a "no" given before the reset is not remembered against the new session', async () => {
    const h = makeHarness();
    let release: (value: boolean) => void = () => undefined;
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));
    const pending = h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await wait(20);
    h.service.resetSession();
    release(false);
    expect(await failure(pending)).toMatch(/session was reset/);
    h.confirm.mockResolvedValue(true);
    await expect(h.service.invoke('fm_describe_layout', { layout: 'Contacts' })).resolves.toBeDefined();
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it('the old prompt finishing does not remove the new prompt\'s bookkeeping: a later call joins the new prompt', async () => {
    const h = makeHarness();
    const releases: Array<(value: boolean) => void> = [];
    h.confirm.mockImplementation(() => new Promise<boolean>((resolve) => releases.push(resolve)));
    const oldCall = h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await wait(20);
    h.service.resetSession();
    const newCall = h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await wait(20);
    expect(releases).toHaveLength(2);
    releases[0]?.(true); // the old prompt ends first
    await expect(oldCall).rejects.toThrow(/session was reset/);
    const joiner = h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await wait(20);
    expect(h.confirm).toHaveBeenCalledTimes(2); // the joiner shares the new prompt
    releases[1]?.(true);
    await expect(Promise.all([newCall, joiner])).resolves.toHaveLength(2);
  });
});

describe('scrub of the server address', () => {
  const at = (serverUrl: string) => makeProfile({ serverUrl, proxyEndpoint: undefined });

  it('ignores letter case in hosts, host:port and URLs', () => {
    const profile = at('https://FM.Corp.Example:16000');
    for (const text of ['fm.corp.example', 'FM.CORP.EXAMPLE:16000', 'https://Fm.Corp.example:16000/fmi/data', 'HTTPS://fm.corp.EXAMPLE:16000']) {
      const result = scrub(`failed at ${text} today`, profile);
      expect(result, text).not.toMatch(/corp/i);
      expect(result, text).not.toContain(':16000');
      expect(result, text).toBe('failed at [server]' + (text.includes('/fmi/data') ? '/fmi/data' : '') + ' today');
    }
  });

  it('removes an IPv6 address written compressed, expanded, unpadded, upper case, bracketed or not', () => {
    const profile = at('https://[2001:db8::1]:16000');
    for (const form of [
      '2001:db8::1',
      '2001:DB8::1',
      '[2001:db8::1]:16000',
      '2001:0db8:0000:0000:0000:0000:0000:0001',
      '2001:db8:0:0:0:0:0:1',
      '[2001:0DB8:0:0:0:0:0:1]:16000'
    ]) {
      const result = scrub(`connect ${form} refused`, profile);
      expect(result, form).not.toMatch(/db8/i);
      expect(result, form).toContain('[server]');
    }
    expect(scrub('unrelated 2001:db8::2 stays', profile)).toContain('2001:db8::2');
  });

  it('removes an IPv4 address and does not touch a longer one that contains it', () => {
    const profile = at('http://10.1.2.3:8080');
    expect(scrub('at 10.1.2.3 and 10.1.2.3:8080', profile)).toBe('at [server] and [server]');
    expect(scrub('at 110.1.2.34', profile)).toBe('at 110.1.2.34');
  });

  it('removes an internationalized host name in its Unicode and punycode forms', () => {
    const profile = at('https://bücher.example:16000');
    for (const text of ['bücher.example', 'BÜCHER.example', 'xn--bcher-kva.example', 'XN--BCHER-KVA.EXAMPLE:16000']) {
      expect(scrub(`error from ${text}`, profile), text).not.toMatch(/b.cher|bcher/i);
    }
    const typedAsPunycode = at('https://xn--bcher-kva.example');
    expect(scrub('error from bücher.example', typedAsPunycode)).toBe('error from [server]');
  });

  it('also removes the proxy endpoint', () => {
    const profile = makeProfile({ serverUrl: 'https://fm.example.com', proxyEndpoint: 'https://Proxy.Internal.Example/api' });
    expect(scrub('via proxy.internal.example', profile)).toBe('via [server]');
  });

  it('matches the host only as a whole token', () => {
    const profile = at('https://fm:16000');
    expect(scrub('confirm the fm server; fmi.example fm-2', profile)).toBe('confirm the [server] server; fmi.example fm-2');
  });
});

describe('values the tools return', () => {
  it('lose every form of the server address, but ordinary addresses and domains in data are left alone', async () => {
    const h = ready();
    h.profile.serverUrl = `https://${SECRET_HOST.toUpperCase()}:16000`;
    h.records.get('1')!.fieldData.Notes = `see ${SECRET_HOST}:16000 and ${SECRET_HOST.toUpperCase()}`;
    h.records.get('1')!.fieldData.Email = 'ada@elsewhere.example.org';
    h.records.get('1')!.fieldData.Name = 'Ada at 192.0.2.7 in /srv/data';
    const result = JSON.stringify(await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' }));
    expect(result.toLowerCase()).not.toContain(SECRET_HOST);
    expect(result).toContain('ada@elsewhere.example.org');
    expect(result).toContain('192.0.2.7');
    expect(result).toContain('/srv/data');
  });
});
