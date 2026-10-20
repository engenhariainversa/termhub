// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../lib/types';

const { updateProject } = vi.hoisted(() => ({ updateProject: vi.fn() }));
vi.mock('../lib/data', () => ({ useData: () => ({ updateProject, deleteProject: vi.fn() }) }));
vi.mock('./SetupForm', () => ({ SetupForm: () => null }));
vi.mock('./ProjectMachines', () => ({ ProjectMachines: () => null }));
vi.mock('./BoardColumnsSettings', () => ({ BoardColumnsSettings: () => null }));

import { ProjectSettings } from './ProjectSettings';

const project = (over: Partial<Project> = {}) => ({ id: 'p1', key: 'P1', name: 'p1', description: null, status: 'active', machines: [], ...over }) as Project;
const optIn = () => screen.getByRole('checkbox', { name: 'Importar as páginas deliberadas do ai-memory como lições não verificadas' });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectSettings — ai-memory lessons (TER-1021)', () => {
  it('is off by default and turning it on saves the project option', async () => {
    updateProject.mockResolvedValue(project({ ai_memory_lessons: true }));
    render(<ProjectSettings project={project()} />, { wrapper: MemoryRouter });
    expect(optIn()).not.toBeChecked();
    fireEvent.click(optIn());
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith('p1', { ai_memory_lessons: true }));
  });

  it('turning it off saves false', async () => {
    updateProject.mockResolvedValue(project());
    render(<ProjectSettings project={project({ ai_memory_lessons: true })} />, { wrapper: MemoryRouter });
    expect(optIn()).toBeChecked();
    fireEvent.click(optIn());
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith('p1', { ai_memory_lessons: false }));
  });
});
