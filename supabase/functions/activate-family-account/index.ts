// Phase 4.17: the second Edge Function in this project to construct a
// service_role client (the first was admin-create-camp-admin, Phase 4.11).
// This one is different in one important way: it is PUBLIC (verify_jwt:
// false) — the head of family has no session at all when they open the
// activation link, so there is no JWT to check. Security rests entirely on
// the opaque activation token (validated in Postgres, see
// public.verify_family_activation) plus the identity fields checked
// alongside it — the same trust model as any password-reset-confirm link.
//
// Flow (design doc §6): verify token+identity (does NOT consume the token)
// -> create the Auth user -> atomically consume the token AND link the
// profile in one transaction (public.consume_family_activation, granted to
// service_role only). A failure after the Auth user is created rolls it
// back by deleting it, mirroring admin-create-camp-admin's own documented
// rollback shape.
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/http.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Keep in step with PASSWORD_MIN_LENGTH in assets/js/utils/validators.js.
const PASSWORD_MIN_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NATIONAL_ID_RE = /^[0-9]{9}$/;
const REFERENCE_CODE_RE = /^FAM-[0-9]{6,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_ACTIVATION_ERROR = 'بيانات التفعيل غير صحيحة';

function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, key, { auth: { persistSession: false } });
}

function isDuplicateEmailError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'email_exists') return true;
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('already registered') || message.includes('already been registered') || message.includes('already exists');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'validation', 'الطريقة غير مدعومة');

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse(400, 'validation', 'طلب غير صالح');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return errorResponse(400, 'validation', 'طلب غير صالح');
  }
  const body = parsed as Record<string, unknown>;

  const token = String(body.token ?? '').trim();
  const referenceCode = String(body.referenceCode ?? '').trim().toUpperCase();
  const nationalId = String(body.nationalId ?? '').trim();
  const birthDate = String(body.birthDate ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  // Never trust the frontend's own validation — every field is re-checked
  // here before anything touches the database.
  if (!token) return errorResponse(400, 'validation', 'رابط التفعيل غير صالح');
  if (!REFERENCE_CODE_RE.test(referenceCode)) return errorResponse(400, 'validation', GENERIC_ACTIVATION_ERROR);
  if (!NATIONAL_ID_RE.test(nationalId)) return errorResponse(400, 'validation', GENERIC_ACTIVATION_ERROR);
  if (!DATE_RE.test(birthDate)) return errorResponse(400, 'validation', GENERIC_ACTIVATION_ERROR);
  if (!EMAIL_RE.test(email)) return errorResponse(400, 'validation', 'البريد الإلكتروني غير صالح');
  if (password.length < PASSWORD_MIN_LENGTH) {
    return errorResponse(400, 'validation', `كلمة المرور يجب أن تكون ${PASSWORD_MIN_LENGTH} أحرف على الأقل`);
  }

  const service = serviceClient();

  const { data: verified, error: verifyError } = await service.rpc('verify_family_activation', {
    p_token: token,
    p_reference_code: referenceCode,
    p_national_id: nationalId,
    p_birth_date: birthDate,
  });

  if (verifyError || !verified || !verified[0]) {
    // Every rejection reason (not found / expired / revoked / used /
    // identity mismatch) is collapsed into the same generic message —
    // design doc §4 — so this response never tells the caller which check
    // failed.
    return errorResponse(400, 'validation', GENERIC_ACTIVATION_ERROR);
  }

  const record = verified[0] as { full_name: string; already_activated: boolean };

  if (record.already_activated) {
    return errorResponse(409, 'already_activated', 'هذا الحساب مفعل بالفعل، يمكنك تسجيل الدخول مباشرة');
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: record.full_name },
  });

  if (createError || !created?.user) {
    if (isDuplicateEmailError(createError)) {
      return errorResponse(409, 'email_taken', 'هذا البريد الإلكتروني مستخدم بالفعل، جرّب بريدًا آخر');
    }
    console.error('[activate-family-account] auth user create failed', createError);
    return errorResponse(500, 'database', 'تعذر إنشاء الحساب، حاول مرة أخرى');
  }

  const newUserId = created.user.id;

  const { error: consumeError } = await service.rpc('consume_family_activation', {
    p_token: token,
    p_new_user_id: newUserId,
  });

  if (consumeError) {
    // Lost the race (someone else consumed the token in the tiny window
    // between verify and here), or another genuinely unexpected failure.
    // Either way, do not leave a created-but-unlinked Auth account behind.
    console.error('[activate-family-account] consume failed, rolling back', newUserId, consumeError);
    const { error: cleanupError } = await service.auth.admin.deleteUser(newUserId);
    if (cleanupError) {
      console.error('[activate-family-account] rollback delete failed — orphaned auth user', newUserId, cleanupError);
    }
    return errorResponse(400, 'validation', GENERIC_ACTIVATION_ERROR);
  }

  return jsonResponse({ ok: true }, 201);
});
