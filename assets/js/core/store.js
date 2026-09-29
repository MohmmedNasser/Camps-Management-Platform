/**
 * Async helper.
 *
 * Originally a mock localStorage data layer (a repository per collection,
 * shaped like a Supabase client call so the port would be a drop-in body
 * swap). Every page now reads/writes the real backend directly through
 * `supabase/*.js`, so only the one piece every real page still uses —
 * `load()` — is left: it adds a short artificial delay around a real fetch
 * so skeleton loading states are genuinely exercised, exactly like it used
 * to around a synchronous mock read.
 */

import { FAKE_LATENCY } from './config.js';

/**
 * Wrap a producer (sync or async) in a short delay so loading skeletons are
 * real. Pages await this around the Supabase call that replaced the mock
 * read it used to wrap.
 */
export function load(producer, delay = FAKE_LATENCY) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        // resolve() with a thenable (every real caller's async producer)
        // follows it, so this handles a sync or async producer identically.
        resolve(producer());
      } catch (error) {
        reject(error);
      }
    }, delay);
  });
}

export default { load };
