// Phase 3 §19: secure deletion.
//
// documents_select_scoped (RLS) is broader than documents_delete_admin — it
// also lets a displaced person read their own family's documents — so a
// successful select does NOT by itself prove delete authorization. Deletion
// is explicitly re-checked against the caller's own profile (role + camp,
// mirroring documents_delete_admin exactly) BEFORE anything is destroyed on
// Cloudinary. That order matters: an unauthorized caller must never be able
// to trigger destruction of a real asset just by calling this function, even
// if the later database delete would itself be rejected by RLS.
//
// Deletion order: verify ownership/scope -> Cloudinary destroy -> metadata
// delete ONLY if the destroy succeeded (or the asset was already gone). A
// genuine Cloudinary failure leaves the metadata row intact and returns an
// error, per spec ("do not blindly delete the database metadata").
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/http.ts';
import { callerClient, callerUser } from '../_shared/supabase-client.ts';
import { destroyOnCloudinary, loadCloudinaryConfig } from '../_shared/cloudinary.ts';

const NOT_FOUND = 'السجل غير موجود';
const FORBIDDEN = 'لا تملك صلاحية حذف هذا المستند';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'validation', 'الطريقة غير مدعومة');

  const authHeader = req.headers.get('Authorization');
  const client = callerClient(authHeader ?? '');
  const user = await callerUser(client, authHeader);
  if (!user) return errorResponse(401, 'unauthorized', 'يجب تسجيل الدخول لإتمام هذا الإجراء');

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'validation', 'طلب غير صالح');
  }
  const id = body.id;
  if (!id) return errorResponse(400, 'validation', 'معرّف المستند مطلوب');

  const { data: doc, error: docError } = await client
    .from('documents')
    .select('id, camp_id, storage_provider, cloudinary_public_id')
    .eq('id', id)
    .maybeSingle();
  if (docError || !doc) return errorResponse(404, 'not_found', NOT_FOUND);

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('role, camp_id')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError || !profile) return errorResponse(403, 'forbidden', FORBIDDEN);

  const authorized = profile.role === 'super_admin' || (profile.role === 'camp_admin' && profile.camp_id === doc.camp_id);
  if (!authorized) return errorResponse(403, 'forbidden', FORBIDDEN);

  if (doc.storage_provider === 'cloudinary' && doc.cloudinary_public_id) {
    let config;
    try {
      config = loadCloudinaryConfig();
    } catch {
      return errorResponse(500, 'upstream', 'خدمة تخزين الملفات غير مهيأة حالياً');
    }

    const destroyed = await destroyOnCloudinary(config, doc.cloudinary_public_id).catch((err) => {
      console.error('[documents-delete] cloudinary destroy threw', err);
      return false;
    });
    if (!destroyed) {
      return errorResponse(502, 'upstream', 'تعذر حذف الملف من التخزين، لم يتم حذف السجل. حاول مرة أخرى');
    }
  }

  const { error: deleteError } = await client.from('documents').delete().eq('id', id);
  if (deleteError) {
    // The Cloudinary asset is already gone at this point — log the
    // inconsistency rather than silently reporting success (§19/§36).
    console.error('[documents-delete] metadata delete failed after cloudinary destroy', id, deleteError);
    return errorResponse(500, 'database', 'تم حذف الملف من التخزين لكن تعذر حذف السجل، أبلغ الدعم الفني');
  }

  return jsonResponse({ deleted: true });
});
