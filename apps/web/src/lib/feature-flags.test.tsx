// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from './types';
import { FeatureGate, useFeatureFlag } from './feature-flags';

const authMock: { user: Partial<User> | null } = { user: null };
vi.mock('./auth', () => ({ useAuth: () => authMock }));

function Probe() {
  return <span>{useFeatureFlag('subscriptions') ? 'on' : 'off'}</span>;
}

function Screen() {
  return (
    <>
      <p>Projetos</p>
      <FeatureGate flag="subscriptions" fallback={<p>sem planos</p>}>
        <p>Planos</p>
        <p>Seu período de teste termina em 3 dias</p>
      </FeatureGate>
    </>
  );
}

afterEach(() => {
  cleanup();
  authMock.user = null;
});

describe('useFeatureFlag', () => {
  it('is off signed out, on an older server that sends no flags, and while the flag is off', () => {
    render(<Probe />);
    expect(screen.getByText('off')).toBeTruthy();
    cleanup();
    authMock.user = { id: 'u1' };
    render(<Probe />);
    expect(screen.getByText('off')).toBeTruthy();
    cleanup();
    authMock.user = { id: 'u1', features: { subscriptions: false } };
    render(<Probe />);
    expect(screen.getByText('off')).toBeTruthy();
  });

  it('is on when the server says so for this person', () => {
    authMock.user = { id: 'u1', features: { subscriptions: true } };
    render(<Probe />);
    expect(screen.getByText('on')).toBeTruthy();
  });
});

describe('FeatureGate', () => {
  it('shows nothing of plans or trial notices while the flag is off', () => {
    authMock.user = { id: 'u1', features: { subscriptions: false } };
    render(<Screen />);
    expect(screen.getByText('Projetos')).toBeTruthy();
    expect(screen.queryByText('Planos')).toBeNull();
    expect(screen.queryByText(/período de teste/)).toBeNull();
    expect(screen.getByText('sem planos')).toBeTruthy();
  });

  it('shows them to a tester with the flag on', () => {
    authMock.user = { id: 'u1', features: { subscriptions: true } };
    render(<Screen />);
    expect(screen.getByText('Planos')).toBeTruthy();
    expect(screen.getByText(/período de teste/)).toBeTruthy();
    expect(screen.queryByText('sem planos')).toBeNull();
  });
});
