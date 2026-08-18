/**
 * Root entry: send the visitor to the right place.
 * Signed out -> login. Pending / rejected -> its status screen. Otherwise the
 * dashboard, which renders per role. A broken/missing profile fails closed
 * to auth-error.html rather than guessing a role.
 */

import { getSession, ProfileError } from '../core/auth.js';
import { homeFor } from '../core/router.js';
import { validateData } from '../core/store.js';

validateData();

try {
  const session = await getSession();
  window.location.replace(`pages/${homeFor(session)}`);
} catch (error) {
  if (error instanceof ProfileError) {
    console.error('[auth] profile error:', error.reason);
    window.location.replace('pages/auth-error.html');
  } else {
    throw error;
  }
}
