-- =============================================================================
-- 004 · Reference data
--
-- Not development data: these rows are part of the application's vocabulary and
-- belong in every environment. They mirror AID_TYPES in assets/js/core/config.js
-- exactly — same codes, same Arabic labels, same order — so the frontend's
-- labelOf() lookups keep resolving after the cut-over.
--
-- Development-only fixtures (camps, families, people, distributions) live in
-- supabase/seed/ and are never applied to production.
-- =============================================================================

insert into public.aid_types (code, label_ar, sort_order) values
  ('food',      'غذائية',      1),
  ('financial', 'مالية',       2),
  ('medical',   'طبية',        3),
  ('medicine',  'أدوية',       4),
  ('blankets',  'بطانيات',     5),
  ('water',     'مياه',        6),
  ('clothes',   'ملابس',       7),
  ('cleaning',  'مواد تنظيف',  8),
  ('household', 'أدوات منزلية', 9),
  ('other',     'أخرى',        10)
on conflict (code) do update
  set label_ar   = excluded.label_ar,
      sort_order = excluded.sort_order;
