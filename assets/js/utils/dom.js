/**
 * DOM helpers.
 *
 * The whole prototype renders with tagged template literals. `html` escapes
 * every interpolated value by default; wrap a value in `raw()` to opt out.
 * That keeps mock data (which contains user-supplied-looking Arabic text)
 * from ever breaking the markup.
 */

const RAW = Symbol('raw');

/** Escape a value for safe insertion into HTML text or an attribute. */
export function esc(value) {
  if (value === null || value === undefined || value === false) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mark a string as pre-rendered HTML so `html` will not escape it. */
export function raw(value) {
  return { [RAW]: true, value: value === null || value === undefined ? '' : String(value) };
}

function interpolate(value) {
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (value && typeof value === 'object' && value[RAW]) return value.value;
  return esc(value);
}

/** Tagged template that returns an escaped HTML string. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += interpolate(values[i]) + strings[i + 1];
  }
  return out;
}

/** Compose child HTML fragments (already-escaped strings) into one raw value. */
export function fragment(parts) {
  return raw((Array.isArray(parts) ? parts : [parts]).join(''));
}

export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

export function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

/** Create an element from an HTML string (first root node). */
export function fromHTML(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Event delegation: fires when the event target is inside `selector`. */
export function delegate(root, type, selector, handler) {
  return on(root, type, (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

export function setHTML(target, markup) {
  const node = typeof target === 'string' ? qs(target) : target;
  if (node) node.innerHTML = markup;
  return node;
}

export function show(node, visible = true) {
  if (node) node.classList.toggle('u-hidden', !visible);
}

/** Focusable descendants, in tab order. */
export function focusables(scope) {
  return qsa(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    scope
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);
}

/** Trap Tab focus inside a container. Returns a cleanup function. */
export function trapFocus(container) {
  const handler = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables(container);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

/** Read the current query string as a plain object. */
export function params() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

/** Update the query string without reloading the page. */
export function setParams(next, { replace = true } = {}) {
  const search = new URLSearchParams(window.location.search);
  Object.entries(next).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') search.delete(key);
    else search.set(key, value);
  });
  const url = `${window.location.pathname}${search.toString() ? `?${search}` : ''}`;
  if (replace) window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Run a callback once the DOM is parsed. */
export function ready(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}
