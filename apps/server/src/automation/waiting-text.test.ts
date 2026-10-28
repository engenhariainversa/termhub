import { describe, expect, it } from 'vitest';
import type { RoomReading } from './machine-room.js';
import { placeDetailText, roomText } from './waiting-text.js';

const GB = 1024 * 1024;
const reading = (over: Partial<RoomReading> = {}): RoomReading => ({
  ok: false, limit: 'memory', mem_available_kb: 2.1 * GB, disk_free_kb: 93 * GB, disk_mount: '/', load1: 3, ncpu: 12, at: '2026-10-28T10:00:00.000Z', ...over,
});

describe('roomText (TER-1138)', () => {
  it('names each limit with the value read, the minimum and the way out', () => {
    expect(roomText('pt-BR', reading(), 33)).toBe('memória disponível 2,1 GB < 4 GB (33 abas abertas); feche abas paradas ou use outra máquina do projeto');
    expect(roomText('en', reading(), 33)).toBe('available memory 2.1 GB < 4 GB (33 open tabs); close idle tabs or use another machine of the project');
    expect(roomText('pt-BR', reading({ limit: 'disk', disk_free_kb: 10 * GB, disk_mount: '/mnt/hd' }))).toBe('disco livre em /mnt/hd 10 GB < 20 GB; libere disco ou use outra máquina do projeto');
    expect(roomText('es', reading({ limit: 'load', load1: 14.25 }), 5)).toBe('carga 14,3 ≥ 12 CPUs (5 pestañas abiertas); espera a que baje la carga o usa otra máquina del proyecto');
    expect(roomText('pt-BR', reading({ limit: 'reading' }))).toBe('a leitura de memória/disco/carga falhou');
  });

  it('a value missing from the reading says so', () => {
    expect(roomText('pt-BR', reading({ mem_available_kb: null }))).toBe('memória não lida');
    expect(roomText('pt-BR', reading({ limit: 'disk', disk_free_kb: null }))).toBe('disco da pasta de worktrees não encontrado');
    expect(roomText('pt-BR', reading({ limit: 'load', ncpu: null }))).toBe('carga não lida');
  });

  it('the queue line of a crowded machine carries it; without a reading it keeps the short text', () => {
    const detail = { listed: 1, machines: [{ id: 'm1', name: 'hulk', why: 'no_room' as const, room: reading(), tabs: 33 }], accounts: [] };
    expect(placeDetailText('pt-BR', detail)).toBe('máquina hulk: sem folga: memória disponível 2,1 GB < 4 GB (33 abas abertas); feche abas paradas ou use outra máquina do projeto');
    expect(placeDetailText('pt-BR', { ...detail, machines: [{ id: 'm1', name: 'hulk', why: 'no_room' }] })).toBe('máquina hulk: sem folga (memória/disco/carga)');
  });
});
