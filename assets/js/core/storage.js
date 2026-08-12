/**
 * localStorage wrapper.
 *
 * The ONLY module in the app that touches browser storage directly.
 * Everything else goes through core/store.js. When Supabase replaces the
 * prototype persistence, this file is deleted outright.
 */

const NAMESPACE = 'dcmp';

function key(name) {
  return `${NAMESPACE}:${name}`;
}

/** Detect private-mode / disabled storage once, then degrade to memory. */
const memory = new Map();
let available = true;

try {
  const probe = key('__probe__');
  window.localStorage.setItem(probe, '1');
  window.localStorage.removeItem(probe);
} catch {
  available = false;
}

export function read(name, fallback = null) {
  try {
    const value = available ? window.localStorage.getItem(key(name)) : memory.get(key(name));
    if (value === null || value === undefined) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function write(name, value) {
  const payload = JSON.stringify(value);
  try {
    if (available) window.localStorage.setItem(key(name), payload);
    else memory.set(key(name), payload);
    return true;
  } catch (error) {
    // Quota exceeded — most likely a large base64 upload preview.
    console.warn('[storage] تعذر الحفظ محلياً:', error);
    return false;
  }
}

export function remove(name) {
  if (available) window.localStorage.removeItem(key(name));
  else memory.delete(key(name));
}

/** Wipe every key owned by this app; leaves other sites' data alone. */
export function clearAll() {
  if (!available) {
    memory.clear();
    return;
  }
  Object.keys(window.localStorage)
    .filter((entry) => entry.startsWith(`${NAMESPACE}:`))
    .forEach((entry) => window.localStorage.removeItem(entry));
}

export const isPersistent = () => available;
