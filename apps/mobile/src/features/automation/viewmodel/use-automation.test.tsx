import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { TAutomationSetup } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { AUTOMATION_MSG, autonomyConfirmText } from '../model/automation';
import { useAutomation, type AutomationDeps } from './use-automation';

const OFF: TAutomationSetup = { enabled: false, types: ['story', 'task', 'bug'], autonomy: 'pr', worktrees_dir: '~/wt' };
const PIN_REQUIRED = new ApiError(401, 'PIN_REQUIRED', 'Confirme com o PIN para ligar ou ampliar o trabalho automático.');

async function setup(initial: TAutomationSetup = OFF) {
  const api = {
    getAutomationSetup: jest.fn(async () => initial),
    saveAutomationSetup: jest.fn(async (_a: unknown, _p: string, automation: TAutomationSetup) => automation),
  };
  const requestPinProof = jest.fn(async (_id: string, perform: (proof: { challenge: string; pin_proof: string }) => Promise<void>) => perform({ challenge: 'c1', pin_proof: 'p1' }));
  const session = { auth: () => ({}) as never, handleApiError: jest.fn(() => false), requestPinProof };
  const deps = { api, session: () => session } as unknown as AutomationDeps;
  const hook = await renderHook(() => useAutomation('p1', deps));
  return { api, requestPinProof, session, hook };
}

async function loaded(initial?: TAutomationSetup) {
  const t = await setup(initial);
  await act(async () => {
    await t.hook.result.current.load();
  });
  return t;
}

describe('useAutomation', () => {
  it('loads the block and edits it without saving', async () => {
    const t = await loaded();
    expect(t.hook.result.current.draft).toEqual(OFF);
    expect(t.hook.result.current.canSave).toBe(false);
    await act(async () => {
      t.hook.result.current.edit((d) => ({ ...d, enabled: true }));
    });
    expect(t.hook.result.current.canSave).toBe(true);
    expect(t.api.saveAutomationSetup).not.toHaveBeenCalled();
  });

  it('enabling opens the confirmation with the web copy and saves nothing until confirmed', async () => {
    const t = await loaded();
    await act(async () => {
      t.hook.result.current.edit((d) => ({ ...d, enabled: true }));
    });
    await act(async () => {
      await t.hook.result.current.save();
    });
    expect(t.hook.result.current.confirming).toBe(autonomyConfirmText('pr'));
    expect(t.api.saveAutomationSetup).not.toHaveBeenCalled();
    await act(async () => {
      t.hook.result.current.cancelConfirm();
    });
    expect(t.hook.result.current.confirming).toBeNull();
    expect(t.api.saveAutomationSetup).not.toHaveBeenCalled();
  });

  it('confirming saves, and a PIN_REQUIRED answer opens the PIN sheet for the project action, then saves with the proof', async () => {
    const t = await loaded();
    t.api.saveAutomationSetup.mockRejectedValueOnce(PIN_REQUIRED);
    await act(async () => {
      t.hook.result.current.edit((d) => ({ ...d, enabled: true }));
    });
    await act(async () => {
      await t.hook.result.current.save();
    });
    await act(async () => {
      await t.hook.result.current.confirm();
    });
    expect(t.requestPinProof).toHaveBeenCalledWith('automation-setup:p1', expect.any(Function), 'automation_setup', AUTOMATION_MSG.pinTitle);
    expect(t.api.saveAutomationSetup).toHaveBeenNthCalledWith(1, expect.anything(), 'p1', expect.objectContaining({ enabled: true }));
    expect(t.api.saveAutomationSetup).toHaveBeenNthCalledWith(2, expect.anything(), 'p1', expect.objectContaining({ enabled: true }), { challenge: 'c1', pin_proof: 'p1' });
    await waitFor(() => expect(t.hook.result.current.notice).toBe(AUTOMATION_MSG.saved));
    expect(t.hook.result.current.saved?.enabled).toBe(true);
  });

  it('closing the PIN sheet saves nothing and shows no error', async () => {
    const t = await loaded();
    t.api.saveAutomationSetup.mockRejectedValueOnce(PIN_REQUIRED);
    t.requestPinProof.mockRejectedValueOnce(new Error('CANCELLED'));
    await act(async () => {
      t.hook.result.current.edit((d) => ({ ...d, enabled: true }));
    });
    await act(async () => {
      await t.hook.result.current.save();
      await t.hook.result.current.confirm();
    });
    expect(t.hook.result.current.saveError).toBeNull();
    expect(t.hook.result.current.saved?.enabled).toBe(false);
  });

  it('lowering the level or turning off saves at once, without a sheet or a PIN', async () => {
    const t = await loaded({ ...OFF, enabled: true, autonomy: 'release' });
    await act(async () => {
      t.hook.result.current.edit((d) => ({ ...d, autonomy: 'pr' }));
    });
    await act(async () => {
      await t.hook.result.current.save();
    });
    expect(t.hook.result.current.confirming).toBeNull();
    expect(t.requestPinProof).not.toHaveBeenCalled();
    expect(t.api.saveAutomationSetup).toHaveBeenCalledTimes(1);
    expect(t.api.saveAutomationSetup.mock.calls[0]![2]).toMatchObject({ enabled: true, autonomy: 'pr', worktrees_dir: '~/wt' });
  });

  it('shows the server sentence when the save is refused', async () => {
    const t = await loaded({ ...OFF, enabled: true });
    t.api.saveAutomationSetup.mockRejectedValueOnce(new ApiError(400, 'VALIDATION', 'use {ref}'));
    await act(async () => {
      t.hook.result.current.edit((d) => ({ ...d, autonomy: 'merge' }));
    });
    await act(async () => {
      await t.hook.result.current.save();
    });
    expect(t.hook.result.current.saveError).toBe('use {ref}');
  });
});
