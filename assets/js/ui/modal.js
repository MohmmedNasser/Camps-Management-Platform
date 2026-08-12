/**
 * Modal dialogs.
 *
 * `openModal` renders an accessible dialog (focus trap, Esc to close, scrim
 * click, body scroll lock). `confirmDialog` wraps it in a promise — every
 * destructive action in the app goes through it.
 */

import { trapFocus, focusables } from '../utils/dom.js';
import { esc } from '../utils/dom.js';
import { icon } from './icons.js';
import { button } from './components.js';

let openCount = 0;

function ensureRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
  }
  return root;
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {string} [options.body] raw HTML
 * @param {string} [options.footer] raw HTML; omit for a close-only dialog
 * @param {'md'|'lg'} [options.size]
 * @param {'default'|'danger'} [options.variant]
 * @param {boolean} [options.dismissible]
 * @returns {{element: HTMLElement, close: Function, onClose: Function}}
 */
export function openModal({
  title,
  description = '',
  body = '',
  footer = '',
  size = 'md',
  variant = 'default',
  dismissible = true,
} = {}) {
  const host = ensureRoot();
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-root';
  wrapper.innerHTML = `
    <div class="modal ${size === 'lg' ? 'modal--lg' : ''} ${variant === 'danger' ? 'modal--danger' : ''}"
         role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal__head">
        <div>
          <h2 class="modal__title" id="modal-title">${esc(title)}</h2>
          ${description ? `<p class="modal__desc">${esc(description)}</p>` : ''}
        </div>
        ${
          dismissible
            ? `<button type="button" class="modal__close" data-close aria-label="إغلاق">${icon('x', { size: 18 })}</button>`
            : ''
        }
      </div>
      ${body ? `<div class="modal__body">${body}</div>` : ''}
      ${footer ? `<div class="modal__foot">${footer}</div>` : ''}
    </div>`;

  host.appendChild(wrapper);

  const dialog = wrapper.querySelector('.modal');
  const previouslyFocused = document.activeElement;
  const listeners = [];
  let closed = false;

  const releaseTrap = trapFocus(dialog);

  function close(reason = 'dismiss') {
    if (closed) return;
    closed = true;
    wrapper.dataset.open = 'false';
    releaseTrap();
    document.removeEventListener('keydown', onKeydown);
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.classList.remove('is-locked');
    setTimeout(() => {
      wrapper.remove();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    }, 200);
    listeners.forEach((fn) => fn(reason));
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && dismissible) {
      event.stopPropagation();
      close('escape');
    }
  }

  wrapper.addEventListener('click', (event) => {
    if (event.target === wrapper && dismissible) close('scrim');
    if (event.target.closest('[data-close]')) close('close');
  });
  document.addEventListener('keydown', onKeydown);

  openCount += 1;
  document.body.classList.add('is-locked');

  // Next frame so the CSS transition runs.
  requestAnimationFrame(() => {
    wrapper.dataset.open = 'true';
    const first = focusables(dialog).find((node) => !node.hasAttribute('data-close'));
    (first || dialog.querySelector('[data-close]') || dialog).focus?.();
  });

  return {
    element: dialog,
    close,
    onClose(fn) {
      listeners.push(fn);
    },
  };
}

/**
 * Confirmation dialog. Resolves true when confirmed, false otherwise.
 * Used for every destructive action.
 */
export function confirmDialog({
  title = 'تأكيد العملية',
  text = '',
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  variant = 'danger',
} = {}) {
  return new Promise((resolve) => {
    let result = false;
    const modal = openModal({
      title,
      description: text,
      variant,
      footer: `
        ${button({ label: cancelLabel, variant: 'secondary', attrs: 'data-close' })}
        ${button({
          label: confirmLabel,
          variant: variant === 'danger' ? 'danger-solid' : 'primary',
          attrs: 'data-confirm',
        })}`,
    });

    modal.element.querySelector('[data-confirm]').addEventListener('click', () => {
      result = true;
      modal.close('confirm');
    });
    modal.onClose(() => resolve(result));
  });
}

/** Dialog whose body is a form. Resolves with FormData values, or null. */
export function formDialog({
  title,
  description = '',
  fields,
  submitLabel = 'حفظ',
  cancelLabel = 'إلغاء',
  validate,
  size = 'md',
}) {
  return new Promise((resolve) => {
    let result = null;
    const modal = openModal({
      title,
      description,
      size,
      body: `<form id="modal-form" class="field-grid" novalidate>${fields}</form>`,
      footer: `
        ${button({ label: cancelLabel, variant: 'secondary', attrs: 'data-close' })}
        ${button({ label: submitLabel, variant: 'primary', attrs: 'data-submit' })}`,
    });

    const form = modal.element.querySelector('#modal-form');

    const submit = () => {
      const values = Object.fromEntries(new FormData(form).entries());
      if (typeof validate === 'function') {
        const errors = validate(values) || {};
        form.querySelectorAll('.field').forEach((field) => {
          const name = field.dataset.field;
          const message = errors[name];
          field.dataset.state = message ? 'error' : '';
          const slot = field.querySelector('.field__msg--error');
          if (slot) slot.textContent = message || '';
        });
        if (Object.keys(errors).length) {
          form.querySelector('.field[data-state="error"] .input, .field[data-state="error"] .select')?.focus();
          return;
        }
      }
      result = values;
      modal.close('submit');
    };

    modal.element.querySelector('[data-submit]').addEventListener('click', submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    modal.onClose(() => resolve(result));
  });
}
