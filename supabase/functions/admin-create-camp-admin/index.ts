// Phase 4.11: the one privileged operation this project has — creating a
// real Supabase Auth user and promoting it to Camp Admin. Every other Edge
// Function in this project (documents-upload/access/delete) does all of its
// DB work through a caller-scoped client, relying on RLS. This one is
// different: `auth.admin.createUser()` has no RLS-equivalent, so this
// function is the only place in the project that constructs a service-role
// client — and it does so only AFTER independently re-deriving the caller's
// own role from the database (never from the request body, never from
// PAGE_ACCESS/can(), which are UX-only per core/auth.js's own header).
//
// Rollback: auth.admin.createUser() runs only after every other input is
// validated, so the sole failure window needing cleanup is the profiles
// UPDATE that follows it — if that fails, the just-created auth user is
// deleted (profiles_id_fkey is ON DELETE CASCADE, so its trigger-created
// profile row goes with it). See design doc §5.
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/http.ts';
import { callerClient, callerUser } from '../_shared/supabase-client.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Keep in step with PASSWORD_MIN_LENGTH in assets/js/utils/validators.js.
const PASSWORD_MIN_LENGTH = 8;

const GENERIC_FORBIDDEN = 'لا تملك صلاحية إنشاء حساب مسؤول مخيم';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-\s]{6,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = ['active', 'disabled'];

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

  const authHeader = req.headers.get('Authorization');
  const caller = callerClient(authHeader ?? '');
  const user = await callerUser(caller, authHeader);
  if (!user) return errorResponse(401, 'unauthorized', 'يجب تسجيل الدخول لإتمام هذا الإجراء');

  // Authorization: re-derive the caller's role from the database on every
  // call. RLS's profiles_select_own_or_admin already lets any authenticated
  // user read their OWN row, so this needs no privileged client — only the
  // two writes below do.
  const { data: callerProfile, error: callerProfileError } = await caller
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle();
  if (callerProfileError || !callerProfile || callerProfile.role !== 'super_admin' || callerProfile.status !== 'active') {
    return errorResponse(403, 'forbidden', GENERIC_FORBIDDEN);
  }

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

  const fullName = String(body.fullName ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const phone = String(body.phone ?? '').trim();
  const password = String(body.password ?? '');
  const campId = String(body.campId ?? '').trim();
  const status = String(body.status ?? '').trim();

  if (fullName.length < 5) return errorResponse(400, 'validation', 'الاسم الكامل مطلوب (5 أحرف على الأقل)');
  if (!EMAIL_RE.test(email)) return errorResponse(400, 'validation', 'البريد الإلكتروني غير صالح');
  if (!PHONE_RE.test(phone)) return errorResponse(400, 'validation', 'رقم الجوال غير صالح');
  if (password.length < PASSWORD_MIN_LENGTH) {
    return errorResponse(400, 'validation', `كلمة المرور يجب أن تكون ${PASSWORD_MIN_LENGTH} أحرف على الأقل`);
  }
  if (!UUID_RE.test(campId)) return errorResponse(400, 'validation', 'المخيم المحدد غير صالح');
  if (!VALID_STATUSES.includes(status)) return errorResponse(400, 'validation', 'حالة الحساب غير صالحة');

  const service = serviceClient();

  // Camp existence is checked BEFORE creating the Auth user, so the only
  // remaining failure window after createUser() succeeds is a genuinely
  // unexpected error on the profiles UPDATE (design §5).
  const { data: camp, error: campError } = await service.from('camps').select('id').eq('id', campId).maybeSingle();
  if (campError || !camp) return errorResponse(400, 'validation', 'المخيم المحدد غير موجود');

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone },
  });

  if (createError || !created?.user) {
    if (isDuplicateEmailError(createError)) {
      return errorResponse(409, 'duplicate', 'هذا البريد الإلكتروني مستخدم بالفعل.');
    }
    console.error('[admin-create-camp-admin] auth user create failed', createError);
    return errorResponse(500, 'database', 'تعذر إنشاء الحساب، حاول مرة أخرى');
  }

  const newUserId = created.user.id;

  // The on_auth_user_created trigger already inserted a profiles row
  // (role='displaced', status='pending') by the time createUser() resolved.
  // A second INSERT would silently no-op (ON CONFLICT DO NOTHING) — this
  // MUST be an UPDATE.
  const { data: promoted, error: promoteError } = await service
    .from('profiles')
    .update({ full_name: fullName, phone, role: 'camp_admin', camp_id: campId, status })
    .eq('id', newUserId)
    .select('id, full_name, phone, camp_id, status, created_at')
    .maybeSingle();

  if (promoteError || !promoted) {
    console.error('[admin-create-camp-admin] profile promotion failed, rolling back', newUserId, promoteError);
    const { error: cleanupError } = await service.auth.admin.deleteUser(newUserId);
    if (cleanupError) {
      console.error('[admin-create-camp-admin] rollback delete failed — orphaned auth user', newUserId, cleanupError);
    }
    return errorResponse(500, 'database', 'تعذر إنشاء الحساب، حاول مرة أخرى');
  }

  return jsonResponse(
    {
      admin: {
        id: promoted.id,
        fullName: promoted.full_name,
        email,
        phone: promoted.phone,
        campId: promoted.camp_id,
        status: promoted.status,
        createdAt: promoted.created_at,
      },
    },
    201
  );
});
