/**
 * Async helper.
 *
 * Originally a mock localStorage data layer; every page now reads/writes the
 * real backend directly through `supabase/*.js`, so only `load()` is left.
 * It wraps a real fetch (sync or async producer) in a promise, so every page
 * keeps one call shape: `store.load(() => getCampFamilies(session.campId))`.
 * Skeletons show for as long as the real request takes — no artificial delay.
 */

export function load(producer) {
  return new Promise((resolve, reject) => {
    try {
      // resolve() with a thenable (every real caller's async producer)
      // follows it, so this handles a sync or async producer identically.
      resolve(producer());
    } catch (error) {
      reject(error);
    }
  });
}

export default { load };
