import { z } from 'zod';

/**
 * The project's repositories on the phone (spec 2026-10-07 multi-repo, TER-1061): `GET
 * /api/m/v1/projects/:id/repos`, the subset of the server's `list_project_repos` view the app reads,
 * read-only. Statuses and levels stay strings, so a value a newer server adds still parses on an older app.
 */
export const projectRepoMachine = z.object({
  machine_id: z.string(),
  /** the machine's name */
  machine: z.string(),
  /** relative to the project's folder on that machine; `.` for the folder itself */
  dir: z.string(),
  /** the folder was there and a later scan did not find it */
  missing: z.boolean(),
});

export const projectRepo = z.object({
  /** null: named by hand in the Setup, discovery has not found it yet */
  key: z.string().nullable(),
  /** owner/repo */
  full_name: z.string(),
  /** `ok`, `unsupported` (outside GitHub) or `no_access` */
  status: z.string(),
  enabled: z.boolean(),
  /** how far automatic work goes alone in this repository (`pr`, `merge`, `deploy`, `release`) */
  autonomy: z.string(),
  machines: z.array(projectRepoMachine),
});

export const projectReposResponse = z.object({
  project_id: z.string(),
  repos: z.array(projectRepo),
  /** the machines linked to the project, in order */
  machines: z.array(z.object({ machine_id: z.string(), machine: z.string() })),
});

export type ProjectRepoMachine = z.infer<typeof projectRepoMachine>;
export type ProjectRepo = z.infer<typeof projectRepo>;
export type ProjectReposResponse = z.infer<typeof projectReposResponse>;
