import { redirectFor } from './redirect';

// The app has no Node types: the test reads `app/` through Jest's own `require` and `__dirname`.
declare const __dirname: string;
const fs = require('fs') as { readdirSync(dir: string): string[] };
const path = require('path') as { join(...parts: string[]): string };

describe('redirectFor', () => {
  it('lets an unlocked session sit on the conversation screen', () => {
    expect(redirectFor('unlocked', ['chat', '[id]'], null, '/chat/c1')).toEqual({ target: null, shouldClear: false });
  });

  it('lets an unlocked session sit on the tabs', () => {
    expect(redirectFor('unlocked', ['(tabs)'], null, '/')).toEqual({ target: null, shouldClear: false });
  });

  it('lets an unlocked session open a terminal session from Chats → Sessões (TER-1002)', () => {
    expect(redirectFor('unlocked', ['session', '[tabId]'], null, '/session/t1')).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('unlocked', ['session', 'new'], null, '/session/new')).toEqual({ target: null, shouldClear: false });
  });

  it('a pushed session ("aba terminou") stays open once reached, not bounced to the tabs after the clear', () => {
    expect(redirectFor('unlocked', ['session', '[tabId]'], '/session/t1', '/session/t1')).toEqual({ target: null, shouldClear: true });
    expect(redirectFor('unlocked', ['session', '[tabId]'], null, '/session/t1')).toEqual({ target: null, shouldClear: false });
  });

  it('lets an unlocked session stay on every screen of app/ that belongs to no other phase', () => {
    const appDir = path.join(__dirname, '../../../../app');
    const otherPhases = new Set(['_layout', 'index', 'enrol', 'unlock', 'account-deletion', 'legal-acceptance']);
    const screens = fs
      .readdirSync(appDir)
      .map((name) => name.replace(/\.tsx$/, ''))
      .filter((name) => !otherPhases.has(name));
    expect(screens).toEqual(expect.arrayContaining(['(tabs)', 'chat', 'session', 'file-preview']));
    for (const first of screens) {
      expect({ first, ...redirectFor('unlocked', [first], null, `/${first}`) }).toEqual({ first, target: null, shouldClear: false });
    }
  });

  it('sends an unlocked session on another phase screen back to the tabs', () => {
    expect(redirectFor('unlocked', ['unlock'], null, '/unlock')).toEqual({ target: '/(tabs)', shouldClear: false });
    expect(redirectFor('unlocked', ['enrol', 'create-pin'], null, '/enrol/create-pin')).toEqual({ target: '/(tabs)', shouldClear: false });
    expect(redirectFor('unlocked', [], null, '/')).toEqual({ target: '/(tabs)', shouldClear: false });
  });

  it('keeps a locked session off the screens the unlocked phase owns', () => {
    expect(redirectFor('locked', ['session', '[tabId]'], null, '/session/t1')).toEqual({ target: '/unlock', shouldClear: false });
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

  describe('a legal version still to accept (TER-742)', () => {
    it('holds an unlocked session on the acceptance screen, ahead of a pending route', () => {
      expect(redirectFor('unlocked', ['(tabs)'], null, '/', false, true)).toEqual({ target: '/legal-acceptance', shouldClear: false });
      expect(redirectFor('unlocked', ['chat', '[id]'], '/chat/c1', '/chat/c1', false, true)).toEqual({ target: '/legal-acceptance', shouldClear: false });
      expect(redirectFor('unlocked', ['legal-acceptance'], null, '/legal-acceptance', false, true)).toEqual({ target: null, shouldClear: false });
    });

    it('a deep link waits on the acceptance screen, then is followed once accepted', () => {
      expect(redirectFor('unlocked', ['legal-acceptance'], '/chat/c1', '/legal-acceptance', false, true)).toEqual({ target: null, shouldClear: false });
      expect(redirectFor('unlocked', ['legal-acceptance'], '/chat/c1', '/legal-acceptance', false, false)).toEqual({ target: '/chat/c1', shouldClear: false });
    });

    it('a pending account deletion keeps priority', () => {
      expect(redirectFor('unlocked', ['(tabs)'], null, '/', true, true)).toEqual({ target: '/account-deletion', shouldClear: false });
      expect(redirectFor('unlocked', ['legal-acceptance'], null, '/legal-acceptance', true, true)).toEqual({ target: '/account-deletion', shouldClear: false });
    });

    it('once accepted, sends the acceptance screen back to the tabs', () => {
      expect(redirectFor('unlocked', ['legal-acceptance'], null, '/legal-acceptance', false, false)).toEqual({ target: '/(tabs)', shouldClear: false });
    });

    it('leaves a locked session on Desbloquear', () => {
      expect(redirectFor('locked', ['unlock'], null, '/unlock', false, true)).toEqual({ target: null, shouldClear: false });
    });
  });
});
