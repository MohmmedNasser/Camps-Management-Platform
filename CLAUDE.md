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
2. **Headless render smoke test** — page modules are pure enough to run under jsdom. The harness is not in the repo (it lives in a scratch dir with `jsdom` installed); recreate it if needed. It loads each page's HTML, stubs `localStorage` and a writable `window.location` (jsdom's is non-configurable — hand the modules a `Proxy` that intercepts `location`), imports the page module, and asserts the page rendered without throwing. This catches the majority of regressions since almost every bug here is a render-time error.

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
- **`core/auth.js`** — prototype session (a user id in localStorage) plus the real thing: the `PERMISSIONS` table and `can(action)`. Every mutating control is gated on `can()`, every camp-scoped record on `inScope()`.
- **`core/router.js`** — `guard()` runs before any in-app page renders and redirects: no session → login, `pending`/`rejected` status → its status screen, role not in `PAGE_ACCESS` → 404. Never hand-write a page URL; use `pageUrl(page, params)`, which resolves correctly from both `/` and `/pages/`.
- **`ui/*`** — presentation only. Component functions return **HTML strings** and know nothing about what the data means.
- **`js/pages/*`** — thin glue: read query params → call store/selectors → call ui components → wire events. One module per page.

The `ui/` layer beyond the primitives in `components.js`:

- **`ui/table.js`** — `dataTable({ columns, rows })` plus `cellMain / cellMono / rowActions / resultBar`. One markup shape covers both presentations in `tables.css`: a real `<table>` from 768px, cards below it (every cell carries a `data-label`).
- **`ui/toolbar.js`** — the search + filter panel every list page opens with, `filterChips` for quick status switching, and `initToolbar(root, { onChange })` to wire them (same markup/wiring split as `tabs()` / `initTabs()`).
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

## Domain rules — do not violate

These come from the client and are enforced across the UI. Several are "absences" that look like oversights but are not:

1. Exactly **one** Super Admin; multiple Camp Admins. The Camp Admin **is** the camp representative — there is no separate representative-name field.
2. Duplicate registration is prevented by **national ID only**, and one national ID cannot exist in two camps (`auth.register` enforces this).
3. There is **no tent number, no caravan number, and no file number** anywhere. Tent *type* (`TENT_TYPES`) is stored instead.
4. Health fields are **only** chronic diseases and disability. Do not add others.
5. The economic section must **not** contain "family needs".
6. Documents have **no expiry date**. There is no displacement-proof document type.
7. Search must not include file number or tent number.
8. Aid is created/edited/deleted by **Camp Admin only**; a displaced person can only view their aid history.
9. An organisation has **only** a name and an optional responsible person — no email, phone, logo, website, or address.
10. A family is an independent entity with a unique auto-generated ID in the form `FAM-000001` (`selectors.nextFamilyId()`).

## Current state

Feature-complete for this phase. Every page in `PAGE_ACCESS` is built, in every role variant it declares:

- **Auth and shell** — login, register, forgot-password, pending, rejected, 404, dashboard (three variants).
- **Displaced** — list with search/filters, detail file across seven tabs, create, edit.
- **Families** — list, detail (also "أسرتي" for a displaced person, resolved from their own record whatever the URL says), create.
- **Aid** — list (a displaced person gets a read-only view of their own history through `scopeFilter`), detail, create, edit.
- **Operations** — organisations, registration requests + decision screen, documents, messages + thread + compose, notifications.
- **Account** — profile, settings.
- **Super Admin** — camps, camp admins, statistics.

Notes for the next change:

- Approving a registration request is the one flow that creates several records at once (`selectors.approveRequest`): a displaced person, a family with them as its head, an activated account and a notification. Keep `store.validateData()` returning `[]` if you touch it.
- Cascading deletes live in `selectors.js` (`removeDisplaced`, `removeFamily`) because Supabase will do the same work with `ON DELETE CASCADE`. Removing a family head promotes another member rather than orphaning the family.
- `store.preferences.get/set(userId, …)` holds per-account UI preferences (settings page). It is a single row rather than a collection, but the rule is unchanged: pages never reach for `localStorage`.
- Records still referenced elsewhere are protected rather than cascaded: `campInUse()` and `organizationInUse()` block deletion and the UI explains why.
