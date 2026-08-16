# Family model, filter modal, document download, aid overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the family "current residence" field, replace the manual orphan checkbox with an automatic calculation from parent life-status, move every list page's filters into the existing modal-based toolbar mode, add document download, and rework aid records to support multiple aid types and multiple beneficiary families per distribution.

**Architecture:** No new architectural layers. Every task modifies existing files within the established `data → store → selectors → pages → ui` layering (see `CLAUDE.md`). No build step, no new dependencies — vanilla ES modules only.

**Tech Stack:** Vanilla HTML5 / CSS3 / ES6 modules, no framework, no bundler. `npx serve .` for local verification.

**Spec:** `docs/superpowers/specs/2026-08-16-family-aid-filters-documents-design.md`

## Global Constraints

- No backend, no build step, no new npm dependencies — everything ships as plain ES modules served statically.
- Every visible string is Arabic; code/identifiers stay English (`CLAUDE.md` → Conventions → Language).
- All interpolated values go through `esc()` or the field-renderer helpers already in `ui/form.js` — never raw string concatenation of untrusted data.
- Pages never read `localStorage` directly — only `core/store.js` does.
- `store.validateData()` must return `[]` after every task that touches seed data or a record shape (`CLAUDE.md` → Verifying changes).
- `SEED_VERSION` in `data/mock-data.js` must be bumped whenever a record shape changes, so `store.ensureSeeded()` reseeds stale browser data.
- Aid has no price, value, estimated value, or individual recipient — the beneficiary is always the family (`CLAUDE.md` domain rule #9, #10).
- Excel export is administrative only (Camp Admin / Super Admin), scoped by session, and refuses to write an empty file (`CLAUDE.md` domain rule #17).
- Role permissions (`core/auth.js` `PERMISSIONS`/`can()`) are not changed by this plan.

## Verification approach used throughout this plan

This repo has no test runner (`CLAUDE.md` → Verifying changes). Every task below is verified with the two methods the project already documents:

1. **`store.validateData()`** in the browser console — must return `[]`.
2. **A running dev server** (`npx serve .` from the repo root, default `http://localhost:3000`) with concrete click-through steps and expected results.

Start the server once before Task 1 and leave it running (it serves static files; no restart is needed between tasks — a hard refresh picks up every change, except the several tasks that change `SEED_VERSION`, which self-reseed on next load automatically).

Sign-in for manual checks: use the `admin@camps.ps` / `123456` one-click login button (Camp Admin) unless a step says otherwise.

---

### Task 1: `PARENT_STATUS` config and the `isOrphan()` calculation

**Files:**
- Modify: `assets/js/core/config.js`
- Modify: `assets/js/core/selectors.js`

**Interfaces:**
- Produces: `PARENT_STATUS` (config.js) — `[{value:'alive',label:'على قيد الحياة'},{value:'deceased',label:'متوفى'}]`
- Produces: `isOrphan(person)` (selectors.js) — `(person) => boolean`, the single source of truth every later task must call instead of reading `person.isOrphan`.

- [ ] **Step 1: Add `PARENT_STATUS` to config.js**

In `assets/js/core/config.js`, immediately after the `MARITAL_STATUSES` block (after line 65):

```js
export const PARENT_STATUS = [
  { value: 'alive', label: 'على قيد الحياة' },
  { value: 'deceased', label: 'متوفى' },
];
```

- [ ] **Step 2: Add `isOrphan()` to selectors.js and route every consumer through it**

In `assets/js/core/selectors.js`, add the function right before `personFacts` (before line 104):

```js
/**
 * A person is an orphan when either parent is recorded as deceased. This is
 * the only place orphan status is computed — nothing stores it directly.
 */
export function isOrphan(person) {
  return person.fatherStatus === 'deceased' || person.motherStatus === 'deceased';
}
```

Then in `personFacts()` (line 115), replace:
```js
    isOrphan: Boolean(person.isOrphan),
```
with:
```js
    isOrphan: isOrphan(person),
```

In `familyFacts()` (line 189), replace:
```js
    orphans: count((m) => m.isOrphan),
```
with:
```js
    orphans: count(isOrphan),
```

In `statistics()` (line 1049), replace:
```js
    orphans: people.filter((person) => Boolean(person.isOrphan)).length,
```
with:
```js
    orphans: people.filter(isOrphan).length,
```

In `campBreakdown()` (line 1237), replace:
```js
      orphansCount: people.filter((person) => Boolean(person.isOrphan)).length,
```
with:
```js
      orphansCount: people.filter(isOrphan).length,
```

In `approveRequest()` (lines 726-737), the newly-created person no longer has an `isOrphan` field — replace:
```js
    incomeSource: 'none',
    monthlyIncome: 0,
    chronicDiseases: '',
    disability: '',
    isOrphan: false,
    status: STATUS.APPROVED,
```
with:
```js
    incomeSource: 'none',
    monthlyIncome: 0,
    chronicDiseases: '',
    disability: '',
    fatherStatus: 'alive',
    motherStatus: 'alive',
    status: STATUS.APPROVED,
```

- [ ] **Step 3: Verify with the browser console (no seed change yet — old `isOrphan` field still present on stored records, so this checks the calculation degrades safely)**

Open `http://localhost:3000/dashboard.html`, sign in as `admin@camps.ps`. Open DevTools console and run:
```js
import('./assets/js/core/selectors.js').then(s => console.log(s.isOrphan({ fatherStatus: 'deceased' })))
```
Expected: `true`. Run again with `{ motherStatus: 'deceased' }` → `true`. Run with `{}` → `false`. Run with `{ fatherStatus: 'alive', motherStatus: 'alive' }` → `false`.

- [ ] **Step 4: Commit**

```bash
git add assets/js/core/config.js assets/js/core/selectors.js
git commit -m "feat: compute orphan status from parent life-status instead of a manual flag"
```

---

### Task 2: Replace the manual orphan checkbox and add marital status to family members

**Files:**
- Modify: `assets/js/ui/record-forms.js`

**Interfaces:**
- Consumes: `PARENT_STATUS` from `core/config.js` (Task 1)
- Produces: `displacedFields()` and `memberFields()` now render `fatherStatus`/`motherStatus` selects instead of an `isOrphan` checkbox; `memberFields()` also renders `maritalStatus`; `readMember()` returns `fatherStatus`, `motherStatus`, `maritalStatus` instead of `isOrphan`.

- [ ] **Step 1: Import `PARENT_STATUS`**

In `assets/js/ui/record-forms.js`, add `PARENT_STATUS` to the `core/config.js` import list (line 27-41):
```js
import {
  GENDERS,
  MARITAL_STATUSES,
  PARENT_STATUS,
  NATIONALITIES,
  TENT_TYPES,
  GOVERNORATES,
  WORK_STATUSES,
  INCOME_SOURCES,
  RELATIONSHIPS,
  AID_TYPES,
  DOCUMENT_CATEGORIES,
  MESSAGE_SUBJECTS,
  STATUS,
  STATUS_LABELS,
} from '../core/config.js';
```

- [ ] **Step 2: Remove `currentResidence` from `displacedFields()`**

Delete this block from the "بيانات النزوح والإقامة" fieldset (lines 200-206):
```js
        inputField({
          name: 'currentResidence',
          label: 'مكان الإقامة الحالي',
          value: values.currentResidence,
          placeholder: 'القطاع أو البلوك داخل المخيم',
          full: true,
        }),
```

- [ ] **Step 3: Replace the `isOrphan` checkbox in `displacedFields()` with parent-status selects**

Replace (lines 231-241):
```js
    fieldset({
      legend: 'الحالة الاجتماعية',
      // The maternity block is revealed only for a female record — see
      // `bindMaternityFields` in ui/form.js. A male file never shows it.
      fields: [
        checkboxField({
          name: 'isOrphan',
          label: 'يتيم',
          description: 'يُحتسب ضمن عدد الأيتام في إحصائيات المخيم.',
          checked: Boolean(values.isOrphan),
        }),
```
with:
```js
    fieldset({
      legend: 'الحالة الاجتماعية',
      hint: 'حالة اليتم تُحتسب تلقائياً من حالة الوالدين ولا يمكن تعديلها مباشرة.',
      // The maternity block is revealed only for a female record — see
      // `bindMaternityFields` in ui/form.js. A male file never shows it.
      fields: [
        selectField({
          name: 'fatherStatus',
          label: 'حالة الأب',
          options: PARENT_STATUS,
          value: values.fatherStatus || 'alive',
        }),
        selectField({
          name: 'motherStatus',
          label: 'حالة الأم',
          options: PARENT_STATUS,
          value: values.motherStatus || 'alive',
        }),
```
(the maternity `<div data-maternity="gender">…</div>` block immediately after stays untouched.)

- [ ] **Step 4: Add `maritalStatus` to `memberFields()`**

In `memberFields()`, right after the `relationship` select (after the block ending line 433, before the `birthDate` field), insert:
```js
        ${selectField({
          name: at('maritalStatus'),
          label: 'الحالة الاجتماعية',
          options: MARITAL_STATUSES,
          value: values.maritalStatus,
        })}
```

- [ ] **Step 5: Replace the `isOrphan` checkbox in `memberFields()` with parent-status selects**

Replace (lines 462-467):
```js
        ${checkboxField({
          name: at('isOrphan'),
          label: 'يتيم',
          description: 'يُحتسب ضمن عدد الأيتام في إحصائيات المخيم.',
          checked: Boolean(values.isOrphan),
        })}
```
with:
```js
        ${selectField({
          name: at('fatherStatus'),
          label: 'حالة الأب',
          options: PARENT_STATUS,
          value: values.fatherStatus || 'alive',
        })}
        ${selectField({
          name: at('motherStatus'),
          label: 'حالة الأم',
          options: PARENT_STATUS,
          value: values.motherStatus || 'alive',
        })}
```

- [ ] **Step 6: Update `readMember()`**

Replace (line 516):
```js
    isOrphan: Boolean(at('isOrphan')),
```
with:
```js
    maritalStatus: at('maritalStatus') || 'single',
    fatherStatus: at('fatherStatus') || 'alive',
    motherStatus: at('motherStatus') || 'alive',
```

- [ ] **Step 7: Verify in the browser**

Open `http://localhost:3000/family-create.html` (sign in as `admin@camps.ps`). Confirm:
- The "بيانات النزوح والإقامة" fieldset no longer shows "مكان الإقامة الحالي".
- The "الحالة الاجتماعية" fieldset shows two selects, "حالة الأب" and "حالة الأم", both defaulting to "على قيد الحياة" — no "يتيم" checkbox anywhere.
- Click "إضافة فرد" — the new member block shows "الحالة الاجتماعية" (marital), "حالة الأب" and "حالة الأم" selects, no "يتيم" checkbox.

- [ ] **Step 8: Commit**

```bash
git add assets/js/ui/record-forms.js
git commit -m "feat: replace manual orphan checkbox with parent-status selects, add member marital status"
```

---

### Task 3: Wire the new fields into family creation and remove `currentResidence` from the shared-household copy

**Files:**
- Modify: `assets/js/pages/family-create.js`
- Modify: `assets/js/core/selectors.js` (`SHARED_HOUSEHOLD_FIELDS`)

**Interfaces:**
- Consumes: `readMember()` from Task 2 (now returns `fatherStatus`/`motherStatus`/`maritalStatus`)

- [ ] **Step 1: Remove `currentResidence` from `SHARED_HOUSEHOLD_FIELDS`**

In `assets/js/core/selectors.js` (lines 281-290), remove the `'currentResidence',` entry:
```js
const SHARED_HOUSEHOLD_FIELDS = [
  'tentType',
  'originGovernorate',
  'originCity',
  'displacementDate',
  'governorate',
  'city',
  'area',
];
```

- [ ] **Step 2: Update the head payload in `family-create.js`**

In `assets/js/pages/family-create.js`, inside the `onSubmit` callback (lines 127-155), replace:
```js
          tentType: values.tentType,
          originGovernorate: values.originGovernorate,
          originCity: values.originCity,
          currentResidence: values.currentResidence,
          displacementDate: values.displacementDate,
          chronicDiseases: (values.chronicDiseases || '').trim(),
          disability: (values.disability || '').trim(),
          isOrphan: Boolean(values.isOrphan),
```
with:
```js
          tentType: values.tentType,
          originGovernorate: values.originGovernorate,
          originCity: values.originCity,
          displacementDate: values.displacementDate,
          chronicDiseases: (values.chronicDiseases || '').trim(),
          disability: (values.disability || '').trim(),
          fatherStatus: values.fatherStatus || 'alive',
          motherStatus: values.motherStatus || 'alive',
```

- [ ] **Step 3: Verify in the browser**

Open `http://localhost:3000/family-create.html`, fill in a head with "الاسم الكامل" = "اختبار الأب المتوفى", a valid 9-digit "رقم الهوية", set "حالة الأب" to "متوفى", fill the remaining required fields (national ID, gender, birth date, phone, camp, tent type), submit. On the resulting family-details page, the new head should show as an orphan (verified fully once Task 5 wires the display — for now just confirm the record was created without error and `store.validateData()` in console still returns `[]`).

- [ ] **Step 4: Commit**

```bash
git add assets/js/core/selectors.js assets/js/pages/family-create.js
git commit -m "feat: wire parent-status fields into family creation, drop shared currentResidence"
```

---

### Task 4: Remove `currentResidence` display and switch orphan display to the computed value

**Files:**
- Modify: `assets/js/pages/displaced-details.js`
- Modify: `assets/js/pages/family-details.js`
- Modify: `assets/js/pages/profile.js`

**Interfaces:**
- Consumes: `select.isOrphan(person)` from Task 1.

- [ ] **Step 1: `displaced-details.js`**

Add `isOrphan` to the `import * as select from '../core/selectors.js'` usage (it's a namespace import already, `select.isOrphan` works directly — confirm the file already does `import * as select from '../core/selectors.js';` before proceeding; no import line changes needed).

Line 115, replace:
```js
    person.isOrphan ? badge('يتيم', 'info') : '',
```
with:
```js
    select.isOrphan(person) ? badge('يتيم', 'info') : '',
```

Line 189, replace:
```js
    definition('يتيم', person.isOrphan ? 'نعم' : 'لا'),
```
with:
```js
    definition('يتيم', select.isOrphan(person) ? 'نعم' : 'لا'),
```

Delete line 203 entirely:
```js
    definition('مكان الإقامة الحالي', person.currentResidence),
```

- [ ] **Step 2: `family-details.js`**

Delete line 200 entirely:
```js
            definition('مكان الإقامة', head ? head.currentResidence : ''),
```

Line 252, replace:
```js
            row.isOrphan ? badge('يتيم', 'info') : '',
```
with:
```js
            select.isOrphan(row) ? badge('يتيم', 'info') : '',
```
(confirm `select` is imported as a namespace in this file already — it is, per the existing `select.familyWithStats` etc. calls used elsewhere in the same file.)

- [ ] **Step 3: `profile.js`**

Delete line 247 entirely:
```js
          definition('مكان الإقامة الحالي', person.currentResidence),
```

- [ ] **Step 4: Verify in the browser**

Open the displaced-details page for any seeded person (e.g. from `http://localhost:3000/displaced.html`, click into any row). Confirm "مكان الإقامة الحالي" no longer appears, and the "يتيم" definition still renders "نعم"/"لا" correctly. Repeat for a family's detail page and for `profile.html` signed in as `ahmad@camps.ps`.

- [ ] **Step 5: Commit**

```bash
git add assets/js/pages/displaced-details.js assets/js/pages/family-details.js assets/js/pages/profile.js
git commit -m "feat: drop residence display, read orphan status from the computed selector"
```

---

### Task 5: Convert seed data and add integrity checks

**Files:**
- Modify: `assets/js/data/mock-data.js`
- Modify: `assets/js/core/store.js`

**Interfaces:**
- Produces: every seeded person record carries `fatherStatus`/`motherStatus` instead of `currentResidence`/`isOrphan`; `SEED_VERSION` becomes `5`.

- [ ] **Step 1: Update the `person()` factory's base defaults**

In `assets/js/data/mock-data.js`, inside the `base` object of `function person(id, values)` (around lines 205-214), replace:
```js
    campId: 'camp-1',
    tentType: 'tarp_tent',
    originGovernorate: '',
    originCity: '',
    currentResidence: '',
    displacementDate: '',

    chronicDiseases: '',
    disability: '',
    isOrphan: false,
```
with:
```js
    campId: 'camp-1',
    tentType: 'tarp_tent',
    originGovernorate: '',
    originCity: '',
    displacementDate: '',

    chronicDiseases: '',
    disability: '',
    fatherStatus: 'alive',
    motherStatus: 'alive',
```

- [ ] **Step 2: Bulk-remove every per-record `currentResidence` override**

Run from the repo root:
```bash
node -e "
const fs = require('fs');
const path = 'assets/js/data/mock-data.js';
let text = fs.readFileSync(path, 'utf8');
const before = (text.match(/currentResidence:/g) || []).length;
text = text.replace(/[ \t]*currentResidence: '[^']*',\r?\n/g, '');
fs.writeFileSync(path, text, 'utf8');
console.log('removed', before, 'currentResidence lines');
"
```
Expected output: `removed 34 currentResidence lines` (this count includes the one already removed from `base` in Step 1 if that step's edit is applied first — if the count differs, inspect with `git diff assets/js/data/mock-data.js` before continuing; every remaining `currentResidence` reference anywhere in the repo should now be gone).

- [ ] **Step 3: Preserve the four seeded orphan scenarios**

Four records set `isOrphan: true` in the original file — the pre-refactor line numbers were 460 (`d-9`), 481 (`d-10`), 799 (`d-23`), 822 (`d-24`); after Step 2's bulk edit those line numbers have shifted, so locate each by its unique `person('d-N', {` anchor instead. For each of the four, replace:
```js
    isOrphan: true,
```
with:
```js
    fatherStatus: 'deceased',
```
(scoped individually so only the record starting at `person('d-9', {`, `person('d-10', {`, `person('d-23', {`, and `person('d-24', {` is changed — use the Edit tool once per record, including a few surrounding lines such as the record's `fullName` or `nationalId` in `old_string` so each edit targets exactly one occurrence). `motherStatus` for these four stays at the base default `'alive'`, so together with `fatherStatus: 'deceased'` each becomes an orphan per `isOrphan()`.

- [ ] **Step 4: Confirm no `isOrphan` or `currentResidence` references remain in the seed file**

```bash
grep -n "isOrphan\|currentResidence" assets/js/data/mock-data.js || echo "clean"
```
Expected: `clean`.

- [ ] **Step 5: Bump `SEED_VERSION`**

Line 19, replace:
```js
export const SEED_VERSION = 4;
```
with:
```js
export const SEED_VERSION = 5;
```

- [ ] **Step 6: Add stray-field checks to `store.validateData()`**

In `assets/js/core/store.js`, inside the `displaced.list().forEach((person) => { ... })` loop (lines 239-246), add:
```js
    if ('isOrphan' in person || 'currentResidence' in person) {
      problems.push(`النازح ${person.id} يحتوي على حقول ملغاة (يتيم يدوي أو مكان إقامة)`);
    }
```

- [ ] **Step 7: Verify in the browser**

Open `http://localhost:3000/dashboard.html` and hard-refresh (the new `SEED_VERSION` triggers a reseed — any manual test data created in earlier tasks is wiped, which is expected). In the console, run `store.validateData()` — expected `[]`. Open `family-details.html?id=FAM-000003` and confirm the members formerly seeded as orphans (`d-9` هناء وليد أبو زيد, `d-10` كريم وليد أبو زيد) still show the "يتيم" badge. Repeat for `FAM-000008` (`d-23` لينا سامر شاهين, `d-24` أنس سامر شاهين). Check the dashboard's "الأيتام" statistic still shows a non-zero count.

- [ ] **Step 8: Commit**

```bash
git add assets/js/data/mock-data.js assets/js/core/store.js
git commit -m "feat: convert seed data to parent-status fields, bump SEED_VERSION, add integrity checks"
```

---

### Task 6: Unify every filter UI on the modal toolbar mode

**Files:**
- Modify: `assets/js/pages/organizations.js`
- Modify: `assets/js/pages/aid.js`
- Modify: `assets/js/pages/documents.js`
- Modify: `assets/js/pages/registration-requests.js`
- Modify: `assets/js/pages/camp-admins.js`
- Modify: `assets/js/pages/messages.js`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `toolbar()`'s existing `modal` option (`ui/toolbar.js`, unchanged) — passing `modal: true` is the entire per-page change; `initToolbar()` already auto-detects the mode from the rendered markup, no wiring changes needed.

- [ ] **Step 1: Flip each page's `toolbar()` call**

In each of the six files below, find the `toolbar({ ... })` call (all follow the same shape already seen in `documents.js` and `aid.js`) and add `modal: true,` as one of its top-level options (alongside `searchValue`, `filters`, `activeCount`):

- `assets/js/pages/organizations.js` — `toolbar({` call (confirmed present)
- `assets/js/pages/aid.js` — lines 107-114, add `modal: true,` after `activeCount: activeFilterCount(),`
- `assets/js/pages/documents.js` — lines 79-84, add `modal: true,` after `activeCount: [state.category, state.campId].filter(Boolean).length,`
- `assets/js/pages/registration-requests.js` — `toolbar({` call (confirmed present)
- `assets/js/pages/camp-admins.js` — `toolbar({` call (confirmed present)
- `assets/js/pages/messages.js` — `toolbar({` call (confirmed present)

No changes to `initToolbar()` calls in any of these files — the existing `onChange` handlers are unaffected; the sheet only changes how the values reach that same handler.

- [ ] **Step 2: Update the CLAUDE.md paragraph describing inline mode**

In `CLAUDE.md`, under **`ui/toolbar.js`**, replace:
```
  Filters may carry a `group` and render as labelled sections. `toolbar({ staged: true })` holds selections until "تطبيق الفلاتر" instead of re-querying per select — used by displaced and families, which carry ten-plus filters; every other list page stays instant.
```
with:
```
  Filters may carry a `group` and render as labelled sections. Every list page opens its filters through `toolbar({ modal: true })`, which stages selections in a sheet and commits them only on "تطبيق الفلاتر" — there is no inline instant-apply panel anywhere in the app.
```

- [ ] **Step 3: Verify each page in the browser**

For each of `organizations.html`, `aid.html`, `documents.html`, `registration-requests.html`, `camp-admins.html`, `messages.html` (sign in with whichever demo role has access — Super Admin `super@camps.ps` covers all of them): confirm the "فلترة" button opens a modal dialog (not an inline panel that pushes content down), that changing a filter inside the dialog does **not** update the result count until "تطبيق الفلاتر" is clicked, that "إعادة تعيين" clears and immediately applies empty filters, that `Escape` and clicking outside the dialog both close it without applying unsaved changes, and that the active-filter chip strip appears under the toolbar after applying.

- [ ] **Step 4: Commit**

```bash
git add assets/js/pages/organizations.js assets/js/pages/aid.js assets/js/pages/documents.js assets/js/pages/registration-requests.js assets/js/pages/camp-admins.js assets/js/pages/messages.js CLAUDE.md
git commit -m "feat: move every list page's filters into the shared modal sheet"
```

---

### Task 7: Document download

**Files:**
- Modify: `assets/js/pages/documents.js`

**Interfaces:**
- Produces: `downloadDocument(row)` — triggers a browser download when `row.dataUrl` is present, no-ops otherwise.

- [ ] **Step 1: Add the download helper and a filename/extension resolver**

In `assets/js/pages/documents.js`, add near the top of the file (after the imports, before `const state = ...`):
```js
const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

function filenameWithExtension(name, mime) {
  if (/\.[a-zA-Z0-9]{2,5}$/.test(name)) return name;
  const ext = MIME_EXTENSIONS[mime];
  return ext ? `${name}.${ext}` : name;
}

/** Triggers a real browser download. No-ops when there is no downloadable content. */
function downloadDocument(row) {
  if (!row.dataUrl) return;
  const link = document.createElement('a');
  link.href = row.dataUrl;
  link.download = filenameWithExtension(row.name, row.mime);
  document.body.appendChild(link);
  link.click();
  link.remove();
}
```

- [ ] **Step 2: Add a row action in the table**

In `resultsView()`, inside the `actions` column's `rowActions([...])` array (lines 190-197), add a download entry before the delete action:
```js
        rowActions([
          { iconName: 'eye', title: `معاينة ${row.name}`, attrs: `data-preview="${row.id}"` },
          row.dataUrl
            ? { iconName: 'download', title: `تنزيل ${row.name}`, attrs: `data-download="${row.id}"` }
            : { iconName: 'download', title: 'الملف غير متاح للتنزيل', attrs: 'disabled aria-disabled="true"' },
          can('document:delete') && {
            iconName: 'trash',
            title: `حذف ${row.name}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
```

- [ ] **Step 3: Wire the row action's click handler**

In `init()`, add alongside the existing `delegate(content, 'click', '[data-preview]', ...)` block:
```js
  delegate(content, 'click', '[data-download]', (event, node) => {
    const row = store.documents.get(node.dataset.download);
    if (row) downloadDocument(select.documentRow(row));
  });
```

- [ ] **Step 4: Add a download button to the preview modal**

In `openPreview(row)`, replace:
```js
    footer: button({ label: 'إغلاق', variant: 'secondary', attrs: 'data-close' }),
```
with:
```js
    footer: `
      ${button({ label: 'إغلاق', variant: 'secondary', attrs: 'data-close' })}
      ${
        row.dataUrl
          ? button({ label: 'تنزيل المستند', variant: 'primary', iconName: 'download', attrs: `data-download="${row.id}"` })
          : button({ label: 'تنزيل المستند', variant: 'primary', iconName: 'download', attrs: 'disabled aria-disabled="true"' })
      }`,
```
Since `[data-download]` is already delegated on `content` in Step 3 and the modal is appended to `#modal-root` (a sibling of `content`, not a descendant — confirmed in `ui/modal.js`, `ensureRoot()` appends to `document.body`), the delegated listener on `content` will **not** catch clicks inside the modal. Add a second, modal-scoped listener right after the `openModal(...)` call in `openPreview()`:
```js
function openPreview(row) {
  const modal = openModal({
    title: row.name,
    ...
  });
  if (row.dataUrl) {
    delegate(modal.element, 'click', '[data-download]', () => downloadDocument(row));
  }
}
```
(adjust so the existing `openModal({...})` call's return value is captured into `modal` and the function's closing brace wraps the new listener — the body/footer content itself is unchanged from Step 4's markup edit above.)

- [ ] **Step 5: Verify in the browser**

Open `http://localhost:3000/documents.html` as `admin@camps.ps`. Upload a small image (drag any local `.png`/`.jpg` under 400KB) via "رفع مستند" so it gets a real `dataUrl`. In the resulting row, confirm a "تنزيل" icon button is now enabled and clicking it downloads a file whose name matches the document's Arabic name plus the correct extension. Click "معاينة" on that same row and confirm "تنزيل المستند" is present and works from inside the modal too. For any seeded document (all metadata-only, no `dataUrl`), confirm both the row's download icon and the preview modal's download button render disabled rather than triggering anything.

- [ ] **Step 6: Commit**

```bash
git add assets/js/pages/documents.js
git commit -m "feat: add document download from the list row and the preview modal"
```

---

### Task 8: `checkboxGroupField` primitive and array-aware `readForm`

**Files:**
- Modify: `assets/js/ui/form.js`

**Interfaces:**
- Produces: `checkboxGroupField({ name, label, options, values, required?, hint?, full? })` — renders a labelled group of checkboxes sharing one `name`, each carrying its own `value` and `data-group="true"`.
- Produces: `readForm(form)` now returns an array (not a boolean) for any field made of grouped checkboxes; unchanged for every existing single checkbox/radio/text field.

- [ ] **Step 1: Add `checkboxGroupField`**

In `assets/js/ui/form.js`, add after `checkboxField()` (after line 162):
```js
/**
 * A labelled group of checkboxes sharing one `name`. `readForm` collects the
 * checked ones into an array under that name — used where a single field
 * must allow more than one selection (e.g. aid type, beneficiary families).
 */
export function checkboxGroupField({ name, label, options, values = [], required = false, hint = '', full = true }) {
  const selected = new Set(values);
  const items = options
    .map(
      (option, index) => `
      <label class="check" for="${esc(name)}-${index}">
        <input class="check__input" type="checkbox" id="${esc(name)}-${index}" name="${esc(name)}"
          value="${esc(option.value)}" data-group="true"${selected.has(option.value) ? ' checked' : ''}>
        <span class="check__body">
          <span class="check__title">${esc(option.label)}</span>
        </span>
      </label>`
    )
    .join('');

  const inner = `
    <span class="label">${esc(label)}${required ? '<span class="label__required">*</span>' : ''}</span>
    <div class="checkbox-group" role="group" aria-label="${esc(label)}">${items}</div>`;

  return wrap(name, inner, { full, hint });
}
```

- [ ] **Step 2: Make `readForm` array-aware for grouped checkboxes**

Replace `readForm()` (lines 243-254):
```js
export function readForm(form) {
  const values = {};
  qsa('input, select, textarea', form).forEach((node) => {
    if (!node.name) return;
    if (node.type === 'checkbox') values[node.name] = node.checked;
    else if (node.type === 'radio') {
      if (node.checked) values[node.name] = node.value;
      else if (!(node.name in values)) values[node.name] = '';
    } else values[node.name] = node.value;
  });
  return values;
}
```
with:
```js
export function readForm(form) {
  const values = {};
  qsa('input, select, textarea', form).forEach((node) => {
    if (!node.name) return;
    if (node.type === 'checkbox') {
      if (node.dataset.group === 'true') {
        if (!Array.isArray(values[node.name])) values[node.name] = [];
        if (node.checked) values[node.name].push(node.value);
      } else {
        values[node.name] = node.checked;
      }
    } else if (node.type === 'radio') {
      if (node.checked) values[node.name] = node.value;
      else if (!(node.name in values)) values[node.name] = '';
    } else values[node.name] = node.value;
  });
  return values;
}
```

- [ ] **Step 3: Verify with a scratch HTML page**

Create a temporary file to sanity-check the primitive in isolation before wiring it into the aid form:

Write `C:\Users\HP\AppData\Local\Temp\claude\c--Users-HP-Desktop-Camps-Management-Platform\5439f312-3203-4b70-9f27-d1dd7b5d9b0f\scratchpad\checkbox-group-check.html`:
```html
<!doctype html>
<html><body>
<script type="module">
  import { checkboxGroupField, readForm } from 'http://localhost:3000/assets/js/ui/form.js';
  document.body.insertAdjacentHTML('beforeend', `<form id="f">${checkboxGroupField({
    name: 'types', label: 'Types', options: [{value:'a',label:'A'},{value:'b',label:'B'},{value:'c',label:'C'}], values: ['b'],
  })}</form>`);
  const form = document.getElementById('f');
  const before = readForm(form);
  console.log('initial (b pre-checked):', JSON.stringify(before.types));
  form.querySelector('input[value="a"]').checked = true;
  form.querySelector('input[value="b"]').checked = false;
  const after = readForm(form);
  console.log('after toggling a on, b off:', JSON.stringify(after.types));
</script>
</body></html>
```
With the dev server running from the repo root, open `http://localhost:3000/../../../../../../AppData/Local/Temp/.../checkbox-group-check.html` — simpler: instead, copy the file into the repo's `pages/` directory temporarily as `pages/_scratch-checkbox-check.html`, open `http://localhost:3000/pages/_scratch-checkbox-check.html`, check the console for:
```
initial (b pre-checked): ["b"]
after toggling a on, b off: ["a"]
```
then delete `pages/_scratch-checkbox-check.html` (it must not be committed).

- [ ] **Step 4: Commit**

```bash
git add assets/js/ui/form.js
git commit -m "feat: add checkboxGroupField primitive and array-aware readForm"
```

---

### Task 9: Rewrite `aidFields()` / `aidSchema()` for multi-type and multi-family

**Files:**
- Modify: `assets/js/ui/record-forms.js`

**Interfaces:**
- Consumes: `checkboxGroupField` from Task 8.
- Produces: `aidFields(values, { organizations, families })` now renders a type checkbox group and a searchable family checklist with a "تحديد جميع الأسر" toggle, and no longer renders `quantity`/`description`. `aidSchema()` validates `types`/`familyIds` arrays instead of scalar `type`/`familyId`, and no longer validates `description`.
- Produces: `bindAidFamilyPicker(scope)` — wires the family search box and the "تحديد جميع الأسر" button; call once after inserting `aidFields()` into the DOM (same pattern as `bindMaternityFields`).

- [ ] **Step 1: Import `checkboxGroupField`**

In `assets/js/ui/record-forms.js`, add `checkboxGroupField` to the `./form.js` import (line 19-26):
```js
import {
  inputField,
  selectField,
  textareaField,
  fieldset,
  radioCards,
  checkboxField,
  checkboxGroupField,
} from './form.js';
```

- [ ] **Step 2: Rewrite `aidFields()`**

Replace the whole function (lines 536-594):
```js
export function aidFields(values = {}, options = {}) {
  const { organizations = [], families = [] } = options;
  const selectedFamilyIds = new Set(values.familyIds || []);

  return [
    fieldset({
      legend: 'الجهة المانحة وتاريخ التوزيع',
      fields: [
        selectField({
          name: 'organizationId',
          label: 'الجهة المانحة',
          options: organizations,
          value: values.organizationId,
          required: true,
          hint: 'مؤسسة أو مبادرة أو شخص.',
        }),
        inputField({
          name: 'date',
          label: 'تاريخ التوزيع',
          type: 'date',
          value: toInputDate(values.date),
          required: true,
        }),
      ],
    }),

    checkboxGroupField({
      name: 'types',
      label: 'نوع المساعدة',
      options: AID_TYPES.map((type) => ({ value: type.value, label: type.label })),
      values: values.types || [],
      required: true,
    }),

    `<div class="field field--full" data-field="familyIds">
      <span class="label">الأسر المستفيدة<span class="label__required" aria-hidden="true">*</span></span>
      <div class="aid-family-picker" data-aid-family-picker>
        ${inputField({ name: '__familySearch', label: 'بحث', value: '', placeholder: 'ابحث باسم رب الأسرة أو رقم الأسرة…' })}
        <button type="button" class="btn btn--secondary u-mt-2" data-select-all-families>تحديد جميع الأسر</button>
        <div class="checkbox-group u-mt-3" data-family-checklist role="group" aria-label="الأسر المستفيدة">
          ${families
            .map(
              (family, index) => `
            <label class="check" for="familyIds-${index}" data-family-option="${esc(family.value)}">
              <input class="check__input" type="checkbox" id="familyIds-${index}" name="familyIds"
                value="${esc(family.value)}" data-group="true"${selectedFamilyIds.has(family.value) ? ' checked' : ''}>
              <span class="check__body"><span class="check__title">${esc(family.label)}</span></span>
            </label>`
            )
            .join('')}
        </div>
      </div>
      <p class="field__hint" id="familyIds-hint"></p>
      <p class="field__msg field__msg--error" id="familyIds-error" role="alert"></p>
    </div>`,
  ].join('');
}

/**
 * Wire the family search filter and the "تحديد جميع الأسر" toggle inside a
 * rendered `aidFields()` block. Search only hides/shows checkbox rows —
 * unchecking a family after "select all" is a plain click on its own box.
 */
export function bindAidFamilyPicker(scope) {
  const picker = scope.querySelector('[data-aid-family-picker]');
  if (!picker) return;

  const search = picker.querySelector('input[name="__familySearch"]');
  const options = () => Array.from(picker.querySelectorAll('[data-family-option]'));
  const checkboxes = () => Array.from(picker.querySelectorAll('input[type="checkbox"]'));

  if (search) {
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      options().forEach((option) => {
        const label = option.textContent.toLowerCase();
        option.hidden = Boolean(term) && !label.includes(term);
      });
    });
  }

  const selectAll = picker.querySelector('[data-select-all-families]');
  if (selectAll) {
    selectAll.addEventListener('click', () => {
      checkboxes().forEach((box) => {
        box.checked = true;
      });
    });
  }
}
```

- [ ] **Step 3: Rewrite `aidSchema()`**

Replace (lines 830-838):
```js
export function aidSchema() {
  return {
    type: [rules.required('نوع المساعدة')],
    organizationId: [rules.required('الجهة المانحة')],
    familyId: [rules.required('الأسرة المستفيدة')],
    date: [rules.required('تاريخ التوزيع'), rules.pastDate('تاريخ التوزيع')],
    description: [rules.required('وصف المساعدة'), rules.minLength(5, 'وصف المساعدة')],
  };
}
```
with:
```js
export function aidSchema() {
  return {
    organizationId: [rules.required('الجهة المانحة')],
    date: [rules.required('تاريخ التوزيع'), rules.pastDate('تاريخ التوزيع')],
    types: [
      rules.custom(
        (value) => Array.isArray(value) && value.length > 0,
        'يرجى اختيار نوع مساعدة واحد على الأقل'
      ),
    ],
    familyIds: [
      rules.custom(
        (value) => Array.isArray(value) && value.length > 0,
        'يرجى اختيار أسرة واحدة على الأقل'
      ),
    ],
  };
}
```

- [ ] **Step 4: Verify field rendering in isolation**

Reuse the scratch-page technique from Task 8 Step 3: temporarily add `pages/_scratch-aid-check.html` importing `aidFields`/`aidSchema` from `../assets/js/ui/record-forms.js`, render `aidFields({}, { organizations: [{value:'org-1',label:'Test Org'}], families: [{value:'FAM-000001',label:'FAM-000001 — Test'}] })` into the page, and confirm in the browser that: no "الكمية" or "وصف المساعدة" field renders anywhere, a "نوع المساعدة" checkbox group renders with all `AID_TYPES` labels, and a "الأسر المستفيدة" section renders with a search box, a "تحديد جميع الأسر" button, and one checkbox per family. Delete the scratch file afterward (must not be committed).

- [ ] **Step 5: Commit**

```bash
git add assets/js/ui/record-forms.js
git commit -m "feat: rewrite aid form for multiple types and multiple beneficiary families"
```

---

### Task 10: Array-aware aid selectors and the aid Excel export

**Files:**
- Modify: `assets/js/core/selectors.js`
- Modify: `assets/js/core/exports.js`

**Interfaces:**
- Produces: `aidRow(record)` now includes `typeLabels` (string, "، "-joined) and `beneficiaryCount` (number) instead of `typeLabel`/`familyHeadName`; `searchAid()` filters over `types`/`familyIds` arrays; `aidForFamily(familyId)` matches via `familyIds.includes(...)`.
- Produces: `AID_COLUMNS`, `aidExportRow(record)` in `core/exports.js`.

- [ ] **Step 1: Rewrite `aidRow()`**

Replace (lines 518-528):
```js
export function aidRow(record) {
  const family = record.familyId ? store.families.get(record.familyId) : null;
  const head = family ? store.displaced.get(family.headId) : null;
  return {
    ...record,
    typeLabel: aidTypeLabel(record.type),
    organizationName: organizationName(record.organizationId),
    familyHeadName: head ? head.fullName : '—',
    campName: campName(record.campId),
  };
}
```
with:
```js
export function aidRow(record) {
  const types = record.types || [];
  const familyIds = record.familyIds || [];
  const beneficiaries = familyIds.map((familyId) => {
    const family = store.families.get(familyId);
    const head = family ? store.displaced.get(family.headId) : null;
    return { familyId, headName: head ? head.fullName : '—' };
  });
  return {
    ...record,
    typeLabels: types.map(aidTypeLabel).join('، '),
    organizationName: organizationName(record.organizationId),
    beneficiaryCount: familyIds.length,
    beneficiaries,
    campName: campName(record.campId),
  };
}
```

- [ ] **Step 2: Rewrite `searchAid()`**

Replace (lines 530-557):
```js
export function searchAid({
  query = '',
  type = '',
  organizationId = '',
  familyId = '',
  scope = () => true,
} = {}) {
  const term = query.trim().toLowerCase();
  return store.aid
    .list(scope)
    .filter((record) => {
      if (type && record.type !== type) return false;
      if (organizationId && record.organizationId !== organizationId) return false;
      if (familyId && record.familyId !== familyId) return false;
      if (!term) return true;
      const family = record.familyId ? store.families.get(record.familyId) : null;
      const head = family ? store.displaced.get(family.headId) : null;
      return (
        (record.familyId || '').toLowerCase().includes(term) ||
        (head ? head.fullName.toLowerCase().includes(term) : false) ||
        (record.description || '').toLowerCase().includes(term) ||
        organizationName(record.organizationId).toLowerCase().includes(term) ||
        aidTypeLabel(record.type).includes(term)
      );
    })
    .map(aidRow)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
```
with:
```js
export function searchAid({
  query = '',
  type = '',
  organizationId = '',
  familyId = '',
  scope = () => true,
} = {}) {
  const term = query.trim().toLowerCase();
  return store.aid
    .list(scope)
    .filter((record) => {
      if (type && !(record.types || []).includes(type)) return false;
      if (organizationId && record.organizationId !== organizationId) return false;
      if (familyId && !(record.familyIds || []).includes(familyId)) return false;
      if (!term) return true;
      const headNames = (record.familyIds || [])
        .map((id) => store.families.get(id))
        .filter(Boolean)
        .map((family) => store.displaced.get(family.headId))
        .filter(Boolean)
        .map((head) => head.fullName.toLowerCase());
      return (
        (record.familyIds || []).some((id) => id.toLowerCase().includes(term)) ||
        headNames.some((name) => name.includes(term)) ||
        organizationName(record.organizationId).toLowerCase().includes(term) ||
        (record.types || []).some((value) => aidTypeLabel(value).includes(term))
      );
    })
    .map(aidRow)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
```

- [ ] **Step 3: Update `aidForFamily()`**

Line 559-561 already delegates to `searchAid({ familyId })` — no code change needed here since `searchAid`'s `familyId` filter now checks array membership. Add a clarifying comment above it:
```js
/** Matches when this family is among the distribution's beneficiaries. */
export function aidForFamily(familyId) {
  return searchAid({ familyId });
}
```

- [ ] **Step 4: Update every other reader of `record.familyId` / `record.type` in `selectors.js`**

`familyWithStats()` line 139: replace
```js
    aidCount: store.aid.count((record) => record.familyId === familyId),
```
with:
```js
    aidCount: store.aid.count((record) => (record.familyIds || []).includes(familyId)),
```

`getFilteredFamilies()` line 242 (inside the `.map` building each family row): replace
```js
        aidCount: store.aid.count((record) => record.familyId === family.id),
```
with:
```js
        aidCount: store.aid.count((record) => (record.familyIds || []).includes(family.id)),
```

`displacedRow()` line 349-351: replace
```js
    aidCount: person.familyId
      ? store.aid.count((record) => record.familyId === person.familyId)
      : 0,
```
with:
```js
    aidCount: person.familyId
      ? store.aid.count((record) => (record.familyIds || []).includes(person.familyId))
      : 0,
```

`searchDisplaced()` lines 374-385 (the aid-type/donor filter building `aidFamilyIds`): replace
```js
  let aidFamilyIds = null;
  if (aidType || organizationId) {
    aidFamilyIds = new Set(
      store.aid
        .list(
          (record) =>
            (!aidType || record.type === aidType) &&
            (!organizationId || record.organizationId === organizationId)
        )
        .map((record) => record.familyId)
    );
  }
```
with:
```js
  let aidFamilyIds = null;
  if (aidType || organizationId) {
    aidFamilyIds = new Set(
      store.aid
        .list(
          (record) =>
            (!aidType || (record.types || []).includes(aidType)) &&
            (!organizationId || record.organizationId === organizationId)
        )
        .flatMap((record) => record.familyIds || [])
    );
  }
```

`organizationRow()` line 636-641: replace
```js
export function organizationRow(org) {
  const aidRows = store.aid.list((record) => record.organizationId === org.id);
  return {
    ...org,
    aidCount: aidRows.length,
    familiesCount: new Set(aidRows.map((record) => record.familyId)).size,
  };
}
```
with:
```js
export function organizationRow(org) {
  const aidRows = store.aid.list((record) => record.organizationId === org.id);
  return {
    ...org,
    aidCount: aidRows.length,
    familiesCount: new Set(aidRows.flatMap((record) => record.familyIds || [])).size,
  };
}
```

`removeFamily()` line 971: replace
```js
  store.aid.removeWhere((record) => record.familyId === familyId);
```
with:
```js
  store.aid.removeWhere((record) => (record.familyIds || []).includes(familyId));
```
This changes cascade semantics slightly: a distribution that named this family *and others* is now removed entirely rather than just detached from this one family. Add a comment above the line explaining this is accepted because a distribution's beneficiary list is a fixed snapshot, not editable per-family after creation:
```js
  // A distribution's beneficiary list is fixed at creation time; removing one
  // of several beneficiary families removes the whole shared record rather
  // than trying to edit a snapshot after the fact.
  store.aid.removeWhere((record) => (record.familyIds || []).includes(familyId));
```

`aidByType()` line 1085: replace
```js
    count: rows.filter((row) => row.type === type.value).length,
```
with:
```js
    count: rows.filter((row) => (row.types || []).includes(type.value)).length,
```

`aidByOrganization()` — no change needed (already keys off `organizationId`, unaffected).

`topFamiliesByAid()` lines 1200-1220: replace
```js
  const counts = new Map();
  rows.forEach((record) => {
    counts.set(record.familyId, (counts.get(record.familyId) || 0) + 1);
  });
```
with:
```js
  const counts = new Map();
  rows.forEach((record) => {
    (record.familyIds || []).forEach((familyId) => {
      counts.set(familyId, (counts.get(familyId) || 0) + 1);
    });
  });
```

- [ ] **Step 5: Add `AID_COLUMNS` / `aidExportRow` to `core/exports.js`**

In `assets/js/core/exports.js`, add at the end of the file:
```js
/* ---- Aid ------------------------------------------------------------------ */

export const AID_COLUMNS = [
  { key: 'typeLabels', label: 'نوع المساعدة', width: 30 },
  { key: 'organizationName', label: 'الجهة المانحة', width: 24 },
  { key: 'beneficiaryCount', label: 'عدد الأسر المستفيدة', width: 18 },
  { key: 'campName', label: 'المخيم', width: 18 },
  { key: 'date', label: 'تاريخ التوزيع', width: 14 },
];

/** One spreadsheet row from one aid distribution — `aidRow()`'s shape already matches. */
export function aidExportRow(record) {
  return {
    typeLabels: record.typeLabels,
    organizationName: record.organizationName,
    beneficiaryCount: record.beneficiaryCount,
    campName: record.campName,
    date: record.date,
  };
}
```

- [ ] **Step 6: Verify with the browser console**

Open `http://localhost:3000/dashboard.html`, sign in as `admin@camps.ps`. Console:
```js
const s = await import('./assets/js/core/selectors.js');
s.searchAid({}).length
```
Expected: the seeded aid count (unaffected by this task alone — Task 12 converts the seed data; until then `record.types`/`record.familyIds` are `undefined` on every seeded row, so `(record.types||[]).includes(...)` degrades to `false` and `aidRow()` renders empty `typeLabels`/`beneficiaryCount:0` for now — that's expected and gets fixed by Task 12). Confirm no exception is thrown.

- [ ] **Step 7: Commit**

```bash
git add assets/js/core/selectors.js assets/js/core/exports.js
git commit -m "feat: make aid selectors array-aware for multi-type/multi-family records, add aid export columns"
```

---

### Task 11: Wire the new aid form into create and edit pages

**Files:**
- Modify: `assets/js/pages/aid-create.js`
- Modify: `assets/js/pages/aid-edit.js`

**Interfaces:**
- Consumes: `aidFields`, `aidSchema`, `bindAidFamilyPicker` from Tasks 9-10; `readForm`'s array support from Task 8.

- [ ] **Step 1: `aid-create.js` — import `bindAidFamilyPicker`, drop the `type` query preset, submit the new shape**

Replace the import line:
```js
import { aidFields, aidSchema } from '../ui/record-forms.js';
```
with:
```js
import { aidFields, aidSchema, bindAidFamilyPicker } from '../ui/record-forms.js';
```

In `init()`, replace:
```js
    ${aidFields(
        {
          familyId,
          date: toInputDate(new Date()),
          type: query.type || 'food',
        },
        { organizations, families }
      )}
```
with:
```js
    ${aidFields(
        {
          familyIds: familyId ? [familyId] : [],
          date: toInputDate(new Date()),
        },
        { organizations, families }
      )}
```

Right after `const form = qs('#aid-form', content);`, add:
```js
  bindAidFamilyPicker(form);
```

Replace the `onSubmit` body:
```js
    onSubmit: (values) => {
      const family = store.families.get(values.familyId);
      const record = store.aid.create({
        type: values.type,
        organizationId: values.organizationId,
        familyId: values.familyId,
        campId: family ? family.campId : session.campId,
        date: values.date,
        quantity: (values.quantity || '').trim(),
        description: values.description.trim(),
        createdBy: session.id,
        createdAt: new Date().toISOString(),
      });

      notifyFamily(record);
      toast.success('تم الحفظ', 'تم تسجيل المساعدة في سجل الأسرة.');
      go('aid-details.html', { id: record.id });
    },
```
with:
```js
    onSubmit: (values) => {
      const familyIds = Array.isArray(values.familyIds) ? values.familyIds : [];
      const eligibleFamilyIds = new Set(families.map((f) => f.value));
      const allFamiliesSelected =
        eligibleFamilyIds.size > 0 && familyIds.length === eligibleFamilyIds.size;
      const record = store.aid.create({
        organizationId: values.organizationId,
        types: values.types,
        familyIds,
        allFamiliesSelected,
        campId: session.campId,
        date: values.date,
        createdBy: session.id,
        createdAt: new Date().toISOString(),
      });

      notifyFamilies(record);
      toast.success('تم الحفظ', 'تم تسجيل المساعدة في سجل الأسر المستفيدة.');
      go('aid-details.html', { id: record.id });
    },
```

Replace `notifyFamily(record)`:
```js
function notifyFamily(record) {
  const memberIds = new Set(select.familyMembers(record.familyId).map((member) => member.id));
  store.users
    .list((row) => row.displacedId && memberIds.has(row.displacedId))
    .forEach((user) => {
      store.notifications.create({
        userId: user.id,
        type: 'info',
        title: 'تمت إضافة مساعدة جديدة لأسرتك',
        text: `${select.aidTypeLabel(record.type)} من ${select.organizationName(record.organizationId)}.`,
        createdAt: new Date().toISOString(),
        read: false,
        href: 'aid.html',
      });
    });
}
```
with:
```js
/** Every family named as a beneficiary is notified, not one nominated recipient. */
function notifyFamilies(record) {
  const memberIds = new Set(
    record.familyIds.flatMap((familyId) => select.familyMembers(familyId).map((member) => member.id))
  );
  const typeLabels = record.types.map(select.aidTypeLabel).join('، ');
  store.users
    .list((row) => row.displacedId && memberIds.has(row.displacedId))
    .forEach((user) => {
      store.notifications.create({
        userId: user.id,
        type: 'info',
        title: 'تمت إضافة مساعدة جديدة لأسرتك',
        text: `${typeLabels} من ${select.organizationName(record.organizationId)}.`,
        createdAt: new Date().toISOString(),
        read: false,
        href: 'aid.html',
      });
    });
}
```

Also update the `familyId` preset near the top of `init()` — it stays as-is (`const familyId = query.familyId && ...`), it now only seeds the initial `familyIds` array via the `aidFields` call above.

- [ ] **Step 2: `aid-edit.js` — same shape change**

Replace the import:
```js
import { aidFields, aidSchema, formSummary } from '../ui/record-forms.js';
```
with:
```js
import { aidFields, aidSchema, formSummary, bindAidFamilyPicker } from '../ui/record-forms.js';
```

In `render()`, replace:
```js
  const row = select.aidRow(record);
```
keep as-is, then replace:
```js
    ${formSummary([row.typeLabel, row.organizationName, row.familyId, row.familyHeadName])}
```
with:
```js
    ${formSummary([row.typeLabels, row.organizationName, `${row.beneficiaryCount} أسرة مستفيدة`])}
```

`aidFields(record, { organizations, families })` stays as-is (the function now reads `record.types`/`record.familyIds`, which already exist on the record since `record` is the raw store object — the seed data conversion in Task 12 ensures every stored record has these array fields).

Right after `const form = qs('#aid-form', content);`, add:
```js
  bindAidFamilyPicker(form);
```

Replace the `onSubmit` body:
```js
    onSubmit: (values) => {
      const family = store.families.get(values.familyId);
      store.aid.update(record.id, {
        type: values.type,
        organizationId: values.organizationId,
        familyId: values.familyId,
        campId: family ? family.campId : campId,
        date: values.date,
        quantity: (values.quantity || '').trim(),
        description: values.description.trim(),
      });
      toast.success('تم الحفظ', 'تم تحديث سجل المساعدة.');
      go('aid-details.html', { id: record.id });
    },
```
with:
```js
    onSubmit: (values) => {
      const familyIds = Array.isArray(values.familyIds) ? values.familyIds : [];
      const eligibleFamilyIds = new Set(families.map((f) => f.value));
      const allFamiliesSelected =
        eligibleFamilyIds.size > 0 && familyIds.length === eligibleFamilyIds.size;
      store.aid.update(record.id, {
        organizationId: values.organizationId,
        types: values.types,
        familyIds,
        allFamiliesSelected,
        campId,
        date: values.date,
      });
      toast.success('تم الحفظ', 'تم تحديث سجل المساعدة.');
      go('aid-details.html', { id: record.id });
    },
```

- [ ] **Step 3: Verify in the browser**

Open `http://localhost:3000/aid-create.html` as `admin@camps.ps`. Confirm: no "الكمية" or "وصف المساعدة" fields. Check two aid types and three families (search the family box for part of a head's name first, confirm the list filters, then clear the search). Submit with a valid donor and date — expect redirect to `aid-details.html` with no console errors. Reopen the same record via `aid-edit.html?id=<id>` and confirm the three families and two types are pre-checked. Try submitting with zero types selected — expect the exact error "يرجى اختيار نوع مساعدة واحد على الأقل" under the field, and zero families selected — expect "يرجى اختيار أسرة واحدة على الأقل". Click "تحديد جميع الأسر" and confirm every family checkbox becomes checked; manually uncheck one and confirm the rest remain checked (deselecting one family after select-all works).

- [ ] **Step 4: Commit**

```bash
git add assets/js/pages/aid-create.js assets/js/pages/aid-edit.js
git commit -m "feat: wire multi-type/multi-family aid form into create and edit pages"
```

---

### Task 12: Update the aid list and detail pages, add the aid export button

**Files:**
- Modify: `assets/js/pages/aid.js`
- Modify: `assets/js/pages/aid-details.js`

**Interfaces:**
- Consumes: `AID_COLUMNS`/`aidExportRow` from Task 10; `select.aidRow()`'s new `typeLabels`/`beneficiaryCount`/`beneficiaries` shape.

- [ ] **Step 1: `aid.js` — imports and the export action**

Add imports:
```js
import { AID_COLUMNS, aidExportRow } from '../core/exports.js';
import { exportSheet, timestampedName } from '../utils/xlsx.js';
```

In `init()`, add an export button to the page header actions (mirroring `displaced.js`'s pattern read earlier). Replace:
```js
      actions: can('aid:create')
        ? button({
            label: 'تسجيل مساعدة',
            variant: 'primary',
            iconName: 'plus',
            href: pageUrl('aid-create.html'),
          })
        : '',
```
with:
```js
      actions: `
        ${
          !isOwn
            ? button({ label: 'تصدير إلى Excel', variant: 'secondary', iconName: 'download', attrs: 'data-export' })
            : ''
        }
        ${
          can('aid:create')
            ? button({
                label: 'تسجيل مساعدة',
                variant: 'primary',
                iconName: 'plus',
                href: pageUrl('aid-create.html'),
              })
            : ''
        }`,
```
`isOwn` (`session.role === ROLES.DISPLACED`) is already computed earlier in `init()` and is the same guard `resultsView()` uses to pick between the admin table and the read-only card list — it is the correct gate here too: neither `displaced.js` nor `families.js` wraps their own export buttons in a `can()` check (confirmed by reading `displaced.js`), because `PAGE_ACCESS` already keeps their pages Camp-Admin/Super-Admin-only. `aid.html` is different — it is also open to the Displaced role — so `!isOwn` is what keeps the export administrative per domain rule #17, without inventing a `can('aid:export')` permission key that does not exist in `core/auth.js`'s `PERMISSIONS` table.

Add the delegated click handler and the export function, following the exact pattern in `displaced.js` (`exportRows`):
```js
  delegate(content, 'click', '[data-export]', (event, node) => exportRows(session, node));
```
(place alongside the existing `delegate(content, 'click', '[data-page]', ...)` block)

```js
async function exportRows(session, trigger) {
  const original = trigger.innerHTML;
  trigger.disabled = true;
  trigger.innerHTML = `<span class="btn__spinner"></span><span>جارٍ تجهيز ملف Excel…</span>`;

  try {
    const rows = await store.load(() => collect(session), 120);

    if (!rows.length) {
      toast.error('لا توجد نتائج لتصديرها', 'عدّل الفلاتر ثم حاول مرة أخرى.');
      return;
    }

    const filtered = Boolean(state.q) || activeFilterCount() > 0;
    const count = exportSheet({
      columns: AID_COLUMNS,
      rows: rows.map(aidExportRow),
      filename: timestampedName('المساعدات', { filtered }),
      sheetName: 'المساعدات',
    });

    toast.success('تم التصدير', `تم تصدير ${count} سجلًا بنجاح.`);
  } catch (error) {
    console.error(error);
    toast.error('تعذر التصدير', 'حدث خطأ أثناء تجهيز الملف، حاول مرة أخرى.');
  } finally {
    trigger.disabled = false;
    trigger.innerHTML = original;
  }
}
```

- [ ] **Step 2: `aid.js` — table columns and the own-history card view**

Replace the admin table columns (lines 218-251):
```js
  const columns = [
    {
      key: 'typeLabel',
      label: 'نوع المساعدة',
      primary: true,
      cell: (row) => cellMain(row.typeLabel, row.description),
    },
    { key: 'organizationName', label: 'الجهة المانحة' },
    { key: 'familyId', label: 'الأسرة المستفيدة', cell: (row) => cellMono(row.familyId) },
    { key: 'familyHeadName', label: 'رب الأسرة' },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    { key: 'quantity', label: 'الكمية', cell: (row) => esc(row.quantity || '—') },
    { key: 'date', label: 'تاريخ التوزيع', cell: (row) => formatDate(row.date) },
```
with:
```js
  const columns = [
    {
      key: 'typeLabels',
      label: 'نوع المساعدة',
      primary: true,
      cell: (row) => cellMain(row.typeLabels || '—'),
    },
    { key: 'organizationName', label: 'الجهة المانحة' },
    {
      key: 'beneficiaryCount',
      label: 'عدد الأسر المستفيدة',
      cell: (row) => cellMono(String(row.beneficiaryCount)),
    },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    { key: 'date', label: 'تاريخ التوزيع', cell: (row) => formatDate(row.date) },
```

Replace the own-history card body (lines 268-292):
```js
function ownHistoryView(rows, slice, page) {
  const cards = slice
    .map(
      (record) => `
      <li class="card">
        <div class="card__body">
          <div class="row row--between u-gap-3">
            <span class="u-medium">${esc(record.typeLabel)}</span>
            <span class="u-sm u-secondary">${esc(formatDate(record.date))}</span>
          </div>
          <p class="u-sm u-secondary u-mt-2" style="line-height:1.8">${esc(record.description || '—')}</p>
          <div class="row u-gap-2 u-wrap u-mt-3">
            <span class="chip chip--outline">${esc(record.organizationName)}</span>
            ${record.quantity ? `<span class="chip chip--outline">${esc(record.quantity)}</span>` : ''}
          </div>
        </div>
      </li>`
    )
    .join('');
```
with:
```js
function ownHistoryView(rows, slice, page) {
  const cards = slice
    .map(
      (record) => `
      <li class="card">
        <div class="card__body">
          <div class="row row--between u-gap-3">
            <span class="u-medium">${esc(record.typeLabels || '—')}</span>
            <span class="u-sm u-secondary">${esc(formatDate(record.date))}</span>
          </div>
          <div class="row u-gap-2 u-wrap u-mt-3">
            <span class="chip chip--outline">${esc(record.organizationName)}</span>
            <span class="chip chip--outline">${record.beneficiaryCount} أسرة مستفيدة</span>
          </div>
        </div>
      </li>`
    )
    .join('');
```

- [ ] **Step 3: `aid-details.js` — display rework**

Replace `collect()`'s `siblings` computation (lines 71-74) — it currently reads `raw.familyId`, which no longer exists. Siblings are other distributions sharing at least one beneficiary family with this one, deduplicated, excluding itself:
```js
    siblings: dedupeById(
      (raw.familyIds || []).flatMap((familyId) => select.searchAid({ familyId }))
    )
      .filter((row) => row.id !== raw.id)
      .slice(0, 5),
```
Add a small local helper above `collect()`:
```js
function dedupeById(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
```

Replace `view()`'s `typeIcon` line and header (lines 78-88):
```js
function view(session, { record, family, donor, createdByName, siblings }) {
  const typeIcon = (AID_TYPES.find((type) => type.value === record.type) || {}).icon || 'aid';

  return `
    ${breadcrumb([
      { label: 'المساعدات', href: pageUrl('aid.html') },
      { label: record.typeLabel },
    ])}
    ${pageHeader({
      title: `${record.typeLabel} — ${record.organizationName}`,
      description: `تم التوزيع في ${formatDate(record.date)}`,
```
with:
```js
function view(session, { record, family, donor, createdByName, siblings }) {
  const typeIcon = (AID_TYPES.find((type) => type.value === (record.types || [])[0]) || {}).icon || 'aid';

  return `
    ${breadcrumb([
      { label: 'المساعدات', href: pageUrl('aid.html') },
      { label: record.typeLabels || 'مساعدة' },
    ])}
    ${pageHeader({
      title: `${record.typeLabels} — ${record.organizationName}`,
      description: `تم التوزيع في ${formatDate(record.date)} · ${record.beneficiaryCount} أسرة مستفيدة`,
```

Replace the "المساعدة الموزَّعة" card body (lines 111-122):
```js
          body: `
            <p class="u-secondary u-mb-4" style="line-height:1.8">${esc(record.description || '—')}</p>
            ${definitionList([
              definition('نوع المساعدة', labelOf(AID_TYPES, record.type)),
              definition('الجهة المانحة', record.organizationName),
              definition('الأسرة المستفيدة', record.familyId, { mono: true }),
              definition('تاريخ التوزيع', formatDate(record.date)),
              definition('الكمية', record.quantity),
              definition('المخيم', record.campName),
              definition('سُجّلت بواسطة', createdByName),
              definition('تاريخ التسجيل', record.createdAt ? formatDateTime(record.createdAt) : '—'),
            ])}`,
```
with:
```js
          body: `
            ${definitionList([
              definition('نوع المساعدة', record.typeLabels || '—'),
              definition('الجهة المانحة', record.organizationName),
              definition('عدد الأسر المستفيدة', String(record.beneficiaryCount)),
              definition('تاريخ التوزيع', formatDate(record.date)),
              definition('المخيم', record.campName),
              definition('سُجّلت بواسطة', createdByName),
              definition('تاريخ التسجيل', record.createdAt ? formatDateTime(record.createdAt) : '—'),
            ])}`,
```

Replace the "الأسرة المستفيدة" aside card (lines 169-186) with a searchable beneficiary list card:
```js
        ${card({
          title: 'الأسرة المستفيدة',
          body: definitionList([
            definition('رقم الأسرة', record.familyId, { mono: true }),
            definition('رب الأسرة', family ? family.headName : '—'),
            definition('عدد أفراد الأسرة', family ? String(family.membersCount) : '—'),
            definition('المخيم', record.campName),
          ]),
          foot: family
            ? button({
                label: 'ملف الأسرة',
                variant: 'secondary',
                iconName: 'family',
                href: pageUrl('family-details.html', { id: family.id }),
                block: true,
              })
            : '',
        })}
```
with:
```js
        ${card({
          title: `الأسر المستفيدة (${record.beneficiaryCount})`,
          flush: true,
          body: `
            <div class="u-p-4">
              ${inputField({
                name: 'beneficiary-search',
                label: 'بحث',
                value: '',
                placeholder: 'ابحث برقم الأسرة أو رب الأسرة…',
              })}
            </div>
            <div class="list" id="beneficiary-list">
              ${(record.beneficiaries || [])
                .map(
                  (row) => `
                <a class="list__row" data-beneficiary-row
                   href="${pageUrl('family-details.html', { id: row.familyId })}">
                  <span class="list__main">
                    <span class="list__title">${esc(row.familyId)}</span>
                    <span class="list__meta">${esc(row.headName)}</span>
                  </span>
                  <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
                </a>`
                )
                .join('')}
            </div>`,
        })}
```
This card needs `inputField` imported — add `inputField` to the `../ui/form.js` import at the top of the file:
```js
import { inputField } from '../ui/form.js';
```

- [ ] **Step 4: Wire the beneficiary search filter**

In `wire(content, { record })`, add:
```js
  const beneficiarySearch = content.querySelector('#beneficiary-search');
  if (beneficiarySearch) {
    beneficiarySearch.addEventListener('input', () => {
      const term = beneficiarySearch.value.trim().toLowerCase();
      content.querySelectorAll('[data-beneficiary-row]').forEach((row) => {
        row.hidden = Boolean(term) && !row.textContent.toLowerCase().includes(term);
      });
    });
  }
```

- [ ] **Step 5: Verify in the browser**

Open `http://localhost:3000/aid.html` as `admin@camps.ps`. Confirm the table shows joined type labels and a beneficiary count column, no "الكمية" column. Click "تصدير إلى Excel", confirm a `.xlsx` file downloads and a success toast appears; open the file (any spreadsheet app) and confirm columns match `AID_COLUMNS` with no monetary column. Open one record's detail page: confirm no "الوصف"/"الكمية" fields, the beneficiary list renders every family with a working search box and each row links to that family's detail page. Sign in as `ahmad@camps.ps` and open `aid.html`: confirm the read-only card list still shows only their own family's distributions, with type labels and beneficiary count, no export button.

- [ ] **Step 6: Commit**

```bash
git add assets/js/pages/aid.js assets/js/pages/aid-details.js
git commit -m "feat: rework aid list and detail views for multi-type/multi-family records, add Excel export"
```

---

### Task 13: Convert seeded aid records and finish integrity checks

**Files:**
- Modify: `assets/js/data/mock-data.js`
- Modify: `assets/js/core/store.js`

**Interfaces:**
- Produces: every seeded aid record uses `{ types: string[], familyIds: string[] }` instead of `{ type, familyId, quantity, description }`; `SEED_VERSION` bumps again (it already moved to `5` in Task 5 — this task bumps it to `6`, since the aid shape change is a second, independent reason to force a reseed and Task 5 may already have shipped and been used before this task lands).

- [ ] **Step 1: Convert the 14 seeded aid records**

In `assets/js/data/mock-data.js`, the `export const aid = [...]` array (lines 913-1079) has 14 records, each shaped:
```js
  {
    id: 'aid-1',
    type: 'food',
    organizationId: 'org-5',
    familyId: 'FAM-000001',
    campId: 'camp-1',
    date: '2026-07-28',
    quantity: '1 طرد',
    description: 'طرد غذائي شهري مقدم من برنامج الغذاء العالمي يكفي أسرة من أربعة أفراد.',
    createdBy: 'u-admin-1',
  },
```
Convert every record to:
```js
  {
    id: 'aid-1',
    types: ['food'],
    organizationId: 'org-5',
    familyIds: ['FAM-000001'],
    allFamiliesSelected: false,
    campId: 'camp-1',
    date: '2026-07-28',
    createdBy: 'u-admin-1',
  },
```
i.e. for each of the 14 records: `type: 'X'` → `types: ['X']`, `familyId: 'FAM-...'` → `familyIds: ['FAM-...']`, add `allFamiliesSelected: false`, delete the `quantity` and `description` lines. Apply this to all 14 records (`aid-1` through `aid-15`, noting the array skips `aid-15` appears between `aid-5` and `aid-6` in file order — every `id: 'aid-N'` block in the array gets the same transformation).

- [ ] **Step 2: Confirm no old-shape fields remain**

```bash
grep -n "^\s*type: '\|^\s*familyId: '\|^\s*quantity:\|^\s*description:" assets/js/data/mock-data.js
```
Expected: no matches inside the `aid` array (this pattern may still legitimately match unrelated fields elsewhere in the file — inspect any hits manually to confirm they are not aid records; if this grep is too broad, run `grep -n -A1 "id: 'aid-" assets/js/data/mock-data.js` instead and visually confirm every block now reads `types:`/`familyIds:` with no `quantity`/`description`).

- [ ] **Step 3: Bump `SEED_VERSION` again**

```js
export const SEED_VERSION = 6;
```

- [ ] **Step 4: Add aid integrity checks to `store.validateData()`**

In `assets/js/core/store.js`, replace the `aid.list().forEach(...)` block (lines 262-274):
```js
  aid.list().forEach((record) => {
    if (!record.organizationId || !orgIds.has(record.organizationId)) {
      problems.push(`المساعدة ${record.id} تشير إلى جهة مانحة غير موجودة`);
    }
    if (!record.familyId || !familyIds.has(record.familyId)) {
      problems.push(`المساعدة ${record.id} تشير إلى أسرة غير موجودة`);
    }
    // Aid records the assistance itself, never its price or an individual
    // recipient — a leftover field means stale data.
    if ('value' in record || 'displacedId' in record) {
      problems.push(`المساعدة ${record.id} تحتوي على حقول ملغاة (القيمة أو المستلم)`);
    }
  });
```
with:
```js
  aid.list().forEach((record) => {
    if (!record.organizationId || !orgIds.has(record.organizationId)) {
      problems.push(`المساعدة ${record.id} تشير إلى جهة مانحة غير موجودة`);
    }
    if (!Array.isArray(record.familyIds) || !record.familyIds.length) {
      problems.push(`المساعدة ${record.id} لا تحتوي على أسر مستفيدة`);
    } else {
      record.familyIds.forEach((id) => {
        if (!familyIds.has(id)) {
          problems.push(`المساعدة ${record.id} تشير إلى أسرة غير موجودة (${id})`);
        }
      });
    }
    if (!Array.isArray(record.types) || !record.types.length) {
      problems.push(`المساعدة ${record.id} لا تحتوي على نوع مساعدة`);
    }
    // Aid records the assistance itself, never its price, an individual
    // recipient, or a free-text quantity/description — a leftover field
    // means stale data from before the multi-type/multi-family rework.
    if (
      'value' in record ||
      'displacedId' in record ||
      'type' in record ||
      'familyId' in record ||
      'quantity' in record ||
      'description' in record
    ) {
      problems.push(`المساعدة ${record.id} تحتوي على حقول ملغاة (القيمة أو المستلم أو الشكل القديم)`);
    }
  });
```

- [ ] **Step 5: Verify in the browser**

Hard-refresh `http://localhost:3000/dashboard.html` (the `SEED_VERSION` bump reseeds — expected). Console: `store.validateData()` → `[]`. Open `aid.html`, confirm the table now shows real Arabic type labels (e.g. "غذائية") and non-zero beneficiary counts for every seeded row (no longer blank, since Task 10's array-aware selectors now have real array data to read). Open one aid detail page and confirm the beneficiary list shows the correct family/head. Confirm the dashboard's aid-related statistics still render without error.

- [ ] **Step 6: Full regression pass**

Walk through the complete "Final Testing" scenarios from the spec:
- Create a family via `family-create.html` with father status "متوفى" → confirm the resulting person shows "يتيم: نعم" on their detail page and the family's "عدد الأيتام" export column reflects it.
- Create a family with both parents alive → confirm "يتيم: لا".
- Confirm no "مكان الإقامة الحالي" or manual "يتيم" toggle appears anywhere in the family or person forms.
- Open every page listed in Task 6 and confirm the filter button opens a modal, never an inline panel; test apply/reset/cancel/Escape/outside-click/active-filter-count on at least `displaced.html` and `aid.html`.
- On `documents.html`, upload a small image, download it from both the row action and the preview modal, confirm the filename and extension are correct; confirm a metadata-only seeded document shows a disabled download control.
- On `aid-create.html`, register one distribution with 2 types and 3 families, then open each of those 3 families' `family-details.html` (or sign in as a member of one via `ahmad@camps.ps` if applicable) and confirm the distribution appears in that family's aid history with the correct joined type labels — and does not leak to an unrelated family's history.
- Click "تحديد جميع الأسر" during creation and confirm every eligible family is selected; confirm the created record's "عدد الأسر المستفيدة" matches the total family count for that camp.
- Run `store.validateData()` one final time from `dashboard.html` → `[]`.

- [ ] **Step 7: Commit**

```bash
git add assets/js/data/mock-data.js assets/js/core/store.js
git commit -m "feat: convert seeded aid records to multi-type/multi-family shape, extend integrity checks"
```
