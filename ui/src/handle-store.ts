// Remembers the picked folder handle in IndexedDB so the next visit needs one click, not a picker.
// Browser-only glue; every failure degrades to "not remembered".
const DB = { name: "specs-ui", store: "handles", key: "root" };

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB.name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB.store);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveHandle(h: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(DB.store, "readwrite");
      tx.objectStore(DB.store).put(h, DB.key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* not remembered */
  }
}

export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const r = db
        .transaction(DB.store, "readonly")
        .objectStore(DB.store)
        .get(DB.key);
      r.onsuccess = () => res((r.result as FileSystemDirectoryHandle) ?? null);
      r.onerror = () => rej(r.error);
    });
  } catch {
    return null;
  }
}
