/**
 * Form field renderers + a small validation controller.
 *
 * Fields are rendered as HTML strings (same as every other component) and
 * wired up afterwards by `bindForm`, which validates on submit and re-checks
 * a field once it has been touched.
 */

import { esc, qs, qsa, on } from '../utils/dom.js';
import { validate } from '../utils/validators.js';
import { icon } from './icons.js';

/* ---- Field renderers ---------------------------------------------------- */

function labelMarkup(name, label, required, optional) {
  return `
    <label class="label" for="${esc(name)}">
      ${esc(label)}
      ${required ? '<span class="label__required" aria-hidden="true">*</span>' : ''}
      ${optional ? '<span class="label__optional">(اختياري)</span>' : ''}
    </label>`;
}

function messagesMarkup(name, hint) {
  return `
    ${hint ? `<p class="field__hint" id="${esc(name)}-hint">${esc(hint)}</p>` : ''}
    <p class="field__msg field__msg--error" id="${esc(name)}-error" role="alert"></p>`;
}

function wrap(name, inner, { full = false, hint = '' } = {}) {
  return `<div class="field${full ? ' field--full' : ''}" data-field="${esc(name)}">${inner}${messagesMarkup(
    name,
    hint
  )}</div>`;
}

/**
 * Text-like input.
 * @param {{name, label, type?, value?, placeholder?, required?, optional?,
 *          hint?, full?, iconName?, mono?, inputMode?, autocomplete?, attrs?}} options
 */
export function inputField({
  name,
  label,
  type = 'text',
  value = '',
  placeholder = '',
  required = false,
  optional = false,
  hint = '',
  full = false,
  iconName = '',
  mono = false,
  inputMode = '',
  autocomplete = '',
  attrs = '',
}) {
  const control = `
    <input
      class="input${mono ? ' input--mono' : ''}"
      id="${esc(name)}"
      name="${esc(name)}"
      type="${esc(type)}"
      value="${esc(value)}"
      ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}
      ${inputMode ? `inputmode="${esc(inputMode)}"` : ''}
      ${autocomplete ? `autocomplete="${esc(autocomplete)}"` : ''}
      ${required ? 'aria-required="true"' : ''}
      ${hint ? `aria-describedby="${esc(name)}-hint"` : ''}
      ${attrs}>`;

  const inner =
    labelMarkup(name, label, required, optional) +
    (iconName
      ? `<div class="input-wrap"><span class="input-wrap__icon">${icon(iconName, { size: 17 })}</span>${control}</div>`
      : control);

  return wrap(name, inner, { full, hint });
}

/** Password input with a show/hide toggle. */
export function passwordField({ name, label, required = false, hint = '', autocomplete = 'current-password', full = false }) {
  const inner = `
    ${labelMarkup(name, label, required, false)}
    <div class="input-wrap input-wrap--action">
      <span class="input-wrap__icon">${icon('lock', { size: 17 })}</span>
      <input class="input" id="${esc(name)}" name="${esc(name)}" type="password"
        autocomplete="${esc(autocomplete)}" ${required ? 'aria-required="true"' : ''}
        ${hint ? `aria-describedby="${esc(name)}-hint"` : ''}>
      <button type="button" class="input-wrap__action" data-toggle-password="${esc(name)}"
        aria-label="إظهار كلمة المرور">${icon('eye', { size: 17 })}</button>
    </div>`;
  return wrap(name, inner, { full, hint });
}

/**
 * @param {{name, label, options: {value,label}[], value?, required?, optional?,
 *          placeholder?, hint?, full?}} config
 */
export function selectField({
  name,
  label,
  options,
  value = '',
  required = false,
  optional = false,
  placeholder = 'اختر...',
  hint = '',
  full = false,
  attrs = '',
}) {
  const choices = options
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${option.value === value ? ' selected' : ''}>${esc(
          option.label
        )}</option>`
    )
    .join('');

  const inner = `
    ${labelMarkup(name, label, required, optional)}
    <select class="select" id="${esc(name)}" name="${esc(name)}" ${required ? 'aria-required="true"' : ''}
      ${hint ? `aria-describedby="${esc(name)}-hint"` : ''} ${attrs}>
      <option value="">${esc(placeholder)}</option>
      ${choices}
    </select>`;

  return wrap(name, inner, { full, hint });
}

export function textareaField({
  name,
  label,
  value = '',
  placeholder = '',
  required = false,
  optional = false,
  hint = '',
  rows = 4,
  full = true,
}) {
  const inner = `
    ${labelMarkup(name, label, required, optional)}
    <textarea class="textarea" id="${esc(name)}" name="${esc(name)}" rows="${rows}"
      ${placeholder ? `placeholder="${esc(placeholder)}"` : ''}
      ${required ? 'aria-required="true"' : ''}
      ${hint ? `aria-describedby="${esc(name)}-hint"` : ''}>${esc(value)}</textarea>`;
  return wrap(name, inner, { full, hint });
}

export function checkboxField({ name, label, description = '', checked = false, full = true }) {
  const inner = `
    <label class="check" for="${esc(name)}">
      <input class="check__input" type="checkbox" id="${esc(name)}" name="${esc(name)}"${checked ? ' checked' : ''}>
      <span class="check__body">
        <span class="check__title">${esc(label)}</span>
        ${description ? `<span class="check__desc">${esc(description)}</span>` : ''}
      </span>
    </label>`;
  return wrap(name, inner, { full });
}

export function switchField({ name, label, description = '', checked = false }) {
  return `
    <label class="switch" for="${esc(name)}">
      <span>
        <span class="u-medium" style="display:block">${esc(label)}</span>
        ${description ? `<span class="u-sm u-secondary">${esc(description)}</span>` : ''}
      </span>
      <input class="switch__input" type="checkbox" id="${esc(name)}" name="${esc(name)}"${checked ? ' checked' : ''}>
    </label>`;
}

export function radioCards({ name, label, options, value = '', required = false, full = true }) {
  const cards = options
    .map(
      (option, index) => `
      <label class="radio-card" for="${esc(name)}-${index}">
        <input class="check__input" type="radio" id="${esc(name)}-${index}" name="${esc(name)}"
          value="${esc(option.value)}"${option.value === value ? ' checked' : ''}>
        <span class="check__body">
          <span class="check__title">${esc(option.label)}</span>
          ${option.description ? `<span class="check__desc">${esc(option.description)}</span>` : ''}
        </span>
      </label>`
    )
    .join('');

  const inner = `
    <span class="label">${esc(label)}${required ? '<span class="label__required">*</span>' : ''}</span>
    <div class="radio-cards" role="radiogroup" aria-label="${esc(label)}">${cards}</div>`;

  return wrap(name, inner, { full });
}

/** Section wrapper used by the long create/edit forms. */
export function fieldset({ legend, hint = '', fields, columns = 2 }) {
  return `
    <fieldset class="fieldset">
      <legend class="fieldset__legend">${esc(legend)}</legend>
      ${hint ? `<p class="fieldset__hint">${esc(hint)}</p>` : ''}
      <div class="field-grid${columns === 3 ? ' field-grid--3' : ''}">${fields.join('')}</div>
    </fieldset>`;
}

/* ---- Controller --------------------------------------------------------- */

/** Read a form into a plain object, with checkboxes as booleans. */
export function readForm(form) {
  const values = {};
  qsa('input, select, textarea', form).forEach((node) => {
    if (!node.name) return;
    if (node.type === 'checkbox') values[node.name] = node.checked;
    else if (node.type === 'radio') {
      if (node.checked) values[node.name] = node.value;
      else if (!(node.name in values)) values[node.name] = '';
    } else values[node.name] = node.value;
  });
  return values;
}

export function setFieldError(form, name, message) {
  const field = qs(`.field[data-field="${CSS.escape(name)}"]`, form);
  if (!field) return;
  field.dataset.state = message ? 'error' : '';
  const slot = qs('.field__msg--error', field);
  if (slot) slot.textContent = message || '';
  const control = qs('.input, .select, .textarea, .check__input', field);
  if (control) {
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) control.setAttribute('aria-describedby', `${name}-error`);
  }
}

export function clearErrors(form) {
  qsa('.field', form).forEach((field) => {
    field.dataset.state = '';
    const slot = qs('.field__msg--error', field);
    if (slot) slot.textContent = '';
  });
}

/**
 * Wire validation to a form.
 *
 * @param {HTMLFormElement} form
 * @param {object} options
 * @param {Record<string, Function[]>} options.schema
 * @param {(values: object) => (void|Promise<void>)} options.onSubmit
 * @returns {{validateNow: Function}}
 */
export function bindForm(form, { schema = {}, onSubmit }) {
  const touched = new Set();

  // Password visibility toggles
  qsa('[data-toggle-password]', form).forEach((toggle) =>
    on(toggle, 'click', () => {
      const input = qs(`#${CSS.escape(toggle.dataset.togglePassword)}`, form);
      if (!input) return;
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      toggle.setAttribute('aria-label', visible ? 'إظهار كلمة المرور' : 'إخفاء كلمة المرور');
    })
  );

  const runValidation = (only = null) => {
    const values = readForm(form);
    const errors = validate(values, schema);
    const names = only ? [only] : Object.keys(schema);
    names.forEach((name) => {
      if (only && !touched.has(name)) return;
      setFieldError(form, name, errors[name] || '');
    });
    return { values, errors };
  };

  on(form, 'blur', (event) => {
    const name = event.target.name;
    if (!name || !schema[name]) return;
    touched.add(name);
    runValidation(name);
  }, true);

  on(form, 'input', (event) => {
    const name = event.target.name;
    if (!name || !touched.has(name)) return;
    runValidation(name);
  });

  on(form, 'submit', async (event) => {
    event.preventDefault();
    Object.keys(schema).forEach((name) => touched.add(name));
    const { values, errors } = runValidation();

    if (Object.keys(errors).length) {
      const first = qs('.field[data-state="error"]', form);
      if (first) {
        first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        qs('.input, .select, .textarea, .check__input', first)?.focus();
      }
      return;
    }

    const submitButton = qs('[type="submit"]', form);
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.dataset.originalHtml = submitButton.innerHTML;
      submitButton.innerHTML = `<span class="btn__spinner"></span><span>جارٍ الحفظ…</span>`;
    }

    try {
      await onSubmit(values);
    } finally {
      if (submitButton && document.body.contains(submitButton)) {
        submitButton.disabled = false;
        submitButton.innerHTML = submitButton.dataset.originalHtml;
      }
    }
  });

  return { validateNow: runValidation };
}
