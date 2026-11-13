// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAutomation } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    automation: {
      promptDefaults: () => Promise.resolve({ implementer: '', integrator: '', fixer: '' }),
      workflows: () => Promise.resolve({ unlisted: [] }),
      prCi: () => Promise.resolve({ state: 'present' }),
    },
  },
}));

import { AutomationSetup } from './AutomationSetup';

const BASE: ProjectAutomation = {
  enabled: true,
  types: ['story', 'task', 'bug'],
  autonomy: 'pr',
  release_paths: [],
  store_paths: [],
  release_workflows: [],
  required_checks: [],
  epic_branch_pattern: 'epic/{ref}',
  worktrees_dir: '.worktrees',
  allowed_tools: null,
  max_parallel: null,
  resume_max: 2,
  fix_attempts: 2,
  deploy_retries: 1,
  github_retries: 1,
  daily_budget_usd: null,
  card_budget_usd: null,
  summary_hour: null,
  prompts: { implementer: null, integrator: null, fixer: null },
};

const onChange = vi.fn();

function Harness({ initial = BASE }: { initial?: ProjectAutomation }) {
  const [value, setValue] = useState(initial);
  return (
    <AutomationSetup
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

const field = () => screen.getByRole('button', { name: 'Até onde os agentes vão sozinhos' });

afterEach(() => {
  cleanup();
  onChange.mockClear();
});

describe('AutomationSetup autonomy level (TER-1165)', () => {
  it('is no native select: a field named by its label that shows the saved level', () => {
    render(<Harness initial={{ ...BASE, autonomy: 'merge' }} />);
    expect(document.querySelector('select')).toBeNull();
    expect(field()).toHaveTextContent('Merge com CI verde');
    expect(field()).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('opens the fixed list next to the field, without a filter or free text', () => {
    render(<Harness />);
    fireEvent.click(field());
    expect(screen.queryByRole('combobox')).toBeNull();
    const list = screen.getByRole('listbox');
    expect(list).toHaveFocus();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Só código e PR', 'Merge com CI verde', 'Deploy', 'Publicação (npm, OTA)']);
    expect(screen.getByTestId('automation-autonomy-panel')).toHaveClass('fixed');
  });

  it('picks with the keyboard and saves without a confirmation for Merge', () => {
    render(<Harness />);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ autonomy: 'merge' }));
    expect(field()).toHaveTextContent('Merge com CI verde');
    expect(field()).toHaveFocus();
  });

  it('raising to Deploy still asks first, and cancelling keeps the saved level', () => {
    render(<Harness />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole('option', { name: 'Deploy' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveTextContent('Só código e PR');
  });
});
