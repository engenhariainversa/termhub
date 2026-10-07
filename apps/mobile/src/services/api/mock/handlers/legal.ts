// Legal acceptance routes (TER-742): `GET legal` and `POST legal/accept`. The mock user has nothing
// pending unless a test seeds it (`controls.seedLegalPending`); accepting drops the ids it names.
import { legalAcceptBody } from '../../contract';
import type { MockRouter } from '../router';
import { verifyAuth, WireError, type MockState } from '../state';

const status = (state: MockState) => ({ pending: state.legalPending, upcoming: [] });

export function registerLegalRoutes(router: MockRouter, state: MockState): void {
  router.route('GET', '/api/m/v1/legal', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'GET', htu: ctx.htu, now: ctx.now() });
    return { status: 200, body: status(state) };
  });

  router.route('POST', '/api/m/v1/legal/accept', (ctx) => {
    verifyAuth(state, { headers: ctx.headers, htm: 'POST', htu: ctx.htu, now: ctx.now() });
    const parsed = legalAcceptBody.safeParse(ctx.body);
    if (!parsed.success) throw new WireError(400, 'VALIDATION', 'Pedido inválido.');
    const accepted = new Set(parsed.data.version_ids);
    state.legalPending = state.legalPending.filter((v) => !accepted.has(v.id));
    return { status: 200, body: status(state) };
  });
}
