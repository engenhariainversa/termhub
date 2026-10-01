import { redirectFor } from './redirect';

describe('redirectFor', () => {
  it('lets an unlocked session sit on the conversation screen', () => {
    expect(redirectFor('unlocked', ['chat', '[id]'], null, '/chat/c1')).toEqual({ target: null, shouldClear: false });
  });

  it('lets an unlocked session sit on the tabs', () => {
    expect(redirectFor('unlocked', ['(tabs)'], null, '/')).toEqual({ target: null, shouldClear: false });
  });

  it('sends an unlocked session on a session route back to the tabs', () => {
    expect(redirectFor('unlocked', ['unlock'], null, '/unlock')).toEqual({ target: '/(tabs)', shouldClear: false });
  });

  it('sends a locked session on the tabs back to Desbloquear', () => {
    expect(redirectFor('locked', ['(tabs)'], null, '/')).toEqual({ target: '/unlock', shouldClear: false });
  });

  it('sends a new session on the enrolment flow back to Início', () => {
    expect(redirectFor('new', ['enrol', 'waiting'], null, '/enrol/waiting')).toEqual({ target: '/', shouldClear: false });
  });

  it('leaves the other phases on their own screen alone', () => {
    expect(redirectFor('waiting', ['enrol', 'waiting'], null, '/enrol/waiting')).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('pin_setup', ['enrol', 'create-pin'], null, '/enrol/create-pin')).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('locked', ['unlock'], null, '/unlock')).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('new', [], null, '/')).toEqual({ target: null, shouldClear: false });
  });

  describe('a pending route (a deep link caught while locked)', () => {
    it('is followed, ahead of any other check, while the route has not caught up yet', () => {
      expect(redirectFor('unlocked', ['unlock'], '/chat/c1', '/unlock')).toEqual({ target: '/chat/c1', shouldClear: false });
    });

    it('is not cleared in the same pass that issues the replace', () => {
      // Same case as above, spelled out: `shouldClear` stays false until the route reflects it.
      const { shouldClear } = redirectFor('unlocked', ['unlock'], '/chat/c1', '/unlock');
      expect(shouldClear).toBe(false);
    });

    it('is cleared, with no further redirect, once the full path shows it was reached', () => {
      // expo-router's segments hold the file names (`[id]`), so the concrete path decides.
      expect(redirectFor('unlocked', ['chat', '[id]'], '/chat/c1', '/chat/c1')).toEqual({ target: null, shouldClear: true });
      expect(redirectFor('unlocked', ['chat', '[id]'], '/chat/c1/', '/chat/c1')).toEqual({ target: null, shouldClear: true });
    });

    it('another conversation is not the pending one: /chat/c2 does not count as arriving at /chat/c1', () => {
      expect(redirectFor('unlocked', ['chat', '[id]'], '/chat/c1', '/chat/c2')).toEqual({ target: '/chat/c1', shouldClear: false });
    });

    it('never falls through to HOME.unlocked while still pending', () => {
      // Not yet arrived and not on any session route either: still the pending route, not '/(tabs)'.
      expect(redirectFor('unlocked', ['(tabs)'], '/chat/c1', '/')).toEqual({ target: '/chat/c1', shouldClear: false });
    });
  });

  describe('a pending account deletion (TER-720)', () => {
    it('holds an unlocked session on the blocking screen, ahead of a pending route', () => {
      expect(redirectFor('unlocked', ['(tabs)'], null, '/', true)).toEqual({ target: '/account-deletion', shouldClear: false });
      expect(redirectFor('unlocked', ['chat', '[id]'], '/chat/c1', '/chat/c1', true)).toEqual({ target: '/account-deletion', shouldClear: false });
      expect(redirectFor('unlocked', ['account-deletion'], null, '/account-deletion', true)).toEqual({ target: null, shouldClear: false });
    });

    it('once cancelled, sends the blocking screen back to the tabs', () => {
      expect(redirectFor('unlocked', ['account-deletion'], null, '/account-deletion', false)).toEqual({ target: '/(tabs)', shouldClear: false });
    });

    it('leaves a locked session on Desbloquear', () => {
      expect(redirectFor('locked', ['unlock'], null, '/unlock', true)).toEqual({ target: null, shouldClear: false });
    });
  });
});
