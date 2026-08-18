// supabase/tests/unit-errors.test.mjs
// Pure-logic unit test — no network, no browser. errors.js has zero imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAuthError, DataAccessError } from '../../assets/js/supabase/errors.js';

test('mapAuthError: invalid credentials -> Arabic "wrong email or password"', () => {
  const err = mapAuthError({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' });
  assert.ok(err instanceof DataAccessError);
  assert.equal(err.message, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
});

test('mapAuthError: email not confirmed -> Arabic confirm-email message', () => {
  const err = mapAuthError({ status: 400, code: 'email_not_confirmed', message: 'Email not confirmed' });
  assert.equal(err.message, 'يرجى تأكيد بريدك الإلكتروني أولاً.');
});

test('mapAuthError: network failure (no status, no code) -> Arabic connectivity message', () => {
  const err = mapAuthError({ message: 'Failed to fetch' });
  assert.equal(err.message, 'تعذر الاتصال بالخادم. تحقق من اتصالك بالإنترنت.');
});

test('mapAuthError: unrecognized error -> generic fallback, never raw text', () => {
  const err = mapAuthError({ status: 500, code: 'unexpected_failure', message: 'panic: nil pointer' });
  assert.equal(err.message, 'حدث خطأ غير متوقع، حاول مرة أخرى');
  assert.notEqual(err.message, 'panic: nil pointer');
});

test('mapAuthError: null error -> null', () => {
  assert.equal(mapAuthError(null), null);
});
