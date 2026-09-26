import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diskStore, type AttachmentStore } from './store.js';

let dir: string;
let store: AttachmentStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'th-chat-files-'));
  store = diskStore(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('diskStore', () => {
  it('writes under <dir>/<user>/<id> with no temp file left, and reads it back', async () => {
    await store.write('u1abc', 'at1xyz', Buffer.from('hello'));
    expect((await store.read('u1abc', 'at1xyz')).toString()).toBe('hello');
    expect(await readdir(path.join(dir, 'u1abc'))).toEqual(['at1xyz']);
  });

  it('refuses an id or a user outside [a-z0-9]+ before touching the disk', async () => {
    for (const [u, id] of [['u1', '../etc'], ['u1', 'A1'], ['..', 'at1'], ['u1', 'at1.tmp'], ['', 'at1']]) {
      await expect(store.write(u, id, Buffer.from('x'))).rejects.toThrow(/invalid id/);
      await expect(store.read(u, id)).rejects.toThrow(/invalid id/);
      await expect(store.remove(u, id)).rejects.toThrow(/invalid id/);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('read of a missing file rejects with ENOENT; remove is idempotent', async () => {
    await expect(store.read('u1', 'nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await store.remove('u1', 'nope');
    await store.write('u1', 'at1', Buffer.from('x'));
    await store.remove('u1', 'at1');
    await store.remove('u1', 'at1');
    await expect(store.read('u1', 'at1')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('listAll walks every user directory, telling temp files apart and skipping foreign names', async () => {
    await store.write('u1', 'at1', Buffer.from('x'));
    await store.write('u2', 'at2', Buffer.from('y'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'u2', 'at3.tmp'), 'half');
    await writeFile(path.join(dir, 'u2', 'README.md'), 'ignored');
    const seen: { userId: string; id: string; temp: boolean }[] = [];
    for await (const f of store.listAll()) {
      expect(f.modifiedAt).toBeInstanceOf(Date);
      seen.push({ userId: f.userId, id: f.id, temp: f.temp });
    }
    expect(seen.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { userId: 'u1', id: 'at1', temp: false },
      { userId: 'u2', id: 'at2', temp: false },
      { userId: 'u2', id: 'at3', temp: true },
    ]);
  });

  it('listAll on a directory that does not exist yet yields nothing', async () => {
    const empty = diskStore(path.join(dir, 'nope'));
    const seen = [];
    for await (const f of empty.listAll()) seen.push(f);
    expect(seen).toEqual([]);
  });
});
