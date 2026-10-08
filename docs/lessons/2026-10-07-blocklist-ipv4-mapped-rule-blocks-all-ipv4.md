---
symptom: "net.BlockList refuses every public IPv4 address (8.8.8.8 reported as blocked)"
tags: [node, security, ssrf, net, integrations]
evidence: fixed
card: TER-578
agent: claude
date: 2026-10-07
---
## Cause

Node's `net.BlockList` matches across families: an IPv4 address is also checked against the list's
IPv6 rules in its mapped form (`::ffff:a.b.c.d`), and an IPv4-mapped IPv6 address is checked against
the IPv4 rules. A single list holding `addSubnet('::ffff:0:0', 96, 'ipv6')` (to refuse mapped
addresses) therefore refuses **every** IPv4 address.

```
const b = new net.BlockList(); b.addSubnet('::ffff:0:0', 96, 'ipv6');
b.check('8.8.8.8', 'ipv4') // true
```

## Fix

Keep one `BlockList` per family and check an address only against the list of its own family
(`apps/server/src/integrations/public-url.ts`).

## How to check

`npm test -w @termhub/server -- src/integrations/public-url.test.ts`: the "accepts 8.8.8.8" cases pass
and `::ffff:127.0.0.1` is still refused.
