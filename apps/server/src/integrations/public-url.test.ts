import { describe, expect, it } from 'vitest';
import { checkUrlShape, isInternalAddress } from './public-url.js';

describe('isInternalAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '64:ff9b::a00:1', '2002:a00:1::1',
    'not-an-ip',
  ])('refuses %s', (ip) => expect(isInternalAddress(ip)).toBe(true));

  it.each(['104.192.141.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])('accepts %s', (ip) => expect(isInternalAddress(ip)).toBe(false));
});

describe('checkUrlShape', () => {
  it.each([
    ['http://acme.atlassian.net', 'https'],
    ['ftp://acme.atlassian.net', 'https'],
    ['https://user:pw@acme.atlassian.net', 'usuário'],
    ['https://acme.atlassian.net/?x=1', 'query'],
    ['https://jira', 'domínio completo'],
    ['https://localhost', 'domínio completo'],
    ['https://localhost.', 'domínio completo'],
    ['https://db.internal', 'domínio completo'],
    ['https://127.0.0.1', 'rede interna'],
    ['https://[::1]', 'rede interna'],
    ['https://2130706433', 'rede interna'], // 127.0.0.1 as a decimal, normalized by URL
    ['not a url', 'inválido'],
  ])('refuses %s', (raw, reason) => {
    const r = checkUrlShape(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });

  it('accepts a public https site, with a context path', () => {
    expect(checkUrlShape('https://jira.acme.com/jira/').ok).toBe(true);
  });
});
