/**
 * Search + filter bar shared by every list page.
 *
 * Markup only, plus `initToolbar` to wire it up — the same split as
 * `tabs()` / `initTabs()` in components.js. The page decides what the filters
 * mean; the toolbar only reports the values back.
 *
 * Two modes:
 *   - default: every change fires `onChange` immediately (aid, documents, …)
 *   - `staged: true`: changes are held until "تطبيق الفلاتر" is pressed, which
 *     is what the ten-filter panels on displaced and families use, so the page
 *     is not re-queried once per select on a phone.
 */

import { esc, qs, qsa, on, debounce } from '../utils/dom.js';
import { icon } from './icons.js';
import { button } from './components.js';
import { selectField } from './form.js';

/**
 * @param {object} options
 * @param {string} [options.searchValue]
 * @param {string} [options.searchPlaceholder]
 * @param {{name, label, options, value?, placeholder?, group?}[]} [options.filters]
 * @param {string} [options.actions] markup placed next to the search box
 * @param {number} [options.activeCount] filters currently applied (shown on the toggle)
 * @param {boolean} [options.staged] hold changes until "تطبيق الفلاتر"
 * @param {boolean} [options.open] render the panel already expanded
 */
export function toolbar({
  searchValue = '',
  searchPlaceholder = 'ابحث…',
  filters = [],
  actions = '',
  activeCount = 0,
  staged = false,
  open = false,
}) {
  const panelOpen = open || activeCount > 0;

  return `
    <div class="toolbar" data-toolbar${staged ? ' data-staged' : ''}>
      <div class="toolbar__row">
        <div class="input-wrap">
          <span class="input-wrap__icon">${icon('search', { size: 17 })}</span>
          <input class="input" type="search" name="q" id="toolbar-search"
            value="${esc(searchValue)}" placeholder="${esc(searchPlaceholder)}"
            aria-label="${esc(searchPlaceholder)}">
        </div>
        ${
          filters.length
            ? button({
                label: activeCount ? `فلترة (${activeCount})` : 'فلترة',
                variant: activeCount ? 'primary' : 'secondary',
                iconName: 'filter',
                attrs: `data-toggle-filters aria-expanded="${panelOpen}" aria-controls="toolbar-filters"`,
              })
            : ''
        }
        ${actions}
      </div>

      ${filters.length ? filterPanel(filters, { staged, open: panelOpen }) : ''}
    </div>`;
}

/** The filter row itself — always rendered *below* the search row, never beside it. */
function filterPanel(filters, { staged, open }) {
  const groups = [];
  filters.forEach((filter) => {
    const name = filter.group || '';
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(filter);
    else groups.push({ name, items: [filter] });
  });

  const body = groups
    .map(
      (group) => `
      <div class="filters__group">
        ${group.name ? `<p class="filters__group-title">${esc(group.name)}</p>` : ''}
        <div class="filters__fields">
          ${group.items
            .map((filter) =>
              selectField({
                name: filter.name,
                label: filter.label,
                options: filter.options,
                value: filter.value || '',
                placeholder: filter.placeholder || 'الكل',
              })
            )
            .join('')}
        </div>
      </div>`
    )
    .join('');

  return `
    <div class="filters" id="toolbar-filters" data-open="${open ? 'true' : 'false'}">
      ${body}
      <div class="filters__actions">
        ${button({ label: 'إعادة تعيين', variant: 'ghost', attrs: 'data-reset-filters' })}
        ${
          staged
            ? button({
                label: 'تطبيق الفلاتر',
                variant: 'primary',
                iconName: 'check',
                attrs: 'data-apply-filters',
              })
            : ''
        }
      </div>
    </div>`;
}

/**
 * Wire a rendered toolbar.
 *
 * @param {HTMLElement} root element containing the toolbar
 * @param {{onChange: (values: object) => void}} handlers
 *        onChange receives `{ q, ...filterName: value }`.
 */
export function initToolbar(root, { onChange }) {
  const host = qs('[data-toolbar]', root);
  if (!host) return;

  const staged = host.hasAttribute('data-staged');
  const search = qs('#toolbar-search', host);
  const panel = qs('#toolbar-filters', host);
  const toggle = qs('[data-toggle-filters]', host);
  const selects = () => qsa('select', panel || host);

  const filterValues = () => {
    const out = {};
    selects().forEach((select) => {
      out[select.name] = select.value;
    });
    return out;
  };

  // In staged mode the search box must keep firing against the filters that
  // were last *applied*, not the ones sitting unapplied in the panel.
  let applied = filterValues();

  const emit = (values) => {
    applied = { ...values };
    onChange({ q: search ? search.value : '', ...values });
  };

  if (toggle && panel) {
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

  if (staged) {
    const apply = qs('[data-apply-filters]', host);
    if (apply) on(apply, 'click', () => emit(filterValues()));
    // Enter inside the panel applies, rather than doing nothing.
    if (panel) {
      on(panel, 'keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          emit(filterValues());
        }
      });
    }
  } else {
    selects().forEach((select) => on(select, 'change', () => emit(filterValues())));
  }

  const reset = qs('[data-reset-filters]', host);
  if (reset) {
    on(reset, 'click', () => {
      if (search) search.value = '';
      selects().forEach((select) => {
        select.value = '';
      });
      emit(filterValues());
    });
  }
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

/**
 * Summary above the results: what is filtering them, how many matched, and a
 * per-chip remove control (`data-remove-filter="<name>"`).
 */
export function filterSummary({ active, total, noun = 'سجل', query = '' }) {
  if (!active.length && !query) return '';

  const chips = [
    query
      ? `<button type="button" class="chip chip--active" data-remove-filter="q">
           <span>بحث: ${esc(query)}</span>
           <span class="chip__remove" aria-hidden="true">×</span>
           <span class="sr-only">إزالة البحث</span>
         </button>`
      : '',
    ...active.map(
      (item) => `
      <button type="button" class="chip chip--active" data-remove-filter="${esc(item.name)}">
        <span>${esc(item.label)}: ${esc(item.valueLabel)}</span>
        <span class="chip__remove" aria-hidden="true">×</span>
        <span class="sr-only">إزالة الفلتر ${esc(item.label)}</span>
      </button>`
    ),
  ]
    .filter(Boolean)
    .join('');

  const count = active.length + (query ? 1 : 0);

  return `
    <section class="filter-summary" aria-label="الفلاتر النشطة">
      <div class="filter-summary__head">
        <h2 class="filter-summary__title">النتائج المفلترة</h2>
        <span class="badge badge--info">${count} ${count === 1 ? 'فلتر نشط' : 'فلاتر نشطة'}</span>
      </div>
      <div class="filter-summary__chips">${chips}</div>
      <p class="filter-summary__count">عدد النتائج: <strong>${total}</strong> ${esc(noun)}</p>
      <div class="filter-summary__actions">
        ${button({ label: 'إزالة كل الفلاتر', variant: 'ghost', attrs: 'data-clear-search' })}
      </div>
    </section>`;
}
