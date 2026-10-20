import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_SHARE_CHUNK_BYTES, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { HttpError } from '../../lib/errors.js';
import type { ControlContext } from '../../control/context.js';
import { chatBus } from '../bus.js';
import { fetchFile, pathRefusal, SHARE_DAILY_LIMIT, shareFile, type ShareRpc } from './share.js';

const capable = vi.hoisted(() => ({ check: vi.fn((_m: unknown) => undefined) }));
vi.mock('../../agent/errors.js', () => ({ agentRpc: vi.fn(), requireFileShareCapable: (m: unknown) => capable.check(m) }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
const machine = { id: 'm1', name: 'hulk', type: 'agent', owner_id: 'u1' };

/** An agent that serves `files` (path → bytes) in the chunks it is asked for. */
function agentServing(files: Record<string, Buffer>, opts: { mtime?: (call: number) => number } = {}): ShareRpc & { calls: RpcParams<'file.share'>[] } {
  const calls: RpcParams<'file.share'>[] = [];
  const rpc = (async (_m, params) => {
    calls.push(params);
    const body = files[params.path];
    if (!body) return { status: 'missing' } as RpcResult<'file.share'>;
    const chunk = body.subarray(params.offset, params.offset + params.length);
    return { status: 'ok', path: params.path.replace('~', '/home/u'), size: body.length, mtime_ms: opts.mtime?.(calls.length) ?? 1, offset: params.offset, content_b64: chunk.toString('base64') };
  }) as ShareRpc & { calls: RpcParams<'file.share'>[] };
  rpc.calls = calls;
  return rpc;
}

let ctx: ControlContext;
let repos: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
let store: { write: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
const queue = { enqueue: vi.fn() };
const deps = { queue, quotaBytes: 100 * 1024 * 1024 };

beforeEach(() => {
  capable.check.mockReset();
  queue.enqueue.mockReset();
  vi.spyOn(chatBus, 'publish').mockImplementation(() => {});
  store = { write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  const rows = new Map<string, Record<string, unknown>>();
  repos = {
    chat: {
      findByIdForUser: vi.fn(async (id: string) => (id === 'c1' ? { id: 'c1', project_id: null, archived_at: null } : undefined)),
      findLatestActiveForProject: vi.fn(async () => ({ id: 'cp1', project_id: 'p1', archived_at: null })),
      getOrCreateForProject: vi.fn(),
      getOrCreateForUser: vi.fn(async () => ({ id: 'cg', project_id: null, archived_at: null })),
      addMessage: vi.fn(async (i: { conversation_id: string; text: string }) => ({ id: 'msg1', conversation_id: i.conversation_id, role: 'assistant', text: i.text, usage: null, error_code: null, created_at: 'now' })),
      deleteMessage: vi.fn(async () => undefined),
    },
    chatAttachments: {
      sharedSince: vi.fn(async () => ({ files: 0, bytes: 0 })),
      usageBytes: vi.fn(async () => 0),
      create: vi.fn(async (r: Record<string, unknown>) => {
        const row = { ...r, status: 'pending', error_code: null, extracted_text: null, message_id: null, created_at: 'now' };
        rows.set(r.id as string, row);
        return row;
      }),
      attach: vi.fn(async () => 1),
      deleteUnsent: vi.fn(async () => true),
      findForUser: vi.fn(async (id: string) => rows.get(id)),
    },
    securityEvents: { record: vi.fn(async () => undefined) },
  };
  ctx = {
    repos,
    scope: { user: { id: 'u1', email: 'u@x', locale: 'pt-BR' }, ownerId: 'u1' },
    scoped: {
      machine: vi.fn(async (id: string) => {
        if (id !== 'm1') throw new HttpError(404, 'Máquina não encontrada');
        return machine;
      }),
      tab: vi.fn(async () => ({ machine, cwd: '/home/u/proj' })),
    },
    token: { id: 't', scopes: ['read'], gated: true, chat_conversation_id: 'c1' },
    attachments: store,
  } as unknown as ControlContext;
});

describe('pathRefusal', () => {
  it('refuses a relative path, a secret and a kind the chat does not show', () => {
    expect(pathRefusal('out/a.png')).toMatch(/absoluto/);
    expect(pathRefusal('~/.ssh/id.png')).toMatch(/não pode ser compartilhado/);
    expect(pathRefusal('/home/u/app/.env')).toMatch(/não pode ser compartilhado/);
    expect(pathRefusal('~/bin/run.sh')).toMatch(/Tipo de arquivo/);
    expect(pathRefusal('~/app.exe')).toMatch(/Tipo de arquivo/);
    expect(pathRefusal('~/termhub-linkedin/post.png')).toBeNull();
  });
});

describe('fetchFile', () => {
  it('asks chunk after chunk until it has the whole file', async () => {
    const big = Buffer.alloc(FILE_SHARE_CHUNK_BYTES * 2 + 10, 1);
    const rpc = agentServing({ '~/a.mp4': big });
    const r = await fetchFile(rpc, machine as never, { path: '~/a.mp4', roots: [], only_roots: false });
    expect(r.body.equals(big)).toBe(true);
    expect(rpc.calls.map((c) => c.offset)).toEqual([0, FILE_SHARE_CHUNK_BYTES, FILE_SHARE_CHUNK_BYTES * 2]);
  });

  it('refuses a file whose date moved between two chunks', async () => {
    const rpc = agentServing({ '~/a.mp4': Buffer.alloc(FILE_SHARE_CHUNK_BYTES + 1, 1) }, { mtime: (n) => n });
    await expect(fetchFile(rpc, machine as never, { path: '~/a.mp4', roots: [], only_roots: false })).rejects.toMatchObject({ code: 'FILE_CHANGED' });
  });
});

describe('shareFile', () => {
  const share = (path: string, rpc: ShareRpc, extra: { caption?: string; machine_id?: string } = {}) => shareFile(ctx, deps, { machine_id: 'm1', path, ...extra }, rpc);

  it('publishes the image in the concierge conversation, with a message, the attachment, the queue and the trail', async () => {
    const rpc = agentServing({ '~/termhub-linkedin/post-1.png': PNG });
    const r = await share('~/termhub-linkedin/post-1.png', rpc, { caption: 'Aqui está a imagem' });
    expect(r.attachment).toMatchObject({ name: 'post-1.png', kind: 'image', mime: 'image/png', bytes: PNG.length, meta: { source: 'machine', machine_id: 'm1' } });
    expect(r.conversation_id).toBe('c1');
    expect(store.write).toHaveBeenCalledWith('u1', r.attachment.id, PNG);
    expect(repos.chat.addMessage).toHaveBeenCalledWith({ conversation_id: 'c1', role: 'assistant', text: 'Aqui está a imagem' });
    expect(repos.chatAttachments.attach).toHaveBeenCalledWith([r.attachment.id], 'msg1', 'u1', 'c1');
    expect(queue.enqueue).toHaveBeenCalledWith(r.attachment.id);
    expect(chatBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', conversation_id: 'c1', message: expect.objectContaining({ id: 'msg1', attachments: [r.attachment] }) }));
    expect(repos.securityEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor_id: 'u1', action: 'machine.file_share', target_id: 'm1', meta: expect.objectContaining({ path: '/home/u/termhub-linkedin/post-1.png', bytes: PNG.length, via: 'concierge' }) }),
    );
    expect(rpc.calls[0]).toMatchObject({ roots: [], only_roots: false });
  });

  it('without a caption, the message names the machine and the file (never an empty answer)', async () => {
    await share('~/a.png', agentServing({ '~/a.png': PNG }));
    expect(repos.chat.addMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Arquivo de hulk: a.png' }));
  });

  it('an offline or outdated machine is refused before anything is read', async () => {
    capable.check.mockImplementation(() => {
      throw new HttpError(503, 'Agente desconectado', 'AGENT_OFFLINE');
    });
    const rpc = agentServing({ '~/a.png': PNG });
    await expect(share('~/a.png', rpc)).rejects.toMatchObject({ code: 'AGENT_OFFLINE' });
    expect(rpc.calls).toHaveLength(0);
  });

  it('a machine of somebody else is not found', async () => {
    await expect(share('~/a.png', agentServing({}), { machine_id: 'm9' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a file that does not exist says so', async () => {
    await expect(share('~/nope.png', agentServing({}))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('a blocked path never reaches the machine', async () => {
    const rpc = agentServing({ '~/.ssh/id.png': PNG });
    await expect(share('~/.ssh/id.png', rpc)).rejects.toMatchObject({ code: 'FILE_BLOCKED' });
    await expect(share('~/bin/tool', rpc)).rejects.toMatchObject({ code: 'FILE_TYPE' });
    expect(rpc.calls).toHaveLength(0);
  });

  it('a refusal from the agent (a secret behind a link, too large) comes back with its code', async () => {
    const secret: ShareRpc = async () => ({ status: 'secret' });
    const tooLarge: ShareRpc = async () => ({ status: 'too_large', size: 99_000_000 });
    await expect(share('~/out/a.png', secret)).rejects.toMatchObject({ code: 'FILE_BLOCKED' });
    await expect(share('~/out/a.mp4', tooLarge)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('a file whose bytes are not what its name says (an executable named .png) is refused', async () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    await expect(share('~/a.png', agentServing({ '~/a.png': elf }))).rejects.toMatchObject({ code: 'FILE_TYPE' });
    expect(store.write).not.toHaveBeenCalled();
  });

  it('an image over the chat limit for its kind is refused', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(share('~/big.png', agentServing({ '~/big.png': big }))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('stops at the daily limit and at the quota', async () => {
    repos.chatAttachments.sharedSince.mockResolvedValueOnce({ files: SHARE_DAILY_LIMIT.files, bytes: 0 });
    await expect(share('~/a.png', agentServing({ '~/a.png': PNG }))).rejects.toMatchObject({ code: 'FILE_SHARE_LIMIT' });
    repos.chatAttachments.usageBytes.mockResolvedValueOnce(deps.quotaBytes);
    await expect(share('~/a.png', agentServing({ '~/a.png': PNG }))).rejects.toMatchObject({ code: 'ATTACHMENT_QUOTA' });
  });

  it('a message that cannot be written takes the row and the file with it', async () => {
    repos.chat.addMessage.mockRejectedValueOnce(new Error('db'));
    await expect(share('~/a.png', agentServing({ '~/a.png': PNG }))).rejects.toThrow('db');
    expect(repos.chatAttachments.deleteUnsent).toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalled();
    expect(chatBus.publish).not.toHaveBeenCalled();
  });

  it('from an agent tab: only its own folder on its own machine, into the project chat', async () => {
    ctx = { ...ctx, token: { id: 't', scopes: ['read'], tab: { id: 'tab1', project_id: 'p1' } } };
    const rpc = agentServing({ '/home/u/proj/shot.png': PNG });
    const r = await shareFile(ctx, deps, { path: '/home/u/proj/shot.png' }, rpc);
    expect(rpc.calls[0]).toMatchObject({ roots: ['/home/u/proj'], only_roots: true });
    expect(r.conversation_id).toBe('cp1');
    await expect(shareFile(ctx, deps, { machine_id: 'm2', path: '/home/u/proj/shot.png' }, rpc)).rejects.toMatchObject({ code: 'FILE_BLOCKED' });
  });
});
