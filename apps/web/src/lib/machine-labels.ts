import type { MachineStatus } from './data';
import type { Machine } from './types';
import { relativeTime } from './time';
import { i18n } from '../i18n';

/** Tooltip for a machine row: connection info (host, or "agente" with no host) + os/capabilities + last-seen when offline. */
export function machineTitle(m: Machine, status: MachineStatus): string {
  const base =
    m.type === 'agent'
      ? m.is_local
        ? i18n.t('este computador (agente)')
        : i18n.t('agente')
      : m.type === 'ssh'
        ? `${m.ssh_user ? m.ssh_user + '@' : ''}${m.host}:${m.ssh_port}`
        : i18n.t('servidor do termhub');
  let title = base;
  if (m.os) title += ` · ${m.os}`;
  if (m.capabilities.length) title += ` · ${m.capabilities.join(', ')}`;
  if (m.type === 'agent' && status === 'offline' && m.agent_last_seen_at) title += ` · ${i18n.t('visto {{when}}', { when: relativeTime(m.agent_last_seen_at) })}`;
  return title;
}

/** A machine as a one-line choice (selects, pickers): "nome — subtítulo", or the name alone. */
export function machineLabel(m: Pick<Machine, 'name'> & { subtitle?: string | null }): string {
  return m.subtitle ? `${m.name} — ${m.subtitle}` : m.name;
}

/** The small "vX.Y.Z" next to an agent machine; `outdated` turns it into the update hint (the card in the machine form does the update). */
export function agentVersionBadge(m: Machine): { text: string; title: string; outdated: boolean } | null {
  if (m.type !== 'agent' || !m.agent_version) return null;
  if (m.update_available) return { text: `v${m.agent_version} ↑`, title: i18n.t('Nova versão do agente disponível — abra a máquina para atualizar'), outdated: true };
  return { text: `v${m.agent_version}`, title: i18n.t('agente v{{version}}', { version: m.agent_version }), outdated: false };
}

/** True when `version` ("X.Y.Z", an optional "-pre" suffix ignored) is at least `min`. Missing/unparseable → false. */
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const parse = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(min);
  if (a.some((n) => Number.isNaN(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** First agent release that can uninstall itself when its machine is deleted (`DELETE /machines/:id?uninstall=1`). */
export const AGENT_UNINSTALL_MIN_VERSION = '0.22.0';
