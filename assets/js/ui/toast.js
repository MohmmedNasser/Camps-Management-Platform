/**
 * Toast notifications — brief confirmation after an action succeeds or fails.
 * Announced to screen readers via a polite live region.
 */

import { esc } from '../utils/dom.js';
import { icon } from './icons.js';

const ICONS = {
  success: 'checkCircle',
  error: 'alertCircle',
  warning: 'alertTriangle',
  info: 'info',
};

function region() {
  let node = document.getElementById('toast-region');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast-region';
    node.className = 'toast-region';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
  }
  return node;
}

function show(variant, title, text = '', duration = 3600) {
  const host = region();
  const node = document.createElement('div');
  node.className = `toast toast--${variant}`;
  node.innerHTML = `
    <span class="toast__icon">${icon(ICONS[variant] || 'info', { size: 18 })}</span>
    <div class="toast__body">
      <div class="toast__title">${esc(title)}</div>
      ${text ? `<div class="toast__text">${esc(text)}</div>` : ''}
    </div>
    <button type="button" class="modal__close" aria-label="إغلاق">${icon('x', { size: 15 })}</button>`;

  const dismiss = () => {
    if (node.dataset.closing) return;
    node.dataset.closing = 'true';
    setTimeout(() => node.remove(), 180);
  };

  node.querySelector('button').addEventListener('click', dismiss);
  host.appendChild(node);
  setTimeout(dismiss, duration);
  return dismiss;
}

export const toast = {
  success: (title, text) => show('success', title, text),
  error: (title, text) => show('error', title, text, 5000),
  warning: (title, text) => show('warning', title, text, 4500),
  info: (title, text) => show('info', title, text),
};

export default toast;
