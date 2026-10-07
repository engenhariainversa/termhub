import type { RpcMethod, RpcParams, RpcResult } from '@termhub/agent-protocol';
import * as ai from './ai.js';
import * as claude from './claude.js';
import * as docs from './docs.js';
import * as fileList from './file-list.js';
import * as fileRead from './file-read.js';
import * as fs from './fs.js';
import * as hooks from './hooks.js';
import * as hw from './hw.js';
import * as paste from './paste.js';
import * as secret from './secret.js';
import * as sim from './sim.js';
import * as tabMcp from './tab-mcp.js';
import * as tmux from './tmux.js';
import * as tools from './tools.js';
import * as transcript from './transcript.js';
import * as update from './update.js';
import * as wda from './wda.js';
import * as worktree from './worktree.js';

// Re-exported so callers of this module (dispatch.ts) don't need to know RpcFailure actually
// lives in exec.ts — from the RPC layer's point of view it belongs here.
export { RpcFailure } from '../exec.js';

export type Handlers = { [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

export const handlers: Handlers = {
  'tmux.list': tmux.list,
  'tmux.kill': tmux.kill,
  'tmux.capture': tmux.capture,
  'tmux.ensure': tmux.ensure,
  'tmux.sendText': tmux.sendText,
  'tmux.sendKey': tmux.sendKey,
  'tmux.scroll': tmux.scroll,
  'tmux.foreground': tmux.foreground,
  'tools.detect': tools.detect,
  'hw.probe': hw.probe,
  'fs.list': fs.list,
  'fs.mkdir': fs.mkdir,
  'ai.usage': ai.usage,
  'secret.read': secret.read,
  'claude.linkSession': claude.linkSession,
  'docs.scan': docs.scan,
  'docs.read': docs.read,
  'file.paste': paste.pasteFile,
  'file.read': fileRead.read,
  'file.list': fileList.list,
  'hooks.install': hooks.install,
  'hooks.uninstall': hooks.uninstall,
  'agent.update': update.update,
  'sim.list': sim.list,
  'sim.boot': sim.boot,
  'wda.runner.start': wda.runnerStart,
  'wda.runner.alive': wda.runnerAlive,
  'wda.runner.tail': wda.runnerTail,
  'wda.setup.start': wda.setupStart,
  'wda.setup.state': wda.setupState,
  'tab.mcp.write': tabMcp.write,
  'tab.mcp.remove': tabMcp.remove,
  'transcript.read': transcript.read,
  'git.worktree.ensure': worktree.ensure,
  'git.worktree.remove': worktree.remove,
};
