// File System Access API + IndexedDB handle persistence. Chromium-only;
// callers must feature-detect with diskSupported().

const DB_NAME = 'or-fusion-disk';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key: string): Promise<any> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbSet(key: string, value: any): Promise<void> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function diskSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickFolder(): Promise<void> {
  const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  await idbSet('dir', handle);
}

export type DiskState = 'ok' | 'prompt' | 'none';

export async function diskState(): Promise<DiskState> {
  if (!diskSupported()) return 'none';
  const handle = await idbGet('dir').catch(() => null);
  if (!handle) return 'none';
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  return perm === 'granted' ? 'ok' : 'prompt';
}

// Must be called from a user gesture (click handler).
export async function reenableDisk(): Promise<boolean> {
  const handle = await idbGet('dir').catch(() => null);
  if (!handle) return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function writeRunFile(filename: string, content: string): Promise<void> {
  const handle = await idbGet('dir');
  if (!handle) throw new Error('no folder selected');
  const file = await handle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}
