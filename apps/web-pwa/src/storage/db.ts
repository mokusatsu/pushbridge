import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CachedFile, ChangeEvent, Device, OutboxJob, PushRecord } from '@/types';
import { notifyDataChanged } from './events';

interface MetaRecord {
  key: string;
  value: unknown;
}

export interface LocalAccountKey {
  id: 'account-key';
  key_version: number;
  key_bytes: Uint8Array;
  recovery_key_bytes?: Uint8Array;
  created_at: string;
}

interface PushbridgeDbSchema extends DBSchema {
  meta: {
    key: string;
    value: MetaRecord;
  };
  pushes: {
    key: string;
    value: PushRecord;
    indexes: {
      'by-created-at': string;
      'by-modified-at': string;
    };
  };
  devices: {
    key: string;
    value: Device;
    indexes: {
      'by-name': string;
    };
  };
  outbox: {
    key: string;
    value: OutboxJob;
    indexes: {
      'by-created-at': string;
      'by-next-attempt-at': string;
    };
  };
  cachedFiles: {
    key: string;
    value: CachedFile;
    indexes: {
      'by-last-accessed-at': string;
      'by-push-id': string;
    };
  };
  e2eeKeys: {
    key: string;
    value: LocalAccountKey;
  };
}

function databaseName(namespace: string): string {
  const safe = namespace.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `pushbridge-${safe || 'default'}-v2`;
}

export class AppDatabase {
  readonly name: string;
  private readonly dbPromise: Promise<IDBPDatabase<PushbridgeDbSchema>>;

  constructor(namespace: string) {
    this.name = databaseName(namespace);
    this.dbPromise = openDB<PushbridgeDbSchema>(this.name, 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const meta = db.createObjectStore('meta', { keyPath: 'key' });
          meta.put({ key: 'cursor', value: '' });

          const pushes = db.createObjectStore('pushes', { keyPath: 'id' });
          pushes.createIndex('by-created-at', 'created_at');
          pushes.createIndex('by-modified-at', 'modified_at');

          const devices = db.createObjectStore('devices', { keyPath: 'id' });
          devices.createIndex('by-name', 'name');

          const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
          outbox.createIndex('by-created-at', 'created_at');
          outbox.createIndex('by-next-attempt-at', 'next_attempt_at');
        }
        if (oldVersion < 2) {
          const cachedFiles = db.createObjectStore('cachedFiles', { keyPath: 'file_id' });
          cachedFiles.createIndex('by-last-accessed-at', 'last_accessed_at');
          cachedFiles.createIndex('by-push-id', 'push_id');
        }
        if (oldVersion < 3) db.createObjectStore('e2eeKeys', { keyPath: 'id' });
      },
    });
  }

  async getAccountKey(): Promise<LocalAccountKey | undefined> {
    const db = await this.dbPromise;
    return db.get('e2eeKeys', 'account-key');
  }

  async putAccountKey(key: Omit<LocalAccountKey, 'id'>): Promise<void> {
    const db = await this.dbPromise;
    await db.put('e2eeKeys', { id: 'account-key', ...key });
  }

  async getCursor(): Promise<string> {
    const db = await this.dbPromise;
    const record = await db.get('meta', 'cursor');
    return typeof record?.value === 'string' ? record.value : '';
  }

  async setCursor(cursor: string): Promise<void> {
    const db = await this.dbPromise;
    await db.put('meta', { key: 'cursor', value: cursor });
  }

  async listPushes(): Promise<PushRecord[]> {
    const db = await this.dbPromise;
    const values = await db.getAll('pushes');
    return values
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getPush(id: string): Promise<PushRecord | undefined> {
    const db = await this.dbPromise;
    return db.get('pushes', id);
  }

  async putPush(push: PushRecord, notify = true): Promise<void> {
    const db = await this.dbPromise;
    await db.put('pushes', push);
    if (notify) notifyDataChanged('push');
  }

  async deletePush(id: string, notify = true): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('pushes', id);
    if (notify) notifyDataChanged('push');
  }

  async listDevices(): Promise<Device[]> {
    const db = await this.dbPromise;
    const values = await db.getAll('devices');
    return values.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  async replaceDevices(devices: Device[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('devices', 'readwrite');
    await tx.store.clear();
    await Promise.all(devices.map((device) => tx.store.put(device)));
    await tx.done;
    notifyDataChanged('devices');
  }

  async putDevice(device: Device, notify = true): Promise<void> {
    const db = await this.dbPromise;
    await db.put('devices', device);
    if (notify) notifyDataChanged('devices');
  }

  async deleteDevice(id: string, notify = true): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('devices', id);
    if (notify) notifyDataChanged('devices');
  }

  async applyChanges(changes: ChangeEvent[], nextCursor: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['meta', 'pushes', 'devices', 'cachedFiles'], 'readwrite');

    for (const change of changes) {
      if (change.type === 'push.upsert' && change.push) {
        const store = tx.objectStore('pushes');
        const existing = await store.get(change.push.id);
        if (!existing || existing.modified_at <= change.push.modified_at) {
          const incoming = change.push;
          const cached = incoming.file_id
            ? await tx.objectStore('cachedFiles').get(incoming.file_id)
            : undefined;
          await store.put(existing ? {
            ...incoming,
            title: incoming.title ?? existing.title,
            body: incoming.body ?? existing.body,
            url: incoming.url ?? existing.url,
            file: cached && incoming.file && !incoming.file.e2ee ? {
              ...incoming.file,
              name: cached.name,
              mime_type: cached.mime_type,
              size: cached.size,
            } : incoming.file ?? existing.file,
            file_deliveries: incoming.file_deliveries ?? existing.file_deliveries,
            local_file_cached: Boolean(existing.local_file_cached || cached),
            local_file_delivery: existing.local_file_cached || cached
              ? 'cached'
              : incoming.file && (incoming.file.state === 'delete_pending' || incoming.file.state === 'deleted' || incoming.file.state === 'expired')
                ? 'missed'
                : existing.local_file_delivery ?? 'pending',
            local_archived_at: incoming.status === 'deleted' || incoming.status === 'expired'
              ? existing.local_archived_at ?? new Date().toISOString()
              : existing.local_archived_at,
          } : {
            ...incoming,
            file: cached && incoming.file && !incoming.file.e2ee ? {
              ...incoming.file,
              name: cached.name,
              mime_type: cached.mime_type,
              size: cached.size,
            } : incoming.file,
            local_file_cached: Boolean(cached),
            local_file_delivery: cached
              ? 'cached'
              : incoming.file && (incoming.file.state === 'delete_pending' || incoming.file.state === 'deleted' || incoming.file.state === 'expired')
                ? 'missed'
                : incoming.file_id ? 'pending' : undefined,
          });
        }
      } else if (change.type === 'push.delete') {
        const store = tx.objectStore('pushes');
        const existing = await store.get(change.entity_id);
        if (existing) {
          await store.put({
            ...existing,
            status: 'deleted',
            deleted_at: existing.deleted_at ?? new Date().toISOString(),
            local_archived_at: existing.local_archived_at ?? new Date().toISOString(),
          });
        }
      } else if (change.type === 'device.upsert' && change.device) {
        await tx.objectStore('devices').put(change.device);
      } else if (change.type === 'device.delete') {
        await tx.objectStore('devices').delete(change.entity_id);
      }
    }

    await tx.objectStore('meta').put({ key: 'cursor', value: nextCursor });
    await tx.done;
    notifyDataChanged('sync');
  }

  async getCachedFile(fileId: string, touch = true): Promise<CachedFile | undefined> {
    const db = await this.dbPromise;
    const cached = await db.get('cachedFiles', fileId);
    if (cached && touch) {
      cached.last_accessed_at = new Date().toISOString();
      await db.put('cachedFiles', cached);
    }
    return cached;
  }

  async putCachedFile(file: CachedFile): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['cachedFiles', 'pushes'], 'readwrite');
    await tx.objectStore('cachedFiles').put(file);
    const push = await tx.objectStore('pushes').get(file.push_id);
    if (push) await tx.objectStore('pushes').put({ ...push, local_file_cached: true, local_file_delivery: 'cached' });
    await tx.done;
    notifyDataChanged('file-cache');
  }

  async deleteCachedFile(fileId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['cachedFiles', 'pushes'], 'readwrite');
    const cached = await tx.objectStore('cachedFiles').get(fileId);
    if (cached) {
      await tx.objectStore('cachedFiles').delete(fileId);
      const push = await tx.objectStore('pushes').get(cached.push_id);
      if (push) await tx.objectStore('pushes').put({ ...push, local_file_cached: false });
    }
    await tx.done;
    notifyDataChanged('file-cache');
  }

  async setCachedFilePinned(fileId: string, pinned: boolean): Promise<void> {
    const db = await this.dbPromise;
    const cached = await db.get('cachedFiles', fileId);
    if (cached) await db.put('cachedFiles', { ...cached, pinned });
  }

  async cachedFileUsage(): Promise<{ count: number; bytes: number }> {
    const db = await this.dbPromise;
    const files = await db.getAll('cachedFiles');
    return { count: files.length, bytes: files.reduce((total, file) => total + file.size, 0) };
  }

  async enforceCachedFileLimit(maxBytes: number): Promise<{ deleted: number; bytes: number }> {
    const db = await this.dbPromise;
    const files = await db.getAll('cachedFiles');
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let deleted = 0;
    const candidates = files.sort((a, b) => Number(a.pinned) - Number(b.pinned)
      || a.last_accessed_at.localeCompare(b.last_accessed_at)
      || b.size - a.size
      || a.file_id.localeCompare(b.file_id));
    for (const file of candidates) {
      if (total <= maxBytes) break;
      await this.deleteCachedFile(file.file_id);
      total -= file.size;
      deleted += 1;
    }
    return { deleted, bytes: Math.max(0, total) };
  }

  async listOutbox(): Promise<OutboxJob[]> {
    const db = await this.dbPromise;
    const values = await db.getAll('outbox');
    return values.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async putOutbox(job: OutboxJob, notify = true): Promise<void> {
    const db = await this.dbPromise;
    await db.put('outbox', job);
    if (notify) notifyDataChanged('outbox');
  }

  async deleteOutbox(id: string, notify = true): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('outbox', id);
    if (notify) notifyDataChanged('outbox');
  }

  async clearAll(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['meta', 'pushes', 'devices', 'outbox', 'cachedFiles', 'e2eeKeys'], 'readwrite');
    await Promise.all([
      tx.objectStore('pushes').clear(),
      tx.objectStore('devices').clear(),
      tx.objectStore('outbox').clear(),
      tx.objectStore('cachedFiles').clear(),
      tx.objectStore('e2eeKeys').clear(),
      tx.objectStore('meta').put({ key: 'cursor', value: '' }),
    ]);
    await tx.done;
    notifyDataChanged('clear');
  }

  async destroy(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
    await deleteDB(this.name);
    notifyDataChanged('destroy');
  }
}
