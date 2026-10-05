// A project's recent Markdown files, as the Arquivos screen shows them (spec 2026-10-04 recent Markdown
// files D7): the group chips, each row's line, and why a machine is missing from the list.
import { formatBytes } from '@/features/chat/viewmodel/attachments';
import { relativeTime } from '@/features/shared/relative-time';
import { t, tk } from '@/i18n';
import type { FileRecentGroup, TFileRecentItem } from '@/services/api/contract';
import { dirOf } from '@/features/file-preview/model/refusals';

/** The Arquivos screen of a project. */
export function fileRecentRoute(projectId: string) {
  return { pathname: '/file-recent' as const, params: { project_id: projectId } };
}

/** A chip: every file, one group, or the files the project's tabs cited. */
export type FileRecentFilter = 'all' | FileRecentGroup | 'cited';

/** The chips in the order they show; each label is a translation key, shown with `t(label)`. */
export const FILE_RECENT_FILTERS: { key: FileRecentFilter; label: string }[] = [
  { key: 'all', label: tk('Todos') },
  { key: 'specs', label: tk('Specs') },
  { key: 'plans', label: tk('Planos') },
  { key: 'lessons', label: tk('Lições') },
  { key: 'legal', label: tk('Jurídico') },
  { key: 'other', label: tk('Outros') },
  { key: 'cited', label: tk('Citados') },
];

export function filterFiles(items: TFileRecentItem[], filter: FileRecentFilter): TFileRecentItem[] {
  if (filter === 'all') return items;
  if (filter === 'cited') return items.filter((f) => f.cited);
  return items.filter((f) => f.group === filter);
}

/** How many machines the list spans: the machine shows on each row only when there is more than one. */
export function machineCount(items: TFileRecentItem[]): number {
  return new Set(items.map((f) => f.machine.id)).size;
}

/** The folder a row shows: relative to the project when the file is inside it, else the absolute one. */
export function folderOf(item: TFileRecentItem): string {
  return dirOf(item.rel_path ?? item.path);
}

/** The path the preview opens: relative to the project when it can be, else as the machine resolved it. */
export function previewPath(item: TFileRecentItem): string {
  return item.rel_path ?? item.path;
}

/** The row's second line: folder, machine (when the list spans several), size and date. */
export function fileMeta(item: TFileRecentItem, showMachine: boolean, now: number): string {
  const parts: string[] = [];
  const folder = folderOf(item);
  if (folder) parts.push(folder);
  if (showMachine) parts.push(item.machine.name);
  parts.push(formatBytes(item.size));
  parts.push(relativeTime(item.mtime, now));
  return parts.join(' · ');
}

/** Why a machine's files are missing from the list; a reason a newer server adds reads as a generic line. */
export function skippedText(machine: string, reason: string): string {
  switch (reason) {
    case 'outdated':
      return t('Atualize o agente de {{name}} para listar os arquivos dela', { name: machine });
    case 'offline':
      return t('{{name}} está desconectada', { name: machine });
    case 'unsupported':
      return t('{{name}} não usa o agente do termhub', { name: machine });
    default:
      return t('Não foi possível listar os arquivos de {{name}}', { name: machine });
  }
}
