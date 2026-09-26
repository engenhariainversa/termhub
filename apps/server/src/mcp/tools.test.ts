import { expect, it } from 'vitest';
import { parseArgs, TOOLS } from './tools.js';

it('read_screen says what ⟦…⟧ means and what styled: false means', () => {
  const d = TOOLS.find((t) => t.name === 'read_screen')!.description;
  expect(d).toContain('Text between ⟦ and ⟧ is dimmed');
  expect(d).toContain('never report it as an unsent message and never press Enter because of it');
  expect(d).toContain('styled: false');
});

it('link_project_machine, set_project_machine_cwd and unlink_project_machine are exposed with the right scope and grant', () => {
  const link = TOOLS.find((t) => t.name === 'link_project_machine')!;
  expect(link.scope).toBe('terminals');
  expect(link.resource).toBe('projects');
  expect(link.action).toBe('create');

  const setCwd = TOOLS.find((t) => t.name === 'set_project_machine_cwd')!;
  expect(setCwd.scope).toBe('terminals');
  expect(setCwd.resource).toBe('projects');
  expect(setCwd.action).toBe('update');

  const unlink = TOOLS.find((t) => t.name === 'unlink_project_machine')!;
  expect(unlink.scope).toBe('terminals');
  expect(unlink.resource).toBe('projects');
  expect(unlink.action).toBe('delete');
});

it('link_project_machine and set_project_machine_cwd refuse a relative cwd and accept a ~ path', () => {
  const link = TOOLS.find((t) => t.name === 'link_project_machine')!;
  expect(parseArgs(link, { project_id: 'p1', machine_id: 'm1', cwd: 'termhub' }).ok).toBe(false);
  expect(parseArgs(link, { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' }).ok).toBe(true);

  const setCwd = TOOLS.find((t) => t.name === 'set_project_machine_cwd')!;
  expect(parseArgs(setCwd, { project_id: 'p1', machine_id: 'm1', cwd: 'termhub' }).ok).toBe(false);
  expect(parseArgs(setCwd, { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' }).ok).toBe(true);
});

it('unlink_project_machine takes project_id, machine_id and an optional confirm', () => {
  const unlink = TOOLS.find((t) => t.name === 'unlink_project_machine')!;
  expect(parseArgs(unlink, { project_id: 'p1', machine_id: 'm1' }).ok).toBe(true);
  expect(parseArgs(unlink, { project_id: 'p1', machine_id: 'm1', confirm: true }).ok).toBe(true);
  expect(parseArgs(unlink, { machine_id: 'm1' }).ok).toBe(false);
});
