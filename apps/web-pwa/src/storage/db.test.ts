import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeEvent, OutboxJob, PushRecord } from '@/types';
import { AppDatabase } from './db';

const databases: AppDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function createDb() {
  const db = new AppDatabase(`test-${crypto.randomUUID()}`);
  databases.push(db);
  return db;
}

const push: PushRecord = {
  id: 'push_1',
  client_guid: 'job_1',
  type: 'note',
  source_device_id: 'device_web',
  target: { kind: 'all_other_devices' },
  pinned: false,
  status: 'active',
  title: 'Hello',
  body: 'World',
  created_at: '2026-01-01T00:00:00Z',
  modified_at: '2026-01-01T00:00:00Z',
};

describe('AppDatabase', () => {
  it('applies change events atomically and advances the cursor', async () => {
    const db = createDb();
    const changes: ChangeEvent[] = [{
      cursor: '1',
      type: 'push.upsert',
      entity_id: push.id,
      push,
    }];
    await db.applyChanges(changes, '1');
    expect(await db.getCursor()).toBe('1');
    expect(await db.listPushes()).toEqual([{
      ...push,
      local_file_cached: false,
      local_file_delivery: undefined,
    }]);

    await db.applyChanges([{ cursor: '2', type: 'push.delete', entity_id: push.id }], '2');
    expect(await db.listPushes()).toMatchObject([{
      id: push.id,
      title: 'Hello',
      body: 'World',
      status: 'deleted',
    }]);
    expect(await db.getCursor()).toBe('2');
  });

  it('persists received file bytes and evicts unpinned least-recently-used files first', async () => {
    const db = createDb();
    await db.putPush({ ...push, id: 'push_a', file_id: 'file_a', type: 'file', pinned: true });
    await db.putPush({ ...push, id: 'push_b', file_id: 'file_b', type: 'file' });
    await db.putCachedFile({
      file_id: 'file_a', push_id: 'push_a', name: 'a.bin', mime_type: 'application/octet-stream',
      size: 4, blob: new Blob(['aaaa']), cached_at: '2026-01-01T00:00:00Z',
      last_accessed_at: '2026-01-01T00:00:00Z', pinned: true,
    });
    await db.putCachedFile({
      file_id: 'file_b', push_id: 'push_b', name: 'b.bin', mime_type: 'application/octet-stream',
      size: 4, blob: new Blob(['bbbb']), cached_at: '2026-01-02T00:00:00Z',
      last_accessed_at: '2026-01-02T00:00:00Z', pinned: false,
    });

    const result = await db.enforceCachedFileLimit(4);
    expect(result).toEqual({ deleted: 1, bytes: 4 });
    expect(await db.getCachedFile('file_a', false)).toBeDefined();
    expect(await db.getCachedFile('file_b', false)).toBeUndefined();
    expect((await db.getPush('push_b'))?.local_file_cached).toBe(false);
  });

  it('stores Blob-backed outbox jobs for offline file delivery', async () => {
    const db = createDb();
    const job: OutboxJob = {
      id: 'job_file',
      kind: 'send_push',
      status: 'queued',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      next_attempt_at: '2026-01-01T00:00:00Z',
      attempts: 0,
      draft: { type: 'file', target: { kind: 'all_other_devices' } },
      file: {
        blob: new Blob(['hello'], { type: 'text/plain' }),
        name: 'hello.txt',
        mime_type: 'text/plain',
        size: 5,
      },
    };
    await db.putOutbox(job);
    const stored = (await db.listOutbox())[0];
    expect(stored?.file?.name).toBe('hello.txt');
    expect(stored?.file?.size).toBe(5);
    expect(stored?.file?.blob).toBeDefined();
  });

  it('marks a deleted server alias as missed when no local Blob exists', async () => {
    const db = createDb();
    const deletedFilePush: PushRecord = {
      ...push,
      id: 'push_missed',
      type: 'file',
      file_id: 'file_missed',
      file: {
        id: 'file_missed',
        name: 'ファイル file_missed',
        mime_type: 'application/octet-stream',
        size: 10,
        state: 'deleted',
        delete_reason: 'storage_pressure',
      },
      is_for_current_device: true,
      modified_at: '2026-01-02T00:00:00Z',
    };
    await db.applyChanges([{
      cursor: 'missed-1',
      type: 'push.upsert',
      entity_id: deletedFilePush.id,
      push: deletedFilePush,
    }], 'missed-1');

    expect(await db.getPush(deletedFilePush.id)).toMatchObject({
      local_file_cached: false,
      local_file_delivery: 'missed',
    });
  });
});
