/**
 * Root entry: send the visitor to the right place.
 * Signed out -> login. Pending / rejected -> its status screen. Otherwise the
 * dashboard, which renders per role.
 */

import { getSession } from '../core/auth.js';
import { homeFor } from '../core/router.js';
import { validateData } from '../core/store.js';

validateData();

const session = getSession();
window.location.replace(`pages/${homeFor(session)}`);
