import { z } from 'zod';

/**
 * A project's recent Markdown files (spec 2026-10-04 recent Markdown files, TER-953): the repository docs
 * of each linked machine's project folder and the files the project's tabs cited. Names, sizes and dates
 * only; a body opens through the file preview.
 */

export const fileRecentQuery = z.object({
  project_id: z.string().min(1).max(64),
});
export type TFileRecentQuery = z.infer<typeof fileRecentQuery>;

/** Where a file sits: a repository docs folder, or `other` (cited, outside those folders). */
export const FILE_RECENT_GROUPS = ['specs', 'plans', 'lessons', 'legal', 'other'] as const;
export type FileRecentGroup = (typeof FILE_RECENT_GROUPS)[number];

/** Why a machine was left out: `offline`, `outdated` (its agent predates the list) or `unsupported` (no
 *  agent). Read as a plain string: a reason a newer server adds must not break an installed app. */
export const FILE_RECENT_SKIP_REASONS = ['offline', 'outdated', 'unsupported'] as const;

const machineRef = z.object({ id: z.string(), name: z.string() });

export const fileRecentItem = z.object({
  machine: machineRef,
  /** the file as the machine resolved it (links followed) */
  path: z.string(),
  /** relative to the project folder when the file is inside it, else null */
  rel_path: z.string().nullable(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  /** over the preview's size limit: listed, but it will not open */
  too_large: z.boolean(),
  /** a group this build does not know reads as `other` */
  group: z.enum(FILE_RECENT_GROUPS).catch('other'),
  /** named in an answer or an event of the project's tabs on this machine */
  cited: z.boolean(),
});
export type TFileRecentItem = z.infer<typeof fileRecentItem>;

export const fileRecentSkipped = z.object({
  machine: machineRef,
  reason: z.string(),
});

export const fileRecentResponse = z.object({
  items: z.array(fileRecentItem),
  skipped: z.array(fileRecentSkipped),
});
export type TFileRecentResponse = z.infer<typeof fileRecentResponse>;
