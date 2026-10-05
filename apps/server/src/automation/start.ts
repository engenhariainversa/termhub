import { startAgent } from '../control/agents.js';
import type { Repositories } from '../db/repositories/index.js';
import { createGithubWriteClient } from '../integrations/github-write.js';
import { ensureEpicBranch, ensureWorkspace } from './branches.js';
import { dispatcherInstanceId, startDispatcher, type Dispatcher, type DispatcherDeps } from './dispatcher.js';
import { followRun, startFollower, type FollowerDeps } from './follower.js';
import { accountPeak } from './placement.js';
import { onRateLimit, resumeAfterReset } from './quota.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export interface Automation {
  instance: string;
  dispatcher: Dispatcher;
  followerDeps: FollowerDeps;
  /** Stops the follower and the dispatcher (bounded wait for the starts in flight). */
  stop(): Promise<void>;
}

/**
 * The agentic board's server side (spec §8), as app.ts runs it: the dispatcher that starts agents on
 * eligible cards and the follower of the runs this instance drives, under one instance id and the
 * process's `lifecycle` — the same object the SIGTERM drain flips, so a draining colour claims, types and
 * takes over nothing. Both colours run it; the claim row picks one per card. `dispatcher` and `follower`
 * replace the real collaborators (tests); `schedule: false` starts no timers.
 */
export function startAutomation(o: {
  repos: Repositories;
  lifecycle: { readonly draining: boolean };
  log?: Log;
  instance?: string;
  schedule?: boolean;
  dispatcher?: Partial<Omit<DispatcherDeps, 'repos' | 'instance' | 'lifecycle'>>;
  follower?: Partial<Omit<FollowerDeps, 'repos' | 'instance' | 'lifecycle'>>;
}): Automation {
  const { repos, lifecycle, log } = o;
  const instance = o.instance ?? dispatcherInstanceId();
  // D16: a run on a usage limit waits for its account's reset (or follows the automatic swap)
  const followerDeps: FollowerDeps = { repos, instance, lifecycle, log, onRateLimited: (run, tab) => onRateLimit(followerDeps, run, tab), ...o.follower };
  const stopFollower = o.schedule === false ? () => {} : startFollower(followerDeps);
  const dispatcher = startDispatcher(
    {
      repos,
      instance,
      lifecycle,
      // a run taken over from a silent instance may have stopped while nobody followed it
      onTakeOver: (run) => void followRun(followerDeps, run.id),
      resumeQuota: () => resumeAfterReset(followerDeps),
      now: () => new Date(),
      startAgent,
      ensureWorkspace,
      ensureEpicBranch,
      gh: createGithubWriteClient(),
      usage: accountPeak(repos),
      log,
      ...o.dispatcher,
    },
    { schedule: o.schedule },
  );
  return {
    instance,
    dispatcher,
    followerDeps,
    async stop() {
      stopFollower();
      await dispatcher.stop();
    },
  };
}
