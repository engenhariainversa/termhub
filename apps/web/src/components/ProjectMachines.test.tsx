// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project } from '../lib/types';

const { linkMachine, updateProjectMachine, unlinkMachine } = vi.hoisted(() => ({ linkMachine: vi.fn(), updateProjectMachine: vi.fn(), unlinkMachine: vi.fn() }));
const machines = [{ id: 'm1', name: 'mac', subtitle: null }, { id: 'm2', name: 'jarvis', subtitle: 'servidor da sala' }, { id: 'm3', name: 'mini', subtitle: null }] as Machine[];
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines,
    statuses: { m1: 'online', m2: 'offline' },
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    linkMachine,
    updateProjectMachine,
    unlinkMachine,
  }),
}));
vi.mock('./DirectoryBrowser', () => ({ DirectoryBrowser: () => null }));

import { ProjectMachines } from './ProjectMachines';

const project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/src/p1', position: 0 }] } as Project;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectMachines', () => {
  it('lists the links and offers only unlinked machines to add', () => {
    render(<ProjectMachines project={project} />);
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/src/p1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    fireEvent.click(screen.getByLabelText('Máquina'));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('option', { name: 'mac' })).not.toBeInTheDocument();
  });

  it('labels each machine in the "Vincular máquina" select as "nome — subtítulo"', () => {
    render(<ProjectMachines project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    fireEvent.click(screen.getByLabelText('Máquina'));
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['jarvis — servidor da sala', 'mini']);
  });

  it('links a machine with its directory', async () => {
    linkMachine.mockResolvedValue(undefined);
    render(<ProjectMachines project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    fireEvent.click(screen.getByLabelText('Máquina'));
    fireEvent.click(screen.getByRole('option', { name: 'jarvis — servidor da sala' }));
    fireEvent.change(screen.getByLabelText('Diretório'), { target: { value: '/w' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() => expect(linkMachine).toHaveBeenCalledWith('p1', { machine_id: 'm2', cwd: '/w', create_dir: true }));
  });

  it('saves an edited directory and unlinks after confirming', async () => {
    // Real updateProjectMachine/unlinkMachine update project.machines in state before returning,
    // which (for a save) re-renders LinkRow with the same key — no remount — and (for unlink) drops
    // the link, unmounting the row in the same render pass as the parent updates. Reproduce both here
    // (instead of just resolving a value) so the row survives its own save (and the notice outlives
    // the row on unlink) the way the real flow does.
    const setterRef: { current: ((updater: (p: Project) => Project) => void) | null } = { current: null };
    updateProjectMachine.mockImplementation(async (_projectId: string, machineId: string, cwd: string) => {
      setterRef.current?.((p) => ({ ...p, machines: p.machines.map((l) => (l.machine_id === machineId ? { ...l, cwd } : l)) }));
    });
    unlinkMachine.mockImplementation(async (_projectId: string, machineId: string) => {
      setterRef.current?.((p) => ({ ...p, machines: p.machines.filter((l) => l.machine_id !== machineId) }));
      return 2;
    });

    function Harness({ initial }: { initial: Project }) {
      const [p, setP] = useState(initial);
      setterRef.current = setP;
      return <ProjectMachines project={p} />;
    }

    render(<Harness initial={project} />);
    fireEvent.change(screen.getByDisplayValue('/src/p1'), { target: { value: '/moved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateProjectMachine).toHaveBeenCalledWith('p1', 'm1', '/moved', false));
    // The row must survive its own successful save: the "Salvo." message set right after must not be
    // lost to a remount, and the input must still show the (now-saved) value.
    await screen.findByText('Salvo.');
    expect(screen.getByDisplayValue('/moved')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' })); // the row's link
    fireEvent.click(screen.getAllByRole('button', { name: 'Desvincular' })[1]); // the dialog's confirm
    await waitFor(() => expect(unlinkMachine).toHaveBeenCalledWith('p1', 'm1'));
    expect(screen.queryByDisplayValue('/moved')).not.toBeInTheDocument();
    await screen.findByText('2 tabs fechadas.');
  });

  it("resyncs a row's cwd when the link changes from outside (e.g. saved elsewhere)", () => {
    // LinkRow is keyed on machine_id alone (not cwd, so its own save does not remount it — see the
    // test above); an external cwd change instead relies on its `useEffect([link.cwd])` to resync the
    // local draft.
    function Harness({ initial }: { initial: Project }) {
      const [p, setP] = useState(initial);
      return (
        <>
          <ProjectMachines project={p} />
          <button
            onClick={() => setP((x) => ({ ...x, machines: x.machines.map((l) => (l.machine_id === 'm1' ? { ...l, cwd: '/moved-elsewhere' } : l)) }))}
          >
            simulate external update
          </button>
        </>
      );
    }
    render(<Harness initial={project} />);
    expect(screen.getByDisplayValue('/src/p1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'simulate external update' }));
    expect(screen.getByDisplayValue('/moved-elsewhere')).toBeInTheDocument();
  });
});
