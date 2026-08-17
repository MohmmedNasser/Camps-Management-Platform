// Phase 3 §10, §15: secure document creation.
//
// 1. authenticate (verify_jwt at the platform gateway + auth.getUser here)
// 2/3. authorize + verify ownership — done together: the RLS-scoped select
//      below either returns the target row (caller is in scope) or nothing
//      (caller is not authorized OR the row doesn't exist — same generic
//      response either way, so existence is never leaked)
// 4. validate the file (magic bytes + size)
// 5-9. signed Cloudinary upload
// 10. insert metadata through the SAME caller-scoped client, so
//     documents_insert_scoped re-checks independently (defense in depth)
// 11. return safe JSON — never Cloudinary credentials
//
// On metadata-insert failure after a successful upload, the just-created
// Cloudinary asset is destroyed before returning the error (§36 orphan
// cleanup).
import { corsHeaders } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/http.ts';
import { callerClient, callerUser } from '../_shared/supabase-client.ts';
import {
  CATEGORY_FOLDERS,
  MAX_FILE_SIZE,
  destroyOnCloudinary,
  loadCloudinaryConfig,
  uploadToCloudinary,
  validateFileType,
} from '../_shared/cloudinary.ts';

const CATEGORIES = Object.keys(CATEGORY_FOLDERS);

const GENERIC_FORBIDDEN = 'لا تملك صلاحية رفع مستند لهذا السجل';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'validation', 'الطريقة غير مدعومة');

  const authHeader = req.headers.get('Authorization');
  const client = callerClient(authHeader ?? '');
  const user = await callerUser(client, authHeader);
  if (!user) return errorResponse(401, 'unauthorized', 'يجب تسجيل الدخول لإتمام هذا الإجراء');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse(400, 'validation', 'طلب غير صالح');
  }

  const file = form.get('file');
  const name = String(form.get('name') ?? '').trim();
  const category = String(form.get('category') ?? '');
  const familyMemberId = (form.get('family_member_id') as string | null) || null;
  const familyId = (form.get('family_id') as string | null) || null;
  const registrationRequestId = (form.get('registration_request_id') as string | null) || null;

  if (!(file instanceof File)) return errorResponse(400, 'validation', 'اختر ملفاً أولاً');
  if (!name) return errorResponse(400, 'validation', 'اسم المستند مطلوب');
  if (!CATEGORIES.includes(category)) return errorResponse(400, 'validation', 'نوع المستند غير صالح');
  if (!familyMemberId && !familyId && !registrationRequestId) {
    return errorResponse(400, 'validation', 'يجب تحديد صاحب المستند');
  }
  if (file.size > MAX_FILE_SIZE) {
    return errorResponse(413, 'payload_too_large', `الملف أكبر من الحد المسموح (${Math.round(MAX_FILE_SIZE / 1024 / 1024)} ميجابايت)`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const typeCheck = validateFileType(file.type, bytes);
  if (!typeCheck.ok) {
    return errorResponse(415, 'unsupported_type', 'نوع الملف غير مدعوم — JPG أو PNG أو WEBP أو PDF فقط');
  }

  // Resolve the owner + camp server-side. Client-supplied camp_id/family_id
  // are never trusted (§26): an RLS-scoped select either returns the row
  // (caller is genuinely in scope) or nothing.
  let resolved: { camp_id: string; family_id: string | null; family_member_id: string | null; registration_request_id: string | null };

  if (familyMemberId) {
    const { data, error } = await client
      .from('family_members')
      .select('id, family_id, camp_id')
      .eq('id', familyMemberId)
      .maybeSingle();
    if (error || !data) return errorResponse(403, 'forbidden', GENERIC_FORBIDDEN);
    resolved = { camp_id: data.camp_id, family_id: data.family_id, family_member_id: data.id, registration_request_id: null };
  } else if (familyId) {
    const { data, error } = await client.from('families').select('id, camp_id').eq('id', familyId).maybeSingle();
    if (error || !data) return errorResponse(403, 'forbidden', GENERIC_FORBIDDEN);
    resolved = { camp_id: data.camp_id, family_id: data.id, family_member_id: null, registration_request_id: null };
  } else {
    const { data, error } = await client
      .from('registration_requests')
      .select('id, camp_id')
      .eq('id', registrationRequestId!)
      .maybeSingle();
    if (error || !data) return errorResponse(403, 'forbidden', GENERIC_FORBIDDEN);
    resolved = { camp_id: data.camp_id, family_id: null, family_member_id: null, registration_request_id: data.id };
  }

  let config;
  try {
    config = loadCloudinaryConfig();
  } catch {
    return errorResponse(500, 'upstream', 'خدمة تخزين الملفات غير مهيأة حالياً');
  }

  const publicId = crypto.randomUUID();
  let uploaded;
  try {
    uploaded = await uploadToCloudinary(config, file, { publicId, category });
  } catch (err) {
    console.error('[documents-upload] cloudinary upload failed', err);
    return errorResponse(502, 'upstream', 'تعذر رفع الملف، حاول مرة أخرى');
  }

  const { data: inserted, error: insertError } = await client
    .from('documents')
    .insert({
      name,
      category,
      camp_id: resolved.camp_id,
      family_id: resolved.family_id,
      family_member_id: resolved.family_member_id,
      registration_request_id: resolved.registration_request_id,
      original_filename: file.name,
      mime_type: file.type,
      file_size: file.size,
      storage_provider: 'cloudinary',
      cloudinary_public_id: uploaded.public_id,
      secure_url: uploaded.secure_url,
      resource_type: uploaded.resource_type,
      format: uploaded.format,
      uploaded_by: user.id,
    })
    .select('id, name, category, original_filename, mime_type, file_size, created_at')
    .single();

  if (insertError || !inserted) {
    // Orphan cleanup (§36): the metadata row never made it in, so the asset
    // just created on Cloudinary must not be left unreferenced.
    const cleaned = await destroyOnCloudinary(config, publicId).catch(() => false);
    if (!cleaned) console.error('[documents-upload] orphan cleanup failed for', publicId, insertError);
    return errorResponse(403, 'forbidden', GENERIC_FORBIDDEN);
  }

  return jsonResponse({ document: inserted }, 201);
});
