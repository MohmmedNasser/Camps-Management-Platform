# Design: Family model rework, unified filter modal, document download, aid multi-beneficiary/multi-type

Date: 2026-08-16
Status: Approved for planning

## Context

Incremental changes to the existing frontend-only camps-management prototype (see `CLAUDE.md` for architecture layering, which this design does not change). Four independent sub-projects, decomposed because they touch different layers and can be sequenced/parallelized independently:

1. Family/person model rework (remove residence field, add marital status, automatic orphan calculation from parent status)
2. Unify all filter UIs on the existing modal-based toolbar mode
3. Document download from the documents page
4. Aid model overhaul: multi-type, multi-family-beneficiary distributions

All four preserve existing architecture (`data → store → selectors → pages → ui`), roles/permissions, RTL design, and the Excel export pattern.

## 1. Family / person model rework

### Remove `currentResidence`
Delete the field and every reference:
- `ui/record-forms.js` — `displacedFields()` input (~line 200-206)
- `core/selectors.js` — `SHARED_HOUSEHOLD_FIELDS` array (~line 281-290)
- `js/pages/family-create.js` — head payload (~line 146)
- `js/pages/displaced-details.js` (~line 203), `js/pages/family-details.js` (~line 200), `js/pages/profile.js` (~line 247) — display reads
- `data/mock-data.js` — seed values on every person record

Not present in validation schema, filters, or Excel export today — nothing to remove there. No replacement field; location is derived from the assigned camp.

### Marital status
`MARITAL_STATUSES` already exists in `core/config.js` and is already wired into `displacedFields()` (person/head edit form). The gap is `memberFields()` (family-creation member sub-form), which lacks it entirely. Add the same `selectField({ name: 'maritalStatus', ... })` there, and read it in `readMember()`. No new config needed.

### Automatic orphan calculation
Replace the manual `isOrphan` checkbox — currently duplicated in both `displacedFields()` (~line 236-241) and `memberFields()` (~line 462-467) — with two selects:

- `fatherStatus`: `alive` | `deceased`
- `motherStatus`: `alive` | `deceased`

New `PARENT_STATUS` option list in `core/config.js`:
```js
export const PARENT_STATUS = [
  { value: 'alive', label: 'على قيد الحياة' },
  { value: 'deceased', label: 'متوفى' }, // rendered per-field with gendered label where needed
];
```

Add one function in `core/selectors.js`:
```js
export function isOrphan(person) {
  return person.fatherStatus === 'deceased' || person.motherStatus === 'deceased';
}
```

This is the **only** place orphan status is computed. Route every consumer through it:
- `personFacts()` — replace `isOrphan: Boolean(person.isOrphan)` with `isOrphan: isOrphan(person)`
- `familyFacts()` orphan count
- Dashboard aggregate (~selectors.js:1049) and per-camp stat (~selectors.js:1237)
- Two call sites that currently bypass `personFacts()` and read `person.isOrphan` directly: `displaced-details.js:189`, `family-details.js:252` (member badge) — switch both to the computed value

Filters (`displaced.js` `ORPHAN_FILTER`) and Excel export (`DISPLACED_COLUMNS`/`FAMILY_COLUMNS`) already read through `personFacts()`/`facts.isOrphan` — they get the fix automatically once the source function changes, no UI changes needed there.

Orphan status is displayed (badges, detail pages, stats) but never editable — no form control writes it anywhere.

### Mock data / validation
- Remove `isOrphan` from every seed record; add `fatherStatus`/`motherStatus` (default `alive`/`alive`; flip one to `deceased` on the ~4 records currently seeded with `isOrphan: true`, so existing demo scenarios keep showing an orphan)
- Remove `currentResidence` from every seed record
- Bump `SEED_VERSION` in `data/mock-data.js` (shared bump with the aid model change below — one reseed covers both)
- `store.validateData()`: add a check rejecting any stray `isOrphan` key on a person record (mirrors the existing pattern that rejects removed aid fields)

## 2. Unified filter modal

`ui/toolbar.js` already has a fully-built `modal: true` mode (used today by `displaced.js`/`families.js`): it opens `openFilterSheet()`, which wraps `ui/modal.js`'s `openModal()`, stages values locally, and only commits on "تطبيق الفلاتر". This mode is **not changed** — it already satisfies every requirement in the brief (staged state, apply/reset/cancel, Escape, outside click, RTL, mobile).

Change is purely per-page: flip the inline pages to `modal: true`:
- `organizations.js`, `aid.js`, `documents.js`, `registration-requests.js`, `camp-admins.js`, `messages.js`

`camps.js` has no filter array today (search only) — left unchanged, nothing to put in a modal. `design-system.js`'s toolbar demo is updated for consistency with the rest of the reference page.

**Deviation from current CLAUDE.md text**: CLAUDE.md documents the inline/instant mode as intentional for every list page except displaced/families ("every other list page stays instant"). The new requirement is that *no* page may have an inline panel. This design treats the new requirement as authoritative and updates that paragraph in CLAUDE.md to describe the modal-everywhere state instead of leaving the doc contradicting the code.

## 3. Document download

No data model change — `dataUrl` already exists on document records (populated for small images uploaded through the browser; empty for PDFs, large files, and all current seed data).

Add one helper in `js/pages/documents.js`:
```js
function downloadDocument(row) {
  if (!row.dataUrl) return; // caller disables the control in this case
  const a = document.createElement('a');
  a.href = row.dataUrl;
  a.download = filenameWithExtension(row.name, row.mime);
  a.click();
}
```
`filenameWithExtension` maps `mime` → extension and appends it to `row.name` if not already present.

Wire it into two places:
- A "تنزيل" row action in the documents table (`ui/table.js` `rowActions`)
- A "تنزيل المستند" button in the existing `openPreview()` modal footer

When `dataUrl` is empty, the control renders disabled with a tooltip ("الملف غير متاح للتنزيل") rather than being hidden or generating fake content, so the row/modal stays visually consistent.

## 4. Aid model overhaul

### Data model
```
{ id, organizationId, campId, date, types: string[], familyIds: string[], allFamiliesSelected: boolean, createdBy, createdAt }
```
- `type` (scalar) → `types` (array, min 1)
- `familyId` (scalar) → `familyIds` (array, min 1)
- `quantity` and `description` are **dropped** (confirmed with user — matches the item-18 example form, which has neither, and item 18's explicit ban on "تفاصيل المساعدة")
- `allFamiliesSelected` is a **display-only** convenience flag (drives the "جميع الأسر" label in list/details). Matching logic never reads it — it always goes through the concrete `familyIds` array.

### "All families" is a resolved snapshot, not a live flag
Clicking "تحديد جميع الأسر" checks every family currently eligible (same camp-scoping the aid form already applies) and stores those concrete IDs into `familyIds`. A family created after the distribution does not retroactively appear in it. This keeps `aidForFamily` a simple array-membership check and matches how a real one-time distribution event works. The admin can still deselect individual families afterward (per spec), which simply removes IDs from the array and clears `allFamiliesSelected`.

### Form (`ui/record-forms.js` `aidFields`)
- `types`: checkbox group over existing `AID_TYPES` (no new taxonomy)
- `familyIds`: searchable multi-select checklist (families scoped to the admin's camp, same scoping as today) + "تحديد جميع الأسر" / "إلغاء تحديد الكل" button pair, plus a live "تم تحديد N أسرة" count under the list that updates on every checkbox change
- `organizationId`, `date`: unchanged, required
- Donor phone: **not a new form field.** The organization/donor record already carries an optional phone (existing domain rule). The aid *details* view surfaces it read-only ("رقم الجوال إن وجد") — the create form does not collect it.
- Removed entirely: `quantity`, `description`, and (already-absent) price/value/recipient fields

### Validation (`aidSchema`)
- `types`: at least one selected — error: "يرجى اختيار نوع مساعدة واحد على الأقل."
- `familyIds`: at least one selected — error: "يرجى اختيار أسرة واحدة على الأقل."
- `organizationId`, `date`: required (unchanged)

### Camp scope security (explicit requirement, already satisfied by construction)
The family checklist's options come from `select.familyOptions(session.campId)`, called server-side-equivalent in the page module using the **session's** `campId` — never from a query string or any client-editable input. A Camp Admin therefore cannot see, select, or export another camp's families through this picker, including via URL manipulation, because the option list itself never contains another camp's family IDs to begin with. `aid-create.html`/`aid-edit.html` remain in `PAGE_ACCESS` for `ROLES.CAMP_ADMIN` only (unchanged) — Super Admin does not reach this form today, so the "Super Admin selects across all camps" principle is a design note for if that page is ever opened to Super Admin, not a change made now (permissions are preserved per the brief's constraints).

### Selectors
- `aidForFamily(familyId)` / `aidForPerson(displacedId)`: `record.familyIds.includes(familyId)` instead of scalar equality
- `searchAid({ type, familyId, ... })`: filters/text-search operate over `types`/`familyIds` arrays (`types.includes(filter)`, `familyIds.includes(filter)`, search across all beneficiary family head names)
- `aidRow(record)`: adds `typeLabels` (joined "طرد غذائي، مياه"), `beneficiaryCount` (`familyIds.length`); detail view additionally resolves the full beneficiary family list (head name, family ID) for a searchable list

### Pages
- `aid.js` (list): Camp Admin/Super Admin table shows joined type labels + beneficiary count instead of a single family name. Displaced role's read-only card view is unchanged in spirit — still only ever shows their own family's distributions via `scopeFilter` + `aidForFamily`, never other families' data.
- `aid-details.js`: shows donor, phone (from organization, if present), joined types, beneficiary count, distribution date, and a searchable beneficiary family list. No monetary value, no "recipient" individual — beneficiary entity is always the family.

### Excel export
No aid export exists today (`aid.js` never touches `exports.js`/`xlsx.js`). Add `AID_COLUMNS`/`aidExportRow` to `core/exports.js` following the existing displaced/families export pattern: types joined by "، ", a beneficiary-count column, no monetary column. Administrative only (Camp Admin/Super Admin), scoped by session, refuses to write an empty file — same rules as the existing exports.

### Mock data / validation
- Convert seeded aid records: `{type, familyId, quantity, description}` → `{types:[type], familyIds:[familyId]}`, dropping quantity/description
- Shares the `SEED_VERSION` bump from section 1
- `store.validateData()`: reject stray `type`/`familyId`/`quantity`/`description`/`value`/`displacedId` keys on aid records; require `types.length >= 1` and `familyIds.length >= 1`

## Data integrity checklist (carried into testing)

- A family cannot be accidentally duplicated by the multi-family aid flow (one record, array of beneficiaries — no per-family record fan-out)
- A family can receive multiple aid distributions; one distribution can target multiple families; one distribution can carry multiple types
- Orphan status is always calculated, never independently stored or manually editable
- Every filter UI opens through the shared modal — no inline panel remains anywhere
- Document downloads work only where `dataUrl` exists; no fake content is generated
- Existing Excel exports (displaced, families) continue to work unchanged; a new aid export is added
- Role permissions are unchanged throughout
