/**
 * Presentational building blocks.
 *
 * Every function returns an HTML string — no DOM, no data access. These are
 * the vanilla equivalents of the React components the Next.js port will have.
 */

import { html, raw, esc } from '../utils/dom.js';
import { initials } from '../utils/format.js';
import { icon } from './icons.js';
import { STATUS_LABELS, STATUS_VARIANTS } from '../core/config.js';

/* ---- Buttons ---------------------------------------------------------- */

export function button({
  label,
  variant = 'secondary',
  size = 'md',
  iconName = '',
  iconAfter = false,
  href = '',
  type = 'button',
  block = false,
  disabled = false,
  attrs = '',
  className = '',
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    block ? 'btn--block' : '',
    !label ? 'btn--icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const glyph = iconName ? icon(iconName, { size: size === 'sm' ? 15 : 17 }) : '';
  const text = label ? esc(label) : '';
  const inner = iconAfter ? `${text}${glyph}` : `${glyph}${text}`;

  if (href) {
    return `<a class="${classes}" href="${esc(href)}"${disabled ? ' aria-disabled="true"' : ''} ${attrs}>${inner}</a>`;
  }
  return `<button class="${classes}" type="${esc(type)}"${disabled ? ' disabled' : ''} ${attrs}>${inner}</button>`;
}

export function iconButton({ iconName, title, variant = '', attrs = '', href = '' }) {
  const classes = ['icon-btn', variant ? `icon-btn--${variant}` : ''].filter(Boolean).join(' ');
  const inner = `${icon(iconName, { size: 17 })}<span class="sr-only">${esc(title)}</span>`;
  if (href) return `<a class="${classes}" href="${esc(href)}" title="${esc(title)}" ${attrs}>${inner}</a>`;
  return `<button class="${classes}" type="button" title="${esc(title)}" ${attrs}>${inner}</button>`;
}

/* ---- Badges & chips --------------------------------------------------- */

export function badge(label, variant = 'neutral') {
  return html`<span class="badge badge--${raw(variant)}">${label}</span>`;
}

/** Badge for an account/record status value from config.STATUS. */
export function statusBadge(status) {
  const label = STATUS_LABELS[status] || status || '—';
  const variant = STATUS_VARIANTS[status] || 'neutral';
  return badge(label, variant);
}

export function chip(label, { active = false, outline = false, attrs = '', as = 'span' } = {}) {
  const classes = ['chip', active ? 'chip--active' : '', outline ? 'chip--outline' : '']
    .filter(Boolean)
    .join(' ');
  if (as === 'button') {
    return `<button type="button" class="${classes}" ${attrs}>${esc(label)}</button>`;
  }
  return `<span class="${classes}" ${attrs}>${esc(label)}</span>`;
}

export function tag(label) {
  return html`<span class="tag">${label}</span>`;
}

/* ---- Avatar ----------------------------------------------------------- */

export function avatar(name, { size = '' } = {}) {
  const classes = ['avatar', size ? `avatar--${size}` : ''].filter(Boolean).join(' ');
  return `<span class="${classes}" aria-hidden="true">${esc(initials(name))}</span>`;
}

/* ---- Cards ------------------------------------------------------------ */

export function card({ title = '', action = '', body, flush = false, foot = '', className = '' }) {
  const head = title
    ? `<div class="card__head"><h2 class="card__title">${esc(title)}</h2>${action}</div>`
    : '';
  return `
    <section class="card ${className}">
      ${head}
      <div class="card__body${flush ? ' card__body--flush' : ''}">${body}</div>
      ${foot ? `<div class="card__foot">${foot}</div>` : ''}
    </section>`;
}

export function statCard({ label, value, iconName = 'chart', tone = '', meta = '', href = '' }) {
  const inner = `
    <span class="stat__icon${tone ? ` stat__icon--${tone}` : ''}">${icon(iconName, { size: 20 })}</span>
    <span class="stat__body">
      <span class="stat__label">${esc(label)}</span>
      <span class="stat__value">${esc(value)}</span>
      ${meta ? `<span class="stat__meta">${esc(meta)}</span>` : ''}
    </span>`;
  if (href) return `<a class="stat" href="${esc(href)}">${inner}</a>`;
  return `<div class="stat">${inner}</div>`;
}

/* ---- Alerts ----------------------------------------------------------- */

const ALERT_ICONS = {
  info: 'info',
  success: 'checkCircle',
  warning: 'alertTriangle',
  error: 'alertCircle',
};

export function alert({ variant = 'info', title = '', text = '', attrs = '' }) {
  return `
    <div class="alert alert--${esc(variant)}" role="${variant === 'error' ? 'alert' : 'status'}" ${attrs}>
      <span class="alert__icon">${icon(ALERT_ICONS[variant] || 'info', { size: 18 })}</span>
      <div class="alert__body">
        ${title ? `<div class="alert__title">${esc(title)}</div>` : ''}
        ${text ? `<div class="alert__text">${esc(text)}</div>` : ''}
      </div>
    </div>`;
}

/* ---- Empty & error states --------------------------------------------- */

export function emptyState({ iconName = 'inboxEmpty', title, text = '', actions = '' }) {
  return `
    <div class="empty">
      <span class="empty__icon">${icon(iconName, { size: 28 })}</span>
      <h3 class="empty__title">${esc(title)}</h3>
      ${text ? `<p class="empty__text">${esc(text)}</p>` : ''}
      ${actions ? `<div class="empty__actions">${actions}</div>` : ''}
    </div>`;
}

export function errorState({
  title = 'حدث خطأ أثناء تحميل البيانات',
  text = 'تعذر إكمال العملية، حاول مرة أخرى.',
  retryAttrs = '',
} = {}) {
  return `
    <div class="empty empty--error">
      <span class="empty__icon">${icon('alertTriangle', { size: 28 })}</span>
      <h3 class="empty__title">${esc(title)}</h3>
      <p class="empty__text">${esc(text)}</p>
      <div class="empty__actions">
        ${button({ label: 'إعادة المحاولة', variant: 'secondary', iconName: 'refresh', attrs: retryAttrs })}
      </div>
    </div>`;
}

/* ---- Skeletons -------------------------------------------------------- */

export function skeletonLine(width = '100%') {
  return `<div class="skeleton skeleton--text" style="width:${esc(width)}"></div>`;
}

export function skeletonStats(count = 4) {
  return Array.from({ length: count })
    .map(
      () => `
      <div class="skeleton-card">
        <div class="u-flex u-gap-3">
          <div class="skeleton skeleton--avatar"></div>
          <div class="u-grow skeleton-stack">
            ${skeletonLine('60%')}
            ${skeletonLine('40%')}
          </div>
        </div>
      </div>`
    )
    .join('');
}

export function skeletonTable(rows = 6) {
  const row = `
    <div class="list__row">
      <div class="u-flex u-gap-3 u-grow">
        <div class="skeleton skeleton--avatar"></div>
        <div class="u-grow skeleton-stack">
          ${skeletonLine('45%')}
          ${skeletonLine('28%')}
        </div>
      </div>
      <div class="skeleton skeleton--chip"></div>
    </div>`;
  return `<div class="table-wrap">${Array.from({ length: rows }).map(() => row).join('')}</div>`;
}

export function skeletonCards(count = 6) {
  const item = `
    <div class="skeleton-card skeleton-stack">
      ${skeletonLine('55%')}
      ${skeletonLine('80%')}
      ${skeletonLine('35%')}
    </div>`;
  return `<div class="card-grid">${Array.from({ length: count }).map(() => item).join('')}</div>`;
}

export function skeletonForm(fields = 6) {
  const field = `
    <div class="field">
      <div class="skeleton skeleton--text" style="width:35%"></div>
      <div class="skeleton" style="height:44px;border-radius:6px"></div>
    </div>`;
  return `<div class="field-grid">${Array.from({ length: fields }).map(() => field).join('')}</div>`;
}

export function skeletonChart() {
  return `<div class="skeleton skeleton--block"></div>`;
}

export function skeletonProfile() {
  return `
    <div class="skeleton-card">
      <div class="u-flex u-gap-4">
        <div class="skeleton" style="width:80px;height:80px;border-radius:50%"></div>
        <div class="u-grow skeleton-stack">
          ${skeletonLine('50%')}
          ${skeletonLine('30%')}
          ${skeletonLine('40%')}
        </div>
      </div>
    </div>`;
}

/* ---- Definitions (detail rows) ---------------------------------------- */

export function definition(label, value, { mono = false } = {}) {
  const empty = value === null || value === undefined || value === '' || value === '—';
  const classes = ['definition__value', empty ? 'definition__value--empty' : '', mono ? 'mono' : '']
    .filter(Boolean)
    .join(' ');
  return `
    <div class="definition">
      <dt class="definition__label">${esc(label)}</dt>
      <dd class="${classes}">${esc(empty ? '—' : value)}</dd>
    </div>`;
}

export function definitionList(items) {
  return `<dl class="definitions">${items.join('')}</dl>`;
}

/* ---- Page furniture --------------------------------------------------- */

export function breadcrumb(items) {
  const parts = items.map((item, index) => {
    const last = index === items.length - 1;
    const node = last || !item.href
      ? `<span aria-current="page">${esc(item.label)}</span>`
      : `<a href="${esc(item.href)}">${esc(item.label)}</a>`;
    const sep = last ? '' : `<span class="breadcrumb__sep">${icon('chevronLeft', { size: 13 })}</span>`;
    return node + sep;
  });
  return `<nav class="breadcrumb" aria-label="مسار التنقل">${parts.join('')}</nav>`;
}

export function pageHeader({ title, description = '', actions = '' }) {
  return `
    <header class="page-header">
      <div class="page-header__main">
        <h1 class="page-header__title">${esc(title)}</h1>
        ${description ? `<p class="page-header__desc">${esc(description)}</p>` : ''}
      </div>
      ${actions ? `<div class="page-header__actions">${actions}</div>` : ''}
    </header>`;
}

/* ---- Pagination ------------------------------------------------------- */

/** Page numbers with ellipsis, e.g. 1 … 4 [5] 6 … 12 */
function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current, current - 1, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= total - 2) [total - 1, total - 2, total - 3].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) out.push('…');
    out.push(page);
  });
  return out;
}

export function pagination({ page, pageSize, total }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const buttons = pageWindow(page, pages)
    .map((item) => {
      if (item === '…') return `<span class="pagination__ellipsis">…</span>`;
      const current = item === page;
      return `<button type="button" class="pagination__btn" data-page="${item}"${
        current ? ' aria-current="page"' : ''
      }>${item}</button>`;
    })
    .join('');

  return `
    <nav class="pagination" aria-label="تنقل بين الصفحات">
      <p class="pagination__info">عرض <strong>${from}</strong>–<strong>${to}</strong> من <strong>${total}</strong></p>
      <div class="pagination__pages">
        <button type="button" class="pagination__btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="الصفحة السابقة">${icon('chevronRight', { size: 15 })}</button>
        ${buttons}
        <button type="button" class="pagination__btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="الصفحة التالية">${icon('chevronLeft', { size: 15 })}</button>
      </div>
    </nav>`;
}

/* ---- Tabs ------------------------------------------------------------- */

export function tabs(items, activeId) {
  const buttons = items
    .map(
      (item) => `
      <button type="button" class="tab" role="tab" id="tab-${esc(item.id)}"
        aria-controls="panel-${esc(item.id)}" aria-selected="${item.id === activeId}"
        data-tab="${esc(item.id)}">${esc(item.label)}</button>`
    )
    .join('');
  return `<div class="tabs" role="tablist">${buttons}</div>`;
}

export function tabPanel(id, content, active) {
  return `<div class="tab-panel" role="tabpanel" id="panel-${esc(id)}" aria-labelledby="tab-${esc(id)}"${
    active ? '' : ' hidden'
  }>${content}</div>`;
}

/** Wire up a tab group rendered by `tabs()` + `tabPanel()`. */
export function initTabs(scope = document) {
  const list = scope.querySelector('.tabs');
  if (!list) return;
  list.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-tab]');
    if (!trigger) return;
    const id = trigger.dataset.tab;
    scope.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === id));
    });
    scope.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.hidden = panel.id !== `panel-${id}`;
    });
  });
  list.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const items = Array.from(list.querySelectorAll('[data-tab]'));
    const index = items.indexOf(document.activeElement);
    if (index === -1) return;
    // RTL: ArrowLeft advances forward
    const delta = event.key === 'ArrowLeft' ? 1 : -1;
    const next = items[(index + delta + items.length) % items.length];
    next.focus();
    next.click();
  });
}

/* ---- Bar list (lightweight chart substitute) -------------------------- */

export function barList(items) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return `
    <div class="bar-list">
      ${items
        .map(
          (item) => `
        <div class="bar-list__item">
          <div class="bar-list__head">
            <span class="bar-list__label">${esc(item.label)}</span>
            <span class="bar-list__value">${esc(item.display ?? item.value)}</span>
          </div>
          <div class="progress"><div class="progress__bar" style="width:${Math.round(
            (item.value / max) * 100
          )}%${item.color ? `;background:${esc(item.color)}` : ''}"></div></div>
        </div>`
        )
        .join('')}
    </div>`;
}
