/**
 * Data table.
 *
 * One markup shape serves both presentations described in `css/tables.css`:
 * a real <table> from 768px, and a stack of cards below it (each cell carries
 * its own `data-label`, which the CSS promotes to a mobile label).
 *
 * Presentation only — a column's `cell()` receives an already-prepared row and
 * returns HTML. The table knows nothing about what the data means.
 */

import { esc } from '../utils/dom.js';
import { iconButton } from './components.js';
import { icon } from './icons.js';

/**
 * @param {object} options
 * @param {{key: string, label: string, cell?: Function, primary?: boolean,
 *          mono?: boolean, actions?: boolean, sortable?: boolean}[]} options.columns
 * @param {object[]} options.rows
 * @param {string} [options.empty] markup shown instead of the body when rows is empty
 * @param {(row) => string} [options.rowAttrs] extra attributes per <tr>
 * @param {string} [options.caption] screen-reader caption
 * @param {{key: string, dir: 'asc'|'desc'}} [options.sort]
 * @param {string} [options.foot] markup appended after the table (pagination)
 */
export function dataTable({
  columns,
  rows,
  empty = '',
  rowAttrs = () => '',
  caption = '',
  sort = null,
  foot = '',
}) {
  if (!rows.length && empty) {
    return `<div class="table-wrap">${empty}</div>`;
  }

  const head = columns
    .map((column) => {
      if (column.actions) return `<th scope="col"><span class="sr-only">إجراءات</span></th>`;
      if (!column.sortable) return `<th scope="col">${esc(column.label)}</th>`;
      const active = sort && sort.key === column.key;
      const dir = active && sort.dir === 'desc' ? 'desc' : 'asc';
      return `
        <th scope="col"${active ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
          <button type="button" data-sort="${esc(column.key)}">
            ${esc(column.label)}
            <span class="sort-icon">${icon(dir === 'asc' ? 'sortAsc' : 'sortDesc', { size: 14 })}</span>
          </button>
        </th>`;
    })
    .join('');

  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const value = column.cell ? column.cell(row) : esc(row[column.key] ?? '—');
          if (column.actions) return `<td data-actions><span class="cell-actions">${value}</span></td>`;
          const flags = [
            column.primary ? ' data-primary' : '',
            ` data-label="${esc(column.label)}"`,
          ].join('');
          return `<td${flags}>${column.mono ? `<span class="cell-mono">${value}</span>` : value}</td>`;
        })
        .join('');
      return `<tr ${rowAttrs(row)}>${cells}</tr>`;
    })
    .join('');

  return `
    <div class="table-wrap">
      <div class="table-scroll">
        <table class="table">
          ${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ''}
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${foot}
    </div>`;
}

/** Name + secondary line, the usual first cell of a record table. */
export function cellMain(title, sub = '') {
  return `
    <span class="cell-main">
      <span style="min-width:0">
        <span class="cell-title">${esc(title)}</span>
        ${sub ? `<span class="cell-sub" style="display:block">${esc(sub)}</span>` : ''}
      </span>
    </span>`;
}

/** Latin-numeral value (IDs, phones, money) — always rendered left-to-right. */
export function cellMono(value) {
  return `<span class="cell-mono">${esc(value || '—')}</span>`;
}

/**
 * The view / edit / delete cluster used at the end of every record row.
 * Each action is `{ iconName, title, href?, attrs?, variant? }`; pass only the
 * ones the signed-in role is allowed to perform.
 */
export function rowActions(actions) {
  return actions.filter(Boolean).map((action) => iconButton(action)).join('');
}

/** Count line above a table: "عرض 10 من 48 نازحاً" + optional trailing slot. */
export function resultBar({ count, total, noun = 'سجل', side = '' }) {
  return `
    <div class="result-bar">
      <p class="result-bar__count">
        عرض <strong>${count}</strong> من <strong>${total}</strong> ${esc(noun)}
      </p>
      ${side ? `<div class="u-flex u-gap-2 u-center">${side}</div>` : ''}
    </div>`;
}
