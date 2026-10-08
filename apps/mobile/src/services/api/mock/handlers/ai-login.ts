// "Refazer login" of an AI CLI account (TER-1047): the status of the fixtures' accounts and a login flow
// that always reaches the end. Claude takes any code but `errado` (which fails, as a wrong paste does);
// Codex's "Já autorizei" succeeds. A login that ends well marks the account `ok` and, when it was
// `login_required`, names the `t-api` tab as stuck on it.
import { aiLoginResumeBody, aiLoginSubmitBody, type AiLoginStatusRow } from '../../contract';
import type { MockRouter } from '../router';
import { verifyAuth, WireError, type MockState } from '../state';

const ACCOUNTS: Omit<AiLoginStatusRow, 'state' | 'checked_at'>[] = [
  { account_id: 'acc-1', label: 'Claude Pedro', provider: 'claude', machine_id: 'm-jarvis', machine_name: 'jarvis', supported: true },
  { account_id: 'acc-2', label: 'Claude Trabalho', provider: 'claude', machine_id: 'm-jarvis', machine_name: 'jarvis', supported: true },
  { account_id: 'acc-3', label: 'Codex Pedro', provider: 'chatgpt', machine_id: 'm-jarvis', machine_name: 'jarvis', supported: true },
];

const STUCK_TAB = { id: 't-api', name: 'api', project_id: 'p-termhub' };

export function registerAiLoginRoutes(router: MockRouter, state: MockState): void {
  let started = 0;
  const account = (id: string) => {
    const row = ACCOUNTS.find((a) => a.account_id === id);
    if (!row) throw new WireError(404, 'NOT_FOUND', 'Conta não encontrada');
    return row;
  };
  const flow = (accountId: string, loginId: string) => {
    const f = state.aiLoginFlows.get(loginId);
    if (!f || f.accountId !== accountId) throw new WireError(404, 'NOT_FOUND', 'Esse login não está mais em andamento. Comece de novo.');
    return f;
  };

  router.route('GET', '/api/m/v1/ai-accounts/login-status', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    const checkedAt = new Date(ctx.now()).toISOString();
    return { status: 200, body: { accounts: ACCOUNTS.map((a) => ({ ...a, state: state.aiLoginStates.get(a.account_id) ?? 'ok', checked_at: checkedAt })) } };
  });

  router.route('POST', '/api/m/v1/ai-accounts/:id/login', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const row = account(ctx.params.id!);
    const loginId = `login-${++started}`;
    const needsCode = row.provider === 'claude';
    state.aiLoginFlows.set(loginId, { accountId: row.account_id, needsCode });
    return {
      status: 200,
      body: {
        login_id: loginId,
        url: needsCode ? 'https://claude.com/cai/oauth/authorize?code=true' : 'https://auth.openai.com/codex/device',
        user_code: needsCode ? null : 'ABCD-EFGH1',
        needs_code: needsCode,
        expires_at: new Date(ctx.now() + 15 * 60_000).toISOString(),
      },
    };
  });

  router.route('POST', '/api/m/v1/ai-accounts/:id/login/resume', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    account(ctx.params.id!);
    const { tab_ids } = aiLoginResumeBody.parse(ctx.body);
    return { status: 200, body: { resumed: tab_ids.filter((id) => state.tabs.has(id)) } };
  });

  router.route('POST', '/api/m/v1/ai-accounts/:id/login/:loginId/submit', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const accountId = ctx.params.id!;
    account(accountId);
    const f = flow(accountId, ctx.params.loginId!);
    const { code } = aiLoginSubmitBody.parse(ctx.body ?? {});
    if (f.needsCode && !code) throw new WireError(400, 'CODE_REQUIRED', 'Cole o código que a página mostrou.');
    state.aiLoginFlows.delete(ctx.params.loginId!);
    if (f.needsCode && code === 'errado') return { status: 200, body: { ok: false, message: 'O Claude recusou o código. Comece de novo.', stuck_tabs: [] } };
    const wasRequired = state.aiLoginStates.get(accountId) === 'login_required';
    state.aiLoginStates.set(accountId, 'ok');
    return { status: 200, body: { ok: true, message: null, stuck_tabs: wasRequired ? [STUCK_TAB] : [] } };
  });

  router.route('DELETE', '/api/m/v1/ai-accounts/:id/login/:loginId', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now() });
    account(ctx.params.id!);
    state.aiLoginFlows.delete(ctx.params.loginId!);
    return { status: 200, body: { cancelled: true } };
  });
}
