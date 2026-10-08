import type { RpcParams, RpcResult } from '@termhub/agent-protocol';
import { deleteConfig } from '../config.js';
import { deleteDeviceKey } from '../device-key.js';
import { RpcFailure } from '../exec.js';
import * as service from '../service/index.js';

/**
 * "Uninstall from the machine", called by the server right before it deletes the machine (spec
 * 2026-10-07 agent release trust and uninstall, section 3). Hooks and tmux sessions were already
 * removed by the server through `hooks.uninstall` / `tmux.kill`.
 *
 * Order matters, because stopping the service kills this very process:
 *   1. remove the service definition (plist / systemd unit) WITHOUT stopping it;
 *   2. delete the config (`config.json`, with the old token if any) and the device key (TER-1017);
 *   3. reply;
 *   4. a moment later — so the rpc_result frame leaves the socket — stop the service, then
 *      `exit(0)` in any case. 0 on purpose: launchd's `KeepAlive.SuccessfulExit=false` and
 *      systemd's `Restart=on-failure` both leave a clean exit alone. In the foreground (no
 *      service) it just exits.
 * A failure in step 1 fails the RPC before the config is touched, so the machine keeps working
 * and the person can retry.
 */
const EXIT_DELAY_MS = 750;

export interface UninstallDeps {
  removeServiceDefinition: () => Promise<boolean>;
  deleteConfig: () => void;
  stopService: () => Promise<void>;
  exit: (code: number) => void;
  log: (msg: string, meta?: object) => void;
}

const defaultDeps: UninstallDeps = {
  removeServiceDefinition: () => service.removeDefinition(),
  deleteConfig: () => {
    deleteConfig();
    deleteDeviceKey();
  },
  stopService: () => service.stop(),
  exit: (code) => process.exit(code),
  log: (msg, meta) => console.error(meta ? `[termhub-agent] ${msg} ${JSON.stringify(meta)}` : `[termhub-agent] ${msg}`),
};

/** Builds the handler; each one refuses a second call while the first runs and, once it succeeded, for good (the process is exiting). */
export function makeUninstall(deps: UninstallDeps = defaultDeps): (params: RpcParams<'agent.uninstall'>) => Promise<RpcResult<'agent.uninstall'>> {
  let busy = false;
  return async () => {
    if (busy) throw new RpcFailure('failed', 'uninstall already running');
    busy = true;
    try {
      return await doUninstall(deps);
    } catch (err) {
      busy = false;
      throw err;
    }
  };
}

async function doUninstall(deps: UninstallDeps): Promise<RpcResult<'agent.uninstall'>> {
  let removed: boolean;
  try {
    removed = await deps.removeServiceDefinition();
  } catch (err) {
    deps.log('uninstall failed', { step: 'service' });
    throw new RpcFailure('failed', `could not remove the service: ${(err as Error).message}`);
  }
  try {
    deps.deleteConfig();
  } catch (err) {
    deps.log('uninstall failed', { step: 'config' });
    throw new RpcFailure('failed', `could not delete the config: ${(err as Error).message}`);
  }
  const svc = removed ? 'removed' : 'none';
  deps.log('uninstalled, stopping', { service: svc });
  setTimeout(() => {
    const stopped = removed ? deps.stopService().catch(() => {}) : Promise.resolve();
    void stopped.finally(() => deps.exit(0));
  }, EXIT_DELAY_MS);
  return { service: svc };
}

export const uninstall = makeUninstall();
