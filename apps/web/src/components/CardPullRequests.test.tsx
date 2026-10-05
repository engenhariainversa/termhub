// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('../lib/api', () => ({ api: { tasks: { pullRequests: (...a: unknown[]) => listMock(...a) } } }));

import { CardPullRequests } from './CardPullRequests';

afterEach(cleanup);

describe('CardPullRequests', () => {
  it('lists the card PRs', async () => {
    listMock.mockResolvedValue({ pull_requests: [{ number: 7, url: 'https://github.com/acme/app/pull/7', title: 'x', state: 'merged', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'passed', deploy_url: 'https://github.com/acme/app/actions/runs/1' }] });
    render(<CardPullRequests taskId="t1" />);
    expect(await screen.findByRole('link', { name: /PR #7/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'deploy ok' })).toHaveAttribute('href', 'https://github.com/acme/app/actions/runs/1');
    expect(listMock).toHaveBeenCalledWith('t1');
  });

  it('shows the release runs of a merged PR with the published version', async () => {
    listMock.mockResolvedValue({
      pull_requests: [
        {
          number: 7, url: 'https://github.com/acme/app/pull/7', title: 'x', state: 'merged', draft: false, ci_state: 'passed', ci_summary: { total: 1, passed: 1, failed: 0, running: 0, failing: [] }, deploy_state: 'passed', deploy_url: 'd',
          release_runs: [{ workflow: 'publish-agent.yml', state: 'passed', url: 'https://github.com/acme/app/actions/runs/9', version: '0.19.0' }, { workflow: 'ota.yml', state: 'failed', url: null, version: null }],
        },
      ],
    });
    render(<CardPullRequests taskId="t1" />);
    expect(await screen.findByRole('link', { name: 'publicado v0.19.0' })).toHaveAttribute('href', 'https://github.com/acme/app/actions/runs/9');
    expect(screen.getByText('publicação falhou: ota.yml')).toBeInTheDocument();
  });

  it('renders nothing without PRs', async () => {
    listMock.mockResolvedValue({ pull_requests: [] });
    const { container } = render(<CardPullRequests taskId="t1" />);
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the call rejects', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    const { container } = render(<CardPullRequests taskId="t1" />);
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the call throws synchronously', async () => {
    listMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const { container } = render(<CardPullRequests taskId="t1" />);
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
