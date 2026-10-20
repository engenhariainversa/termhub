# AI account usage queried on the machine (TER-735)

Items A-1 and P-8 of `docs/legal/duvidas-advogado.md`. Claude Code's compliance page says third parties
"may not collect, store, or intermediate Claude.ai credentials or session tokens".

## Today

To show an AI account's usage, the server asks the agent (`ai.credential`) or runs a script over SSH to
print the CLI's login file (`.credentials.json` / Keychain, `auth.json`, `oauth_creds.json`,
`antigravity-oauth-token`), parses the token and calls the provider's usage endpoint itself. The token is
never stored, but it travels to the server. There is no way to turn the query off.

## Design

The credential is read **and used** on the machine that holds it. The server only ever receives usage
numbers (agent) or the provider's HTTP response, which carries no token (SSH).

### D1. Shared usage code (`@termhub/machine-ops`, `ai-usage*.ts`)

The provider logic moves from `apps/server/src/ai/{claude,chatgpt,gemini,antigravity,code-assist}.ts`
into machine-ops, unchanged in behavior, behind a transport-neutral seam:

```ts
interface UsageRequest { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }
interface UsageReply { status: number; body: unknown; text: string; retryAfterMs: number | null }
type UsageHttp = (req: UsageRequest) => Promise<UsageReply>;   // adds the credential's auth headers itself
interface UsageContext { plan: string | null; expires_at: number | null }

parseAiCredential(provider, stdout): AiCredential              // throws on a missing token
queryUsage(provider, ctx, http): Promise<AiUsageResult>         // the old fetchUsage, minus the token
fetchUsageHttp(provider, cred): UsageHttp                       // global fetch + Bearer / chatgpt-account-id
usageFromCredentialOutput(provider, stdout): Promise<AiUsageResult>  // parse + query; never throws
AI_LOGIN_HINTS: Record<AiProvider, string>
```

### D2. Agent RPC `ai.usage` (agent 0.20.0)

`ai.usage { provider, config_dir }` runs the same credential script it ran for `ai.credential`, then
`usageFromCredentialOutput` in the agent process (Node ≥ 20 has `fetch`), and answers an
`AiUsageResult` (bounded zod schema). `ai.credential` is removed from the protocol and the agent: no
release of the agent hands a token to the server any more.

### D3. Server

`getAccountUsage` (cache, back-off and stale reading unchanged) picks the path by machine type:

- **agent**: offline → "Agente desconectado"; connected agent older than `AI_USAGE_MIN_AGENT_VERSION`
  (`0.20.0`) → no query at all, `reason: 'agent_outdated'` (the web says "Atualize o agente desta máquina
  para ver o uso"). There is no fallback to reading the credential.
- **ssh**: one SSH exec per HTTP request. The script (`usageRequestScript(provider, req)`) prints the
  credential with the same `credentialScript`, extracts token/expiry/plan with `awk` into shell
  variables, and calls `curl`, which reads the `authorization` header from stdin (`-H @-`), so the token
  is neither printed nor on a command line. The server receives a meta block (expiry, plan) and curl's
  headers + body + status, parsed by `parseUsageScriptOutput`. No `curl` on the machine → a clear error.
- **local** (the server's own host): the credential never leaves that host, so the server reads it and
  calls `usageFromCredentialOutput` in-process, like the agent does.

`apps/server/src/ai/credentials.ts` (`readCredential`) and the server-side adapters are deleted.

### D4. Turning it off (per machine)

`machines.ai_usage_query` (boolean, default `true`, migration adds the column with the default so the
previous release keeps serving). When `false`, `getAccountUsage` answers
`{ ok: false, reason: 'disabled' }` without touching the machine. The switch lives on the machine's
settings next to "Troca automática de conta" and is editable through `PATCH /api/machines/:id`. Features
that rank accounts by usage (account swap, automation placement and quota) already treat a failed
reading as "unknown" and keep working.

Per machine rather than per user: the credential lives on a machine, and the owner may want the bars
for one machine and not for another; turning it off everywhere is one switch per machine.

### D5. Web

`AiAccountUsage.reason?: 'disabled' | 'agent_outdated'`. The account card shows a neutral note for
those two instead of the red error box: "Consulta de uso desligada nesta máquina" /
"Atualize o agente desta máquina para ver o uso".

### D6. Docs

`docs/security-and-network.md` ("Credentials that belong to the machine") and the Privacy Policy
(section 3.6 and the processors table) say the credential never leaves the machine and that the query
can be turned off per machine.

## Open

TER-736 (the lawyer's opinion on A-1 to A-3) may still narrow the scope, for example by stopping the
`oauth/usage` query altogether. This change only reduces what the server touches, and the per-machine
switch already lets anyone stop the query.

## Impact on other users

Everyone keeps seeing their accounts' usage; the credential no longer passes through the server. Agent
machines need agent 0.20.0 (auto-update, or the update button in Máquinas) to see usage again; until
then the card says to update. SSH machines need `curl`. New per-machine option, on by default (= today's
behavior).
