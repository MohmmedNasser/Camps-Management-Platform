/**
 * Search + filter bar shared by every list page.
 *
 * Markup only, plus `initToolbar` to wire it up — the same split as
 * `tabs()` / `initTabs()` in components.js. The page decides what the filters
 * mean; the toolbar only reports the values back.
 */

import { esc, qs, qsa, on, debounce } from '../utils/dom.js';
import { icon } from './icons.js';
import { button } from './components.js';
import { selectField } from './form.js';

/**
 * @param {object} options
 * @param {string} [options.searchValue]
 * @param {string} [options.searchPlaceholder]
 * @param {{name, label, options, value?, placeholder?}[]} [options.filters]
 * @param {string} [options.actions] markup placed next to the search box
 * @param {number} [options.activeCount] filters currently applied (shown on the toggle)
 */
export function toolbar({
  searchValue = '',
  searchPlaceholder = 'ابحث…',
  filters = [],
  actions = '',
  activeCount = 0,
}) {
  const fields = filters
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

  return `
    <div class="toolbar" data-toolbar>
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
                attrs: 'data-toggle-filters aria-expanded="false" aria-controls="toolbar-filters"',
              })
            : ''
        }
        ${actions}
      </div>

      ${
        filters.length
          ? `<div class="filters" id="toolbar-filters" data-open="${activeCount ? 'true' : 'false'}">
              ${fields}
              <div class="filters__actions">
                ${button({ label: 'إعادة تعيين', variant: 'ghost', attrs: 'data-reset-filters' })}
              </div>
            </div>`
          : ''
      }
    </div>`;
}

/**
 * Wire a rendered toolbar.
 *
 * @param {HTMLElement} root element containing the toolbar
 * @param {{onChange: (values: object) => void}} handlers
 *        onChange receives `{ q, ...filterName: value }` on every change.
 */
export function initToolbar(root, { onChange }) {
  const host = qs('[data-toolbar]', root);
  if (!host) return;

  const search = qs('#toolbar-search', host);
  const panel = qs('#toolbar-filters', host);
  const toggle = qs('[data-toggle-filters]', host);

  const values = () => {
    const out = { q: search ? search.value : '' };
    qsa('select', panel || host).forEach((select) => {
      out[select.name] = select.value;
    });
    return out;
  };

  if (toggle && panel) {
    on(toggle, 'click', () => {
      const open = panel.dataset.open !== 'true';
      panel.dataset.open = String(open);
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  if (search) {
    const emit = debounce(() => onChange(values()), 250);
    on(search, 'input', emit);
    on(search, 'search', () => onChange(values()));
  }

  qsa('select', panel || host).forEach((select) =>
    on(select, 'change', () => onChange(values()))
  );

  const reset = qs('[data-reset-filters]', host);
  if (reset) {
    on(reset, 'click', () => {
      if (search) search.value = '';
      qsa('select', panel || host).forEach((select) => {
        select.value = '';
      });
      onChange(values());
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
