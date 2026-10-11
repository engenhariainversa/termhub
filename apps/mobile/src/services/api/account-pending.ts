// Account deletion pending (TER-720): every `403 ACCOUNT_PENDING_DELETION` the API answers emits
// this, and the account store marks the account as pending, so the app shows the blocking screen
// instead of the tabs. A signal, so `services/api` never imports a feature store.
import { signal } from '../signal';

export const accountPendingDeletion = signal();
