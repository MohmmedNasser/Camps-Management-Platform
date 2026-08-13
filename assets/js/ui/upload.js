/**
 * File picker with drag-and-drop and local previews.
 *
 * There is no server in this phase: a picked file is read into a data URL so
 * the preview is real, and the page decides whether to keep it. Large files
 * would blow the localStorage quota, so `readFile` returns the data URL only
 * for images below `INLINE_LIMIT` — everything else keeps name/size/type only,
 * which is all the document list actually renders.
 */

import { esc, qs, on } from '../utils/dom.js';
import { fileSize } from '../utils/format.js';
import { icon } from './icons.js';

/** Above this size the preview is dropped rather than stored (bytes). */
export const INLINE_LIMIT = 400 * 1024;

export const ACCEPTED = 'image/jpeg,image/png,image/webp,application/pdf';

/**
 * @param {{name?: string, title?: string, hint?: string, accept?: string,
 *          multiple?: boolean}} options
 */
export function dropzone({
  name = 'file',
  title = 'اسحب الملف إلى هنا أو اضغط للاختيار',
  hint = 'JPG أو PNG أو PDF — بحد أقصى 5 ميجابايت',
  accept = ACCEPTED,
  multiple = false,
} = {}) {
  return `
    <div class="field field--full" data-field="${esc(name)}">
      <div class="dropzone" data-dropzone tabindex="0" role="button"
        aria-label="${esc(title)}" aria-describedby="${esc(name)}-hint">
        <span class="dropzone__icon">${icon('upload', { size: 26 })}</span>
        <span class="dropzone__title">${esc(title)}</span>
        <span class="dropzone__hint" id="${esc(name)}-hint">${esc(hint)}</span>
        <input class="dropzone__input" type="file" id="${esc(name)}" name="${esc(name)}"
          accept="${esc(accept)}"${multiple ? ' multiple' : ''} tabindex="-1">
      </div>
      <div class="file-previews" data-previews hidden></div>
      <p class="field__msg field__msg--error" id="${esc(name)}-error" role="alert"></p>
    </div>`;
}

/** One preview tile — an image thumbnail, or a file glyph for everything else. */
export function filePreview(file, index = 0) {
  const thumb = file.dataUrl
    ? `<img class="file-preview__thumb" src="${esc(file.dataUrl)}" alt="${esc(file.name)}">`
    : `<span class="file-preview__placeholder">${icon(
        file.mime === 'application/pdf' ? 'fileText' : 'image',
        { size: 24 }
      )}</span>`;

  return `
    <div class="file-preview" data-preview-index="${index}">
      ${thumb}
      <div class="file-preview__meta">
        <span class="file-preview__name" title="${esc(file.name)}">${esc(file.name)}</span>
        <span>${esc(fileSize(file.size))}</span>
      </div>
      <button type="button" class="file-preview__remove" data-remove-file="${index}"
        aria-label="إزالة ${esc(file.name)}">${icon('x', { size: 14 })}</button>
    </div>`;
}

/**
 * Read one File into the shape the documents collection stores.
 * @returns {Promise<{name, size, mime, dataUrl}>}
 */
export function readFile(file) {
  const meta = { name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
  const isImage = file.type.startsWith('image/');

  if (!isImage || file.size > INLINE_LIMIT) {
    return Promise.resolve({ ...meta, dataUrl: '' });
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ ...meta, dataUrl: String(reader.result) });
    reader.onerror = () => resolve({ ...meta, dataUrl: '' });
    reader.readAsDataURL(file);
  });
}

/**
 * Wire a rendered dropzone.
 *
 * @param {HTMLElement} root
 * @param {{multiple?: boolean, maxSize?: number, onChange?: (files) => void}} options
 * @returns {{files: () => object[], clear: () => void}}
 */
export function initDropzone(root, { multiple = false, maxSize = 5 * 1024 * 1024, onChange } = {}) {
  const zone = qs('[data-dropzone]', root);
  if (!zone) return { files: () => [], clear: () => {} };

  const input = qs('.dropzone__input', zone);
  const previews = qs('[data-previews]', root);
  const errorSlot = qs('.field__msg--error', root);
  const field = zone.closest('.field');
  let picked = [];

  const setError = (message) => {
    if (field) field.dataset.state = message ? 'error' : '';
    if (errorSlot) errorSlot.textContent = message || '';
  };

  const paint = () => {
    if (!previews) return;
    previews.innerHTML = picked.map((file, index) => filePreview(file, index)).join('');
    previews.hidden = picked.length === 0;
    if (onChange) onChange(picked);
  };

  const accept = async (fileList) => {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const tooBig = incoming.find((file) => file.size > maxSize);
    if (tooBig) {
      setError(`الملف "${tooBig.name}" أكبر من الحد المسموح (${fileSize(maxSize)}).`);
      return;
    }

    setError('');
    const read = await Promise.all(incoming.map(readFile));
    picked = multiple ? [...picked, ...read] : read.slice(0, 1);
    paint();
  };

  // The input lives inside the zone, so its own click must not bounce back.
  on(zone, 'click', (event) => {
    if (event.target === input) return;
    input.click();
  });
  on(zone, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  on(input, 'change', () => accept(input.files));

  ['dragenter', 'dragover'].forEach((type) =>
    on(zone, type, (event) => {
      event.preventDefault();
      zone.dataset.dragover = 'true';
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    on(zone, type, (event) => {
      event.preventDefault();
      zone.dataset.dragover = 'false';
    })
  );
  on(zone, 'drop', (event) => accept(event.dataTransfer && event.dataTransfer.files));

  if (previews) {
    on(previews, 'click', (event) => {
      const remove = event.target.closest('[data-remove-file]');
      if (!remove) return;
      picked.splice(Number(remove.dataset.removeFile), 1);
      input.value = '';
      paint();
    });
  }

  return {
    files: () => picked,
    clear: () => {
      picked = [];
      input.value = '';
      setError('');
      paint();
    },
  };
}
