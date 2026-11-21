// A tiny in-memory cache. Concurrent callers share one in-flight promise; failures are not cached.

type Entry = { value: Promise<unknown>; expires: number };
const store = new Map<string, Entry>();
const MAX_ENTRIES = 5_000;

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

  const value = load();
  store.set(key, { value, expires: Date.now() + ttlMs });
  value.catch(() => store.get(key)?.value === value && store.delete(key));

  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
  return value;
}

/** Store a value someone already has in hand, unless a fresh one is cached. */
export function remember<T>(key: string, ttlMs: number, value: T): void {
  const hit = store.get(key);
  if (!hit || hit.expires <= Date.now()) store.set(key, { value: Promise.resolve(value), expires: Date.now() + ttlMs });
}

export function forget(key: string): void {
  store.delete(key);
}
