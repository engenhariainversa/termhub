import { z } from 'zod';

/**
 * A text file an agent wrote, read on its machine when the person opens its path (spec 2026-10-04 file
 * preview, TER-941). The server relays the file through the machine's agent and stores nothing.
 */

/** A path as an answer names it: absolute, `~/…` or relative to the project folder. */
export const filePreviewPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !/[\0\n\r]/.test(p), 'invalid path');

/** Which file: `tab_id` (the tab's machine and project), else `project_id` (its machines, the first that
 *  has the file), else the person's machines (absolute or `~/` paths only). `machine_id` narrows to one. */
export const filePreviewQuery = z.object({
  path: filePreviewPath,
  tab_id: z.string().min(1).max(64).optional(),
  project_id: z.string().min(1).max(64).optional(),
  machine_id: z.string().min(1).max(64).optional(),
});
export type TFilePreviewQuery = z.infer<typeof filePreviewQuery>;

/** Why there is no body: `missing`, `outside` (not in an allowed folder), `hidden` (a dot folder), `type`,
 *  `not_file`, `too_large`, `binary`, `eperm`. Read as a plain string: a reason a newer server adds must
 *  not break an installed app. */
export const FILE_PREVIEW_REFUSALS = ['missing', 'outside', 'hidden', 'type', 'not_file', 'too_large', 'binary', 'eperm'] as const;

const machineRef = z.object({ id: z.string(), name: z.string() });

export const filePreviewOk = z.object({
  status: z.literal('ok'),
  machine: machineRef,
  project_id: z.string().nullable(),
  /** the file as the machine resolved it (links followed) */
  path: z.string(),
  /** relative to the project folder when the file is inside it, else null */
  rel_path: z.string().nullable(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  content: z.string(),
  /** the file on GitHub, when it is inside the project folder and the project has a repository */
  github_url: z.string().nullable(),
});

export const filePreviewRefused = z.object({
  status: z.string(),
  machine: machineRef.nullable(),
  size: z.number().int().nonnegative().optional(),
});

export const filePreviewResponse = z.union([filePreviewOk, filePreviewRefused]);
export type TFilePreviewOk = z.infer<typeof filePreviewOk>;
export type TFilePreviewResponse = z.infer<typeof filePreviewResponse>;
