# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **frontend-only UI prototype** for a displaced-persons camp management platform. Arabic RTL, mobile-first, HTML5 + CSS3 + vanilla ES6 modules. No build step, no package.json, no dependencies to install.

Hard constraints for this phase (from the project brief):

- No backend, no API, no database, no real authentication.
- No Supabase, no Cloudinary, no server code.
- No framework — no Next.js, React, Vue, or Angular. CDN libraries are allowed for UI/visualisation only (currently just Chart.js).

The prototype exists to get the UI approved. It will then be rewritten in Next.js 16 / React 19 / Supabase, which is why the layering below is enforced strictly.

## Running

ES modules require a server; opening `index.html` via `file://` will not work.

```bash
npx serve .              # or: python -m http.server 3000, or VS Code Live Server
```

Demo accounts (password `123456` for all): `admin@camps.ps` (camp admin), `super@camps.ps` (super admin), `ahmad@camps.ps` (displaced). They appear as one-click buttons on the login screen, and the user menu has a role switcher.

`pages/design-system.html` renders every component in one page — use it to review visual changes.

## Verifying changes

There is no test runner in the repo. Two checks are worth running:

1. **In the browser console** — `store.validateData()` returns referential-integrity problems in the mock data (orphan family IDs, family heads in the wrong camp, aid pointing at missing organisations). It returns `[]` when clean.
2. **Headless render smoke test** — page modules are pure enough to run under jsdom. The harness is not in the repo (it lives in a scratch dir with `jsdom` installed); recreate it if needed. It loads each page's HTML, stubs `localStorage`, `CSS.escape` (jsdom has no implementation, and `form.js` calls it) and a writable `window.location` (jsdom's is non-configurable — hand the modules a `Proxy` that intercepts `location`), imports the page module, and asserts the page rendered without throwing. This catches the majority of regressions since almost every bug here is a render-time error.

3. **Real-browser pass for anything touching routing, links or permissions.** jsdom navigates to `*.html` directly, so it cannot see server-side URL rewriting, lost query strings, or a guard that passes because `currentPage()` returned the wrong key. Drive an actual server with Playwright instead: sign in by writing `dcmp:session` to `localStorage`, then load every page in **both** URL styles (`displaced.html` and `displaced`) for every role, and click through from each list to its detail page asserting the record renders rather than the not-found empty state.

Manual pass for any UI change: no console errors, DevTools device toolbar at 320/375/414/768/1024/1440 with no horizontal page scroll, tables collapsing to cards below 768px, and a keyboard-only run (focus ring visible, `Esc` closes modals/drawers).

## Architecture

The layering is the point of this codebase — it is what makes the Next.js port cheap. Do not shortcut it.

```
data/mock-data.js  →  core/store.js  →  core/selectors.js  →  js/pages/*  →  ui/*
   raw seed only       localStorage      domain logic          glue          markup
```

- **`data/mock-data.js`** — seed data, zero DOM, zero logic.
- **`core/storage.js`** — the only module that calls `localStorage` directly.
- **`core/store.js`** — a repository per collection (`camps`, `displaced`, `families`, `aid`, …), each with `list / get / find / count / exists / create / update / remove`. Deliberately shaped like Supabase calls so the port replaces method bodies and nothing above changes. **Pages must never read `localStorage`.**
- **`core/selectors.js`** — all domain logic: search, filtering, statistics, `nextFamilyId()`, `scopeFilter(session)`. If you are about to write a `.filter()` over a collection inside a page module, it probably belongs here.

  **`getFilteredDisplaced(session, filters)` and `getFilteredFamilies(session, filters)` are the single query behind the list table, its result count and the Excel export.** Never filter again downstream — that is what guarantees the number on screen is the number of rows in the file. Both take the session *first* and derive scope from it internally: a Camp Admin's `campId` comes from the session, so a hand-edited `?campId=` cannot widen an export, and a displaced session gets `[]`. `personFacts()` / `familyFacts()` define what "طفل", "يتيم" and "مرضعة" mean once, so the dashboard statistic and the filter can never disagree.
- **`core/exports.js`** — the Excel column sets and row builders, next to the query they read.
- **`core/auth.js`** — prototype session (a user id in localStorage) plus the real thing: the `PERMISSIONS` table and `can(action)`. Every mutating control is gated on `can()`, every camp-scoped record on `inScope()`.
- **`core/router.js`** — `guard()` runs before any in-app page renders and redirects: no session → login, `pending`/`rejected` status → its status screen, role not in `PAGE_ACCESS` → 404. Never hand-write a page URL; use `pageUrl(page, params)`, which resolves correctly from both `/` and `/pages/`, merges any query already on `page`, and matches the URL style the document was served in (see below).

  **Clean URLs.** `npx serve` — and Vercel, Netlify and GitHub Pages — rewrite `foo.html` to `foo`, and **that redirect drops the query string**. Two rules follow, both already enforced in `router.js`; do not undo them:
  - `currentPage()` re-adds the `.html` suffix when the host stripped it. `PAGE_ACCESS` and `NAVIGATION` are keyed by `*.html`, and a miss there makes `PAGE_ACCESS[page]` `undefined`, which lets **every role through the guard** rather than blocking it.
  - `pageUrl()` emits extensionless links when the current document is itself extensionless, so no navigation ever triggers the rewrite and `?id=` survives.

  Verify route changes in a browser against a real server, not only under jsdom: a jsdom harness visits `*.html` paths directly and cannot see either failure.
- **`ui/*`** — presentation only. Component functions return **HTML strings** and know nothing about what the data means.
- **`js/pages/*`** — thin glue: read query params → call store/selectors → call ui components → wire events. One module per page.

The `ui/` layer beyond the primitives in `components.js`:

- **`ui/table.js`** — `dataTable({ columns, rows })` plus `cellMain / cellMono / rowActions / resultBar`. One markup shape covers both presentations in `tables.css`: a real `<table>` from 768px, cards below it (every cell carries a `data-label`).
- **`ui/toolbar.js`** — the search + filter panel every list page opens with, `filterChips` for quick status switching, and `initToolbar(root, { onChange })` to wire them (same markup/wiring split as `tabs()` / `initTabs()`). `.toolbar` is a **column at every breakpoint**: the filter panel opens on its own row beneath the search row, never beside it.

  Filters may carry a `group` and render as labelled sections. `toolbar({ staged: true })` holds selections until "تطبيق الفلاتر" instead of re-querying per select — used by displaced and families, which carry ten-plus filters; every other list page stays instant. `activeFilters(spec, values)` + `filterSummary()` render the removable chips and the "N فلاتر نشطة" indicator from the *same* descriptor list that built the panel, so a filter cannot exist in one and be missing from the other.
- **`utils/xlsx.js`** — a dependency-free `.xlsx` writer (stored-mode ZIP + inline-string SheetML, RTL sheet, bold frozen header). No CDN, no build step, works offline. Verified against openpyxl.
- **`ui/upload.js`** — dropzone, previews and `readFile`. Nothing leaves the browser: images under `INLINE_LIMIT` are kept as data URLs, larger files keep metadata only so the localStorage quota survives.
- **`ui/record-forms.js`** — the field groups for each record type (`displacedFields`, `aidFields`, …) with their validation schemas beside them, so a renamed field cannot silently lose its rules. Option lists are passed in; this module never reads the store.

`ui/layout.js` is the equivalent of `layout.tsx`; each file in `js/pages/` is a route component.

## Conventions

**Rendering.** Everything renders through tagged template literals. `html\`…\`` escapes every interpolation; `esc()` escapes a single value; wrap already-rendered markup in `raw()` or `fragment()` to opt out. Never interpolate data into markup without one of these — the mock data is Arabic free text and will break the page otherwise.

**Page module shape.** Every in-app page module is:

```js
const shell = mountShell({ active: 'displaced.html', title: 'النازحون' });
if (shell) init(shell);           // mountShell returns null when the guard redirected
```

`mountShell` guards the route, renders header/sidebar/bottom-nav for the role, and returns `{ session, content }`. The page renders into `content`.

**Adding a page** requires five edits, and missing any one produces a page that silently 404s or has no nav entry:

1. `pages/<name>.html` — content-free shell: font links, `main.css`, and `<script type="module" src="../assets/js/pages/<name>.js">`. Copy an existing one.
2. `assets/js/pages/<name>.js` — the module.
3. `PAGE_ACCESS` in `core/config.js` — which roles may open it.
4. `NAVIGATION` in `core/config.js` — if it belongs in the sidebar (`primary: true` puts it in the mobile bottom bar, max 4).
5. Any new enum/label goes in `core/config.js`, never inline.

**Events.** Use `delegate(root, type, selector, handler)` from `utils/dom.js` rather than attaching listeners per element; markup is re-rendered wholesale on state change.

**Async and loading.** Reads go through `store.load(() => …)`, which adds `FAKE_LATENCY` so skeleton states are genuinely exercised. Render a skeleton first, then the view, and `errorState({ retryAttrs })` on failure.

**Required UI states.** Every list needs an `emptyState()` with real Arabic copy — never a blank panel. Every destructive action goes through `confirmDialog()`. Every form field needs a label, required marker, and validation message.

**Language.** All visible text is Arabic. Code, filenames, variables, and comments are English. Fixed choices live as `{ value, label }` lists in `config.js` and are resolved with `labelOf(list, value)`.

**Styling.** `main.css` imports the rest; add rules to the file that owns the concern. All colours, spacing, radii, and shadows come from the tokens in `variables.css` — no hard-coded hex values. The visual identity is defined in `docs/genesis-DESIGN.md` (adapted: its kit cards, ⌘K search, and green brand highlight do not apply here). Shadows are for hover and focus only, never on static elements.

**Card spacing.** Never add a one-off margin to a page to separate two cards. `.stack`, `.grid` and `.split` own the spacing of what they wrap — `.split` has a base single-column rule with a gap so it is correct below 1024px too — and `layout.css` carries a `.page > … + …` rule for blocks dropped straight into the container. If two cards touch, the fix belongs in one of those, or a spacing utility is missing (`utilities.css` covers `--space-1` through `--space-7`).

## Domain rules — do not violate

These come from the client and are enforced across the UI. Several are "absences" that look like oversights but are not:

1. Exactly **one** Super Admin; multiple Camp Admins. The Camp Admin **is** the camp representative — there is no separate representative-name field.
2. Duplicate registration is prevented by **national ID only**, and one national ID cannot exist in two camps (`auth.register` enforces this).
3. There is **no tent number, no caravan number, and no file number** anywhere. Shelter *type* is stored instead, and `TENT_TYPES` has exactly two values: `tarp_tent` (خيمة شادر) and `prefab_tent` (خيمة جاهزة).
4. Health fields are **only** chronic diseases and disability. Do not add others.
5. The economic section must **not** contain "family needs".
6. Documents have **no expiry date**. There is no displacement-proof document type.
7. Search must not include file number or tent number.
8. Aid is created/edited/deleted by **Camp Admin only**. A displaced person reads their aid history as a plain list — `aid-details.html` is **not** in their `PAGE_ACCESS`, and no page offers them a link to it.
9. **Aid is not a financial transaction.** An aid record describes what was actually distributed: `{ type, organizationId, familyId, campId, date, quantity, description }`. There is no value, price, estimated value, or `displacedId`. `store.validateData()` fails the seed if `value` or `displacedId` reappears.
10. The beneficiary of aid is the **family**, never a nominated individual (`الأسرة المستفيدة`, never `المستلم`). A person's aid history is their family's.
11. A donor may be an organisation, an initiative, or a single person. The record is a name plus an **optional** phone and an **optional** responsible person — still no email, logo, website, or address.
12. A family is an independent entity with a unique auto-generated ID in the form `FAM-000001` (`selectors.nextFamilyId()`), and `membersCount` is always derived, never stored.
13. A family and its members are registered through **one form** (`family-create.html` → `selectors.createFamilyWithMembers`). `displaced-create.html` exists only for adding a person to a family that already exists.
14. "Child" means **under 18, derived from `birthDate`** (`selectors.isChild` / `isUnder`), never inferred from the `relationship` field and never stored as an `isChild` column. Orphan status is the boolean `isOrphan` on the displaced record.
15. The age bands are **cumulative, not disjoint**: "أقل من سنتين" means `age < 2` and therefore includes infants under one. Never re-read them as 1–2 / 2–3 buckets.
16. `isPregnant` and `isBreastfeeding` are written **only on female records** (`record-forms.maternityFrom`, `form.bindMaternityFields`). A male file must never show "حامل: لا" — it shows "لا ينطبق" — and the "غير حامل" filter must never return men. Switching a record's gender to ذكر clears both flags.
17. Excel export is administrative: Camp Admin and Super Admin only. It exports **exactly the filtered result set**, scoped by session, and refuses to write an empty file.

## Current state

Feature-complete for this phase. Every page in `PAGE_ACCESS` is built, in every role variant it declares:

- **Auth and shell** — login, register, forgot-password, pending, rejected, 404, dashboard (three variants).
- **Displaced** — list with search, a grouped advanced-filter panel (camp, gender, status, shelter, cumulative age band, under-18, chronic, orphan, pregnant, breastfeeding, aid type, donor), removable filter chips, Excel export, detail file across seven tabs, create, edit.
- **Families** — list with member-characteristic filters (size, and "contains a child under 18 / 3 / 2 / 1, an orphan, a chronic case, a breastfeeding or pregnant mother" — each meaning *at least one member*), Excel export, detail (also "أسرتي" for a displaced person, resolved from their own record whatever the URL says), and a combined create form that registers the head, the family and every member in one submit.
- **Aid** — list (a displaced person gets a read-only card list of their family's history through `scopeFilter`, with no detail action), detail, create, edit.
- **Operations** — donors, registration requests + decision screen, documents, messages + thread + compose, notifications.
- **Account** — profile, settings.
- **Super Admin** — camps, camp admins, statistics.

Notes for the next change:

- Approving a registration request is the one flow that creates several records at once (`selectors.approveRequest`): a displaced person, a family with them as its head, an activated account and a notification. Keep `store.validateData()` returning `[]` if you touch it.
- Cascading deletes live in `selectors.js` (`removeDisplaced`, `removeFamily`) because Supabase will do the same work with `ON DELETE CASCADE`. Removing a family head promotes another member rather than orphaning the family.
- `store.preferences.get/set(userId, …)` holds per-account UI preferences (settings page). It is a single row rather than a collection, but the rule is unchanged: pages never reach for `localStorage`.
- Records still referenced elsewhere are protected rather than cascaded: `campInUse()` and `organizationInUse()` block deletion and the UI explains why.
- Removing a displaced person no longer removes aid: aid belongs to the family and only goes when the family does (`removeFamily`).
- `SEED_VERSION` in `data/mock-data.js` must be bumped whenever a record shape changes. `store.ensureSeeded()` only reseeds when it differs, so a stale browser otherwise keeps the old shape and pages render against fields that no longer exist.
