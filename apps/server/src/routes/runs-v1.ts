import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { API_RUN_STATUSES, type ApiRun, type StoredRunEvent } from '../db/repositories/api-runs.js';
import { installV1Auth, recordV1Call } from '../runs/v1-auth.js';
import { ownProject, toRunView } from '../runs/view.js';
import { RUN_LIMITS } from '../runs/limits.js';
import type { CreateRunInput, RunService } from '../runs/service.js';
import { audit } from '../auth/audit.js';
import { notFound } from '../lib/errors.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const listQuery = z.object({
  project: z.string().trim().min(1).max(64).optional(),
  status: z.enum(API_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** The body of `POST /runs` (spec "Contract"). Unknown fields are refused, so a typo never runs silently with defaults. */
export const createRunBody = z
  .object({
    project: z.string().trim().min(1).max(64),
    prompt: z.string().min(1).max(RUN_LIMITS.maxPromptChars),
    capabilities: z.array(z.enum(['read', 'edit', 'run_commands'])).min(1).max(3).default(['read']),
    model_class: z.enum(['fast', 'default', 'strong']).optional(),
    model: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\[\]/-]+$/).nullish(),
    provider: z.enum(['claude', 'codex']).nullish(),
    machine: z.string().trim().min(1).max(100).nullish(),
    budget: z
      .object({ timeout_s: z.number().int().min(10).max(RUN_LIMITS.maxTimeoutS).default(RUN_LIMITS.defaultTimeoutS) })
      .strict()
      .default({ timeout_s: RUN_LIMITS.defaultTimeoutS }),
    idempotency_key: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

/** `Last-Event-ID` (or `?after=`): the last `seq` the client has; anything else reads as "from the start". */
function lastSeq(header: unknown, query: unknown): number {
  const raw = (Array.isArray(header) ? header[0] : header) ?? (query as { after?: unknown } | undefined)?.after;
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** One SSE message: `id` is the event's seq, so `Last-Event-ID` resumes after it. */
export function sseFrame(e: StoredRunEvent): string {
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, at: e.at, ...e.payload })}\n\n`;
}

const accepted = (run: ApiRun) => ({ run_id: run.id, status: run.status, events_url: `/api/v1/runs/${run.id}/events` });

export interface RunsV1Options {
  service: Pick<RunService, 'create' | 'cancel' | 'subscribe'>;
  /** SSE keep-alive comment interval (15 s). */
  keepAliveMs?: number;
}

/**
 * The personal runs API, `/api/v1` (TER-1176, spec "Contract"): bearer-only, the token owner's own
 * runs. Create (202, then the run goes on in the background), read, list, stream the events over SSE
 * and cancel. A client that disconnects from the stream never cancels the run.
 */
export async function runsV1Routes(app: FastifyInstance, repos: Repositories, opts: RunsV1Options) {
  installV1Auth(app, repos);
  const { service } = opts;

  app.post('/runs', async (request, reply) => {
    const { user, token } = request.runsAuth!;
    const body = createRunBody.parse(request.body);
    const input: CreateRunInput = {
      project: body.project,
      prompt: body.prompt,
      capabilities: [...new Set(body.capabilities)],
      model_class: body.model_class,
      model: body.model ?? null,
      provider: body.provider ?? null,
      machine: body.machine ?? null,
      timeout_s: body.budget.timeout_s,
      idempotency_key: body.idempotency_key ?? null,
    };
    const { run, created } = await service.create({ user, token }, input);
    request.runsProjectId = run.project_id;
    if (created) {
      // Never the prompt: what ran where, and with which powers.
      await audit(repos, request, 'api_run.create', {
        target: { type: 'api_run', id: run.id },
        meta: { project_id: run.project_id, token_id: token.id, capabilities: run.capabilities, provider: input.provider, machine: input.machine, timeout_s: input.timeout_s, prompt_chars: input.prompt.length },
      });
    }
    return reply.code(202).send(accepted(run));
  });

  app.get('/runs', async (request) => {
    const { user } = request.runsAuth!;
    const q = listQuery.parse(request.query);
    const project = q.project ? await ownProject(repos, user, q.project) : undefined;
    if (project) request.runsProjectId = project.id;
    const runs = await repos.apiRuns.listForUser(user.id, { projectId: project?.id, status: q.status, limit: q.limit });
    return { runs: runs.map(toRunView) };
  });

  app.get('/runs/:id', async (request) => {
    const { user } = request.runsAuth!;
    const { id } = idParam.parse(request.params);
    const run = await repos.apiRuns.findForUser(user.id, id);
    if (!run) throw notFound('Run não encontrada');
    request.runsProjectId = run.project_id;
    return toRunView(run);
  });

  app.get('/runs/:id/events', async (request, reply) => {
    const { user } = request.runsAuth!;
    const { id } = idParam.parse(request.params);
    const run = await repos.apiRuns.findForUser(user.id, id);
    if (!run) throw notFound('Run não encontrada');
    request.runsProjectId = run.project_id;
    const after = lastSeq(request.headers['last-event-id'], request.query);

    reply.hijack();
    recordV1Call(repos, request, 200, reply.elapsedTime);
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx (the proxy in front of the app) must not buffer the stream.
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');

    let open = true;
    const keepAlive = setInterval(() => {
      if (open) raw.write(': keep-alive\n\n');
    }, opts.keepAliveMs ?? 15_000);
    keepAlive.unref?.();
    const close = () => {
      if (!open) return;
      open = false;
      clearInterval(keepAlive);
      unsubscribe();
    };
    const unsubscribe = service.subscribe(
      id,
      after,
      (e) => {
        if (open) raw.write(sseFrame(e));
      },
      () => {
        close();
        raw.end();
      },
    );
    // The client went away: stop streaming. The run itself goes on; only POST /cancel stops it.
    request.raw.on('close', close);
    raw.on('close', close);
  });

  app.post('/runs/:id/cancel', async (request, reply) => {
    const { user } = request.runsAuth!;
    const { id } = idParam.parse(request.params);
    const run = await service.cancel(user.id, id);
    if (!run) throw notFound('Run não encontrada');
    request.runsProjectId = run.project_id;
    await audit(repos, request, 'api_run.cancel', { target: { type: 'api_run', id: run.id }, meta: { project_id: run.project_id, status: run.status } });
    return reply.code(202).send({ run_id: run.id, status: run.status });
  });
}
