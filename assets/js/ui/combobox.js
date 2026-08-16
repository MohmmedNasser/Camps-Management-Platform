/**
 * Searchable multi-select combobox.
 *
 * Presentation plus a small controller — the same markup/behavior split as
 * `toolbar()` / `initToolbar()`. This module knows nothing about what it is
 * selecting: the page supplies `search(query)` and, for "select all", a
 * `selectAllSource()` callback. Selections are mirrored into hidden grouped
 * checkboxes (`data-group="true"`), exactly like `checkboxGroupField` — so
 * `readForm()` collects them into an array with no special-casing, and
 * existing schema validation (`rules.custom` on array length) needs no
 * changes.
 *
 * Only ever renders the options currently matching the search box (capped at
 * `RESULT_LIMIT`) plus the currently selected chips (capped at `CHIP_LIMIT`,
 * collapsing into a "+N" summary) — never the full source list, so this
 * stays cheap however many options exist behind `search`.
 */

import { esc, qs, qsa, on, delegate, debounce } from '../utils/dom.js';
import { icon } from './icons.js';
import { button } from './components.js';

const RESULT_LIMIT = 50;
const CHIP_LIMIT = 8;

/**
 * @param {object} options
 * @param {string} options.name form field name; submits as an array of values
 * @param {string} options.label
 * @param {{value,label}[]} [options.selectedOptions] pre-selected items, resolved (edit forms)
 * @param {string} [options.placeholder]
 * @param {boolean} [options.required]
 * @param {string} [options.hint]
 * @param {boolean} [options.full]
 * @param {string} [options.selectAllLabel]
 * @param {string} [options.deselectAllLabel]
 */
export function multiSelectField({
  name,
  label,
  selectedOptions = [],
  placeholder = 'ابحث…',
  required = false,
  hint = '',
  full = true,
  selectAllLabel = 'تحديد الكل',
  deselectAllLabel = 'إلغاء تحديد الكل',
}) {
  const hiddenInputs = selectedOptions
    .map(
      (option) =>
        `<input type="checkbox" name="${esc(name)}" value="${esc(option.value)}" data-group="true" data-label="${esc(option.label)}" checked hidden>`
    )
    .join('');

  return `
    <div class="field${full ? ' field--full' : ''}" data-field="${esc(name)}">
      <span class="label" id="${esc(name)}-label">${esc(label)}${
        required ? '<span class="label__required" aria-hidden="true">*</span>' : ''
      }</span>
      <div class="combobox" data-combobox="${esc(name)}">
        <div class="combobox__control" data-combobox-control>
          <div class="combobox__chips" data-combobox-chips></div>
          <input class="combobox__input" type="text" role="combobox" aria-expanded="false"
            aria-autocomplete="list" aria-labelledby="${esc(name)}-label"
            placeholder="${esc(placeholder)}" data-combobox-search autocomplete="off">
        </div>
        <div class="combobox__panel" data-combobox-panel hidden role="listbox" aria-label="${esc(label)}"></div>
      </div>
      <div class="combobox__actions">
        ${button({ label: selectAllLabel, variant: 'secondary', attrs: 'data-combobox-select-all' })}
        ${button({ label: deselectAllLabel, variant: 'ghost', attrs: 'data-combobox-deselect-all' })}
      </div>
      <p class="u-sm u-secondary u-mt-2" data-combobox-count aria-live="polite"></p>
      <div data-combobox-inputs hidden>${hiddenInputs}</div>
      ${hint ? `<p class="field__hint">${esc(hint)}</p>` : ''}
      <p class="field__msg field__msg--error" id="${esc(name)}-error" role="alert"></p>
    </div>`;
}

/** Default "تم تحديد N" count line; callers override for domain-specific pluralization. */
function defaultCountLabel(count) {
  return `تم تحديد ${count}`;
}

/**
 * Wire a rendered `multiSelectField()`.
 *
 * @param {HTMLElement} scope element containing the field (typically the form)
 * @param {object} options
 * @param {string} options.name matches the field's `name`
 * @param {(query: string) => {value,label}[]} options.search
 * @param {() => {value,label}[]} [options.selectAllSource] every eligible item;
 *        omit to hide the select-all button entirely
 * @param {(count: number, total: number|null) => string} [options.countLabel]
 */
export function initMultiSelect(scope, { name, search, selectAllSource = null, countLabel = defaultCountLabel }) {
  const root = qs(`[data-combobox="${CSS.escape(name)}"]`, scope);
  if (!root) return;

  const field = root.closest('[data-field]');
  const input = qs('[data-combobox-search]', root);
  const chipsHost = qs('[data-combobox-chips]', root);
  const panel = qs('[data-combobox-panel]', root);
  const inputsHost = qs('[data-combobox-inputs]', field);
  const countEl = qs('[data-combobox-count]', field);
  const selectAllBtn = qs('[data-combobox-select-all]', field);
  const deselectAllBtn = qs('[data-combobox-deselect-all]', field);

  if (!selectAllSource && selectAllBtn) selectAllBtn.hidden = true;

  // value -> label, seeded from the hidden inputs the shell rendered.
  const selected = new Map(
    qsa('input[type="checkbox"]', inputsHost).map((box) => [box.value, box.dataset.label])
  );

  const setError = (message) => {
    if (!field) return;
    field.dataset.state = message ? 'error' : '';
    const slot = qs('.field__msg--error', field);
    if (slot) slot.textContent = message || '';
  };

  const syncHiddenInputs = () => {
    inputsHost.innerHTML = [...selected.entries()]
      .map(
        ([value, labelText]) =>
          `<input type="checkbox" name="${esc(name)}" value="${esc(value)}" data-group="true" data-label="${esc(
            labelText
          )}" checked hidden>`
      )
      .join('');
  };

  const syncChips = () => {
    const entries = [...selected.entries()];
    const shown = entries.slice(0, CHIP_LIMIT);
    const overflow = entries.length - shown.length;
    chipsHost.innerHTML =
      shown
        .map(
          ([value, labelText]) => `
        <span class="chip chip--outline combobox__chip">
          <span class="chip__text">${esc(labelText)}</span>
          <button type="button" class="chip__remove" data-remove="${esc(value)}" aria-label="إزالة ${esc(labelText)}">×</button>
        </span>`
        )
        .join('') +
      (overflow > 0
        ? `<span class="chip combobox__chip combobox__chip--more">+${overflow} أسرة أخرى</span>`
        : '');
  };

  const syncCount = () => {
    if (!countEl) return;
    const total = selectAllSource ? selectAllSource().length : null;
    countEl.textContent =
      total !== null && total > 0 && selected.size === total
        ? `تم تحديد جميع الأسر (${total})`
        : countLabel(selected.size, total);
  };

  const syncField = () => {
    syncHiddenInputs();
    syncChips();
    syncCount();
  };

  function renderResults(term) {
    const all = search(term);
    const results = all.slice(0, RESULT_LIMIT);
    const rows = results.length
      ? results
          .map(
            (option) => `
        <div class="combobox__option${selected.has(option.value) ? ' combobox__option--selected' : ''}"
          role="option" aria-selected="${selected.has(option.value)}"
          data-value="${esc(option.value)}" data-label="${esc(option.label)}">
          <span class="combobox__option-check">${
            selected.has(option.value) ? icon('check', { size: 14 }) : ''
          }</span>
          <span class="combobox__option-label">${esc(option.label)}</span>
        </div>`
          )
          .join('')
      : `<p class="combobox__empty">لا توجد نتائج مطابقة</p>`;
    const more =
      all.length > RESULT_LIMIT
        ? `<p class="combobox__hint">أظهرت أول ${RESULT_LIMIT} نتيجة من ${all.length} — دقّق البحث لعرض المزيد</p>`
        : '';
    panel.innerHTML = rows + more;
  }

  function openPanel() {
    renderResults(input.value.trim());
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  function toggle(value, labelText) {
    if (selected.has(value)) selected.delete(value);
    else selected.set(value, labelText);
    syncField();
    setError('');
  }

  on(input, 'focus', openPanel);
  on(input, 'input', debounce(() => renderResults(input.value.trim()), 150));
  on(input, 'keydown', (event) => {
    if (event.key === 'Escape') {
      closePanel();
      input.blur();
    }
  });

  delegate(panel, 'click', '.combobox__option', (event, node) => {
    toggle(node.dataset.value, node.dataset.label);
    renderResults(input.value.trim());
    input.focus();
  });

  delegate(chipsHost, 'click', '[data-remove]', (event, node) => {
    selected.delete(node.dataset.remove);
    syncField();
    setError('');
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) closePanel();
  });

  if (selectAllBtn && selectAllSource) {
    on(selectAllBtn, 'click', () => {
      selectAllSource().forEach((option) => selected.set(option.value, option.label));
      syncField();
      setError('');
      renderResults(input.value.trim());
    });
  }

  if (deselectAllBtn) {
    on(deselectAllBtn, 'click', () => {
      selected.clear();
      syncField();
      renderResults(input.value.trim());
    });
  }

  syncField();
}
