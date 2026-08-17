// Phase 3 §17, §18: secure download and preview — one path for both, per
// spec ("Preview must use the same security rules as download. Do not
// create a separate weaker authorization path.").
//
// Authorization is the RLS-scoped select itself: documents_select_scoped
// already covers super_admin (all), camp_admin (own camp) and displaced
// (own family) exactly. Zero rows means either "does not exist" or "not
// authorized" and both return the same generic 404 (§28/§29: a wrong id,
// family id or member id must not be distinguishable from "not found").
//
// The Edge Function fetches the bytes from Cloudinary itself and streams
// them back — the browser never receives a Cloudinary URL or credential, so
// there is nothing to leak by inspecting network traffic or guessing ids.
import { corsHeaders } from '../_shared/cors.ts';
import { contentDisposition, errorResponse } from '../_shared/http.ts';
import { callerClient, callerUser } from '../_shared/supabase-client.ts';
import { fetchFromCloudinary, loadCloudinaryConfig } from '../_shared/cloudinary.ts';

const NOT_FOUND = 'السجل غير موجود';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'validation', 'الطريقة غير مدعومة');

  const authHeader = req.headers.get('Authorization');
  const client = callerClient(authHeader ?? '');
  const user = await callerUser(client, authHeader);
  if (!user) return errorResponse(401, 'unauthorized', 'يجب تسجيل الدخول لإتمام هذا الإجراء');

  let body: { id?: string; mode?: 'inline' | 'attachment' };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'validation', 'طلب غير صالح');
  }
  const id = body.id;
  const mode = body.mode === 'attachment' ? 'attachment' : 'inline';
  if (!id) return errorResponse(400, 'validation', 'معرّف المستند مطلوب');

  const { data: doc, error } = await client
    .from('documents')
    .select('id, name, mime_type, storage_provider, cloudinary_public_id')
    .eq('id', id)
    .maybeSingle();

  if (error || !doc) return errorResponse(404, 'not_found', NOT_FOUND);
  if (doc.storage_provider !== 'cloudinary' || !doc.cloudinary_public_id) {
    return errorResponse(404, 'not_found', 'لا يتوفر ملف مرفوع لهذا المستند');
  }

  let config;
  try {
    config = loadCloudinaryConfig();
  } catch {
    return errorResponse(500, 'upstream', 'خدمة تخزين الملفات غير مهيأة حالياً');
  }

  let upstream: Response;
  try {
    upstream = await fetchFromCloudinary(config, doc.cloudinary_public_id);
  } catch (err) {
    console.error('[documents-access] cloudinary fetch failed', err);
    return errorResponse(502, 'upstream', 'تعذر جلب الملف، حاول مرة أخرى');
  }

  // supabase-js's FunctionsClient only auto-parses a response into a Blob
  // when Content-Type is exactly 'application/octet-stream' — anything else
  // (including a real image/pdf MIME type) is decoded as UTF-8 text, which
  // corrupts binary bytes. The document's real name/MIME travel as custom
  // headers instead (exposed via Access-Control-Expose-Headers in cors.ts)
  // for the frontend to re-type the Blob with.
  //
  // Every header value must be a Latin-1 ByteString (Headers/Response throw
  // otherwise), so X-Document-Name is percent-encoded too — decode with
  // decodeURIComponent() on the way out. contentDisposition() does the same
  // for the Content-Disposition filename directives.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/octet-stream',
      'X-Document-Mime': doc.mime_type || 'application/octet-stream',
      'X-Document-Name': encodeURIComponent(doc.name || 'document'),
      'Content-Disposition': contentDisposition(mode, doc.name || 'document'),
      'Cache-Control': 'private, no-store',
    },
  });
});
