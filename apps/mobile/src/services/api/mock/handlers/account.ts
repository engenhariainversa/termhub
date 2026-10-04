// Account deletion routes (TER-720): `GET`/`POST`/`DELETE account/deletion`. Status and cancel
// stay reachable while the deletion is pending (`allowPendingDeletion`); the request itself needs a
// PIN proof over a decision challenge for `ACCOUNT_DELETION_ACTION_ID`, signed `delete_account`.
import { ACCOUNT_DELETION_ACTION_ID, ACCOUNT_DELETION_GRACE_DAYS, accountDeletionBody } from '../../contract';
import type { MockRouter } from '../router';
import { verifyAuth, type MockState } from '../state';
import { checkDecisionProof } from './chat';

const DAY_MS = 24 * 60 * 60_000;

function status(state: MockState) {
  const d = state.accountDeletion;
  return {
    pending: d !== null,
    requested_at: d ? new Date(d.requestedAt).toISOString() : null,
    scheduled_at: d ? new Date(d.scheduledAt).toISOString() : null,
  };
}

export function registerAccountRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/account/deletion', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now(), allowPendingDeletion: true });
    return { status: 200, body: status(state) };
  });

  router.route('POST', '/api/m/v1/account/deletion', (ctx) => {
    const { device } = verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const body = accountDeletionBody.parse(ctx.body);
    const now = ctx.now();
    checkDecisionProof(state, device, ACCOUNT_DELETION_ACTION_ID, 'delete_account', body, now);
    state.accountDeletion = { requestedAt: now, scheduledAt: now + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS };
    return { status: 200, body: status(state) };
  });

  router.route('DELETE', '/api/m/v1/account/deletion', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'DELETE', htu: ctx.htu, now: ctx.now(), allowPendingDeletion: true });
    state.accountDeletion = null;
    return { status: 200, body: status(state) };
  });
}
