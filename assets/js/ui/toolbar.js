/**
 * Search + filter bar shared by every list page.
 *
 * Markup only, plus `initToolbar` to wire it up — the same split as
 * `tabs()` / `initTabs()` in components.js. The page decides what the filters
 * mean; the toolbar only reports the values back.
 *
 * Two presentations:
 *   - default: an inline panel that opens under the search row and applies on
 *     every change (aid, documents)
 *   - `modal: true`: the filter button opens a sheet built on `ui/modal.js`,
 *     which keeps a page carrying a dozen filters compact. Values are staged
 *     inside the sheet and committed only by "تطبيق الفلاتر" (displaced,
 *     families)
 */

import { esc, qs, qsa, on, delegate, debounce } from '../utils/dom.js';
import { icon } from './icons.js';
import { button } from './components.js';
import { selectField } from './form.js';
import { openModal } from './modal.js';

/**
 * @param {object} options
 * @param {string} [options.searchValue]
 * @param {string} [options.searchPlaceholder]
 * @param {{name, label, options, value?, placeholder?, group?}[]} [options.filters]
 * @param {string} [options.actions] markup placed next to the search box
 * @param {number} [options.activeCount] filters currently applied (shown on the button)
 * @param {boolean} [options.modal] open the filters in a sheet instead of inline
 * @param {boolean} [options.open] render the inline panel already expanded
 */
export function toolbar({
  searchValue = '',
  searchPlaceholder = 'ابحث…',
  filters = [],
  actions = '',
  activeCount = 0,
  modal = false,
  open = false,
}) {
  const panelOpen = open || activeCount > 0;

  return `
    <div class="toolbar" data-toolbar${modal ? ' data-filter-modal' : ''}>
      <div class="toolbar__row">
        <div class="input-wrap">
          <span class="input-wrap__icon">${icon('search', { size: 17 })}</span>
          <input class="input" type="search" name="q" id="toolbar-search"
            value="${esc(searchValue)}" placeholder="${esc(searchPlaceholder)}"
            aria-label="${esc(searchPlaceholder)}">
        </div>
        ${filters.length ? filterButton({ activeCount, modal, panelOpen }) : ''}
        ${actions}
      </div>

      ${filters.length && !modal ? filterPanel(filters, { open: panelOpen }) : ''}
    </div>`;
}

/**
 * The فلترة trigger. In modal mode the active count rides as a badge rather
 * than being spliced into the label, so the button width barely moves as
 * filters are added.
 */
export function filterButton({ activeCount, modal, panelOpen }) {
  if (!modal) {
    return button({
      label: activeCount ? `فلترة (${activeCount})` : 'فلترة',
      variant: activeCount ? 'primary' : 'secondary',
      iconName: 'filter',
      attrs: `data-toggle-filters aria-expanded="${panelOpen}" aria-controls="toolbar-filters"`,
    });
  }

  const badge = activeCount
    ? `<span class="btn__badge">${activeCount}</span>
       <span class="sr-only">${activeCount} فلاتر نشطة</span>`
    : '';

  return `
    <button type="button" class="btn btn--${activeCount ? 'primary' : 'secondary'}"
      data-open-filters aria-haspopup="dialog">
      ${icon('filter', { size: 17 })}فلترة${badge}
    </button>`;
}

/** Consecutive filters sharing a `group` become one titled section. */
function groupFilters(filters) {
  const groups = [];
  filters.forEach((filter) => {
    const name = filter.group || '';
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(filter);
    else groups.push({ name, items: [filter] });
  });
  return groups;
}

function filterFields(filters) {
  return filters
    .map((filter) =>
      selectField({
        name: filter.name,
        label: filter.label,
        options: filter.options,
        value: filter.value || '',
        placeholder: filter.placeholder || 'الكل',
      })
    )
    .join('');
}

/** The inline panel — always rendered *below* the search row, never beside it. */
function filterPanel(filters, { open }) {
  const body = groupFilters(filters)
    .map(
      (group) => `
      <div class="filters__group">
        ${group.name ? `<p class="filters__group-title">${esc(group.name)}</p>` : ''}
        <div class="filters__fields">${filterFields(group.items)}</div>
      </div>`
    )
    .join('');

  return `
    <div class="filters" id="toolbar-filters" data-open="${open ? 'true' : 'false'}">
      ${body}
      <div class="filters__actions">
        ${button({ label: 'إعادة تعيين', variant: 'ghost', attrs: 'data-reset-filters' })}
      </div>
    </div>`;
}

/* ---- Filter sheet -------------------------------------------------------- */

/**
 * Open the filters in a dialog, built on the app's one modal component so the
 * focus trap, Esc, scrim click and focus restore all come from there.
 *
 * Values are staged: the sheet edits its own copy and the page hears nothing
 * until "تطبيق الفلاتر". Dismissing by ×, scrim or Esc therefore discards the
 * edits and leaves the applied filters exactly as they were.
 *
 * @param {object} options
 * @param {object[]} options.filters descriptors, each carrying its current value
 * @param {(values: object) => void} options.onApply committed values
 * @param {(values: object) => number} [options.onPreview] how many rows the
 *        staged values would return; shown live so nobody applies into an
 *        empty list and has to reopen. The page owns the query — the sheet
 *        only asks.
 */
export function openFilterSheet({ filters, onApply, onPreview = null }) {
  const sections = groupFilters(filters)
    .map(
      (group) => `
      <section class="filter-sheet__group">
        ${group.name ? `<h3 class="filter-sheet__title">${esc(group.name)}</h3>` : ''}
        <div class="filter-sheet__fields">${filterFields(group.items)}</div>
      </section>`
    )
    .join('');

  const modal = openModal({
    title: 'الفلاتر',
    description: 'تُطبَّق الفلاتر معاً؛ اختر ما يلزم ثم اضغط تطبيق.',
    size: 'lg',
    // The live count sits at the end of the scrollable body, not the footer —
    // that keeps the footer to plain reset/apply buttons sharing the same
    // full-width, equal-split styling every other modal in the app uses.
    body: `
      <div class="filter-sheet">${sections}</div>
      <p class="filter-sheet__preview" data-preview aria-live="polite"></p>`,
    footer: `
      ${button({ label: 'إعادة تعيين', variant: 'ghost', attrs: 'data-reset-filters' })}
      ${button({
        label: 'تطبيق الفلاتر',
        variant: 'primary',
        iconName: 'check',
        attrs: 'data-apply-filters',
      })}`,
  });

  const root = modal.element;
  const selects = () => qsa('.filter-sheet select', root);
  const values = () =>
    Object.fromEntries(selects().map((select) => [select.name, select.value]));

  const preview = qs('[data-preview]', root);
  const refresh = debounce(() => {
    if (!preview || !onPreview) return;
    const count = onPreview(values());
    preview.textContent = count === 0 ? 'لا توجد نتائج مطابقة' : `ستظهر ${count} نتيجة`;
    preview.dataset.empty = String(count === 0);
  }, 150);

  selects().forEach((select) => on(select, 'change', refresh));
  refresh();

  on(qs('[data-apply-filters]', root), 'click', () => {
    const applied = values();
    modal.close('apply');
    onApply(applied);
  });

  /*
   * Reset clears every field AND commits the empty state immediately — the
   * page's result count and active-filter badge must drop to zero right
   * away, not only once "تطبيق الفلاتر" is pressed. The sheet stays open so
   * the cleared selects are visible; the search box is not a filter and is
   * left untouched.
   */
  on(qs('[data-reset-filters]', root), 'click', () => {
    selects().forEach((select) => {
      select.value = '';
    });
    const cleared = values();
    refresh();
    onApply(cleared);
    qs('.filter-sheet select', root)?.focus();
  });

  return modal;
}

/**
 * Wire a rendered toolbar.
 *
 * @param {HTMLElement} root element containing the toolbar
 * @param {object} handlers
 * @param {(values: object) => void} handlers.onChange receives `{ q, ...filters }`
 * @param {() => object[]} [handlers.getFilters] current filter descriptors, read
 *        fresh each time the sheet opens so it never shows stale values
 * @param {(values: object) => number} [handlers.onPreview] staged result count
 * @returns {{openFilters: Function}} so the page can reopen the sheet itself
 */
export function initToolbar(root, { onChange, getFilters = null, onPreview = null }) {
  const host = qs('[data-toolbar]', root);
  if (!host) return { openFilters: () => {} };

  const useModal = host.hasAttribute('data-filter-modal');
  const search = qs('#toolbar-search', host);
  const panel = qs('#toolbar-filters', host);
  const toggle = qs('[data-toggle-filters]', host);
  const selects = () => qsa('select', panel || host);

  const inlineValues = () =>
    Object.fromEntries(selects().map((select) => [select.name, select.value]));

  // The search box fires against the filters that were last *applied*, never
  // against values a user is still editing in the sheet.
  let applied = useModal ? {} : inlineValues();

  const emit = (values) => {
    applied = { ...values };
    onChange({ q: search ? search.value : '', ...values });
  };

  const openFilters = () => {
    if (!useModal || !getFilters) return;
    openFilterSheet({ filters: getFilters(), onApply: emit, onPreview });
  };

  if (useModal) {
    // Delegated on `root`, not the toolbar alone: the "+N" chip that reopens
    // the sheet lives in the filter-summary strip, a sibling of the toolbar
    // that is (re)rendered after every search, so a one-time `qsa` at init
    // would miss it.
    delegate(root, 'click', '[data-open-filters]', openFilters);
  } else if (toggle && panel) {
    on(toggle, 'click', () => {
      const willOpen = panel.dataset.open !== 'true';
      panel.dataset.open = String(willOpen);
      toggle.setAttribute('aria-expanded', String(willOpen));
    });
  }

  if (search) {
    const fire = () => onChange({ q: search.value, ...applied });
    on(search, 'input', debounce(fire, 250));
    on(search, 'search', fire);
  }

  if (!useModal) {
    selects().forEach((select) => on(select, 'change', () => emit(inlineValues())));

    const reset = qs('[data-reset-filters]', host);
    if (reset) {
      on(reset, 'click', () => {
        if (search) search.value = '';
        selects().forEach((select) => {
          select.value = '';
        });
        emit(inlineValues());
      });
    }
  }

  return { openFilters };
}

/**
 * Refresh the فلترة button's active-count badge after a filter change.
 *
 * The toolbar markup is written once at page render; applying, resetting or
 * removing a chip only re-renders the results and the summary strip, so
 * without this the badge would go stale the moment a filter is applied
 * through the sheet. Regenerated from the same `filterButton()` used at
 * first render, then swapped in by `outerHTML` — safe because every click on
 * it is caught by the delegated listener `initToolbar` already installed on
 * `root`, not a reference to this specific node.
 *
 * @param {HTMLElement} root element containing the toolbar
 * @param {number} count active filter count
 */
export function syncFilterButton(root, count) {
  const trigger = qs('[data-open-filters]', root);
  if (!trigger) return;
  trigger.outerHTML = filterButton({ activeCount: count, modal: true, panelOpen: false });
}

/**
 * Horizontal scroll strip of quick filters (used for statuses and categories).
 * @param {{value, label, count?}[]} items
 */
export function filterChips(items, activeValue = '') {
  return `
    <div class="filter-chips" role="group" aria-label="تصفية سريعة">
      ${items
        .map(
          (item) => `
        <button type="button" class="chip${item.value === activeValue ? ' chip--active' : ''}"
          data-chip="${esc(item.value)}" aria-pressed="${item.value === activeValue}">
          ${esc(item.label)}${item.count === undefined ? '' : ` (${item.count})`}
        </button>`
        )
        .join('')}
    </div>`;
}

/* ---- Active filter summary ----------------------------------------------- */

/**
 * Which of a page's filters currently hold a value, resolved to their labels.
 *
 * Takes the same descriptor list handed to `toolbar()`, so the chips and the
 * panel can never drift apart.
 *
 * @returns {{name, label, valueLabel}[]}
 */
export function activeFilters(filters, values = {}) {
  return filters
    .map((filter) => {
      const value = values[filter.name];
      if (!value) return null;
      const option = filter.options.find((entry) => entry.value === value);
      return { name: filter.name, label: filter.label, valueLabel: option ? option.label : value };
    })
    .filter(Boolean);
}

/** How many chips stay visible before the rest collapse into "+N". */
const CHIP_LIMIT = 3;

/**
 * The active-filter strip that sits under the toolbar.
 *
 * Deliberately one compact line: the whole point of moving the fields into a
 * sheet is that the page stays short, so chips beyond `CHIP_LIMIT` collapse
 * into a "+N" button that reopens the sheet rather than growing a second tall
 * block. Each chip removes just its own filter (`data-remove-filter="<name>"`).
 */
export function filterSummary({ active, total, noun = 'سجل', query = '' }) {
  if (!active.length && !query) return '';

  const chip = (name, text, srLabel) => `
    <button type="button" class="chip chip--active" data-remove-filter="${esc(name)}">
      <span class="chip__text">${esc(text)}</span>
      <span class="chip__remove" aria-hidden="true">×</span>
      <span class="sr-only">${esc(srLabel)}</span>
    </button>`;

  const all = [
    query ? chip('q', `بحث: ${query}`, 'إزالة البحث') : '',
    ...active.map((item) =>
      chip(item.name, `${item.label}: ${item.valueLabel}`, `إزالة الفلتر ${item.label}`)
    ),
  ].filter(Boolean);

  const shown = all.slice(0, CHIP_LIMIT);
  const hidden = all.length - shown.length;

  const more = hidden
    ? `<button type="button" class="chip chip--more" data-open-filters
         aria-label="عرض ${hidden} فلاتر أخرى">+${hidden}</button>`
    : '';

  return `
    <div class="filter-bar" aria-label="الفلاتر النشطة">
      <div class="filter-bar__chips">${shown.join('')}${more}</div>
      <p class="filter-bar__count">
        <strong>${total}</strong> ${esc(noun)}
      </p>
      <button type="button" class="filter-bar__clear" data-clear-search>إزالة الكل</button>
    </div>`;
}
