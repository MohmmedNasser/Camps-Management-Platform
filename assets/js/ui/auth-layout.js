/**
 * Shell for the signed-out screens (login, register, forgot password,
 * pending, rejected). Desktop shows a brand panel beside the form; mobile
 * shows the form alone with a centred logo.
 */

import { esc } from '../utils/dom.js';
import { icon } from './icons.js';
import { APP_NAME, APP_SHORT } from '../core/config.js';

const POINTS = [
  'سجل بيانات النازحين والأسر في مكان واحد',
  'تابع المساعدات والمؤسسات الداعمة',
  'راجع طلبات التسجيل واعتمدها بسهولة',
];

function brand({ inverse = false } = {}) {
  return `
    <div class="brand">
      <span class="brand__mark">${icon('logo', { size: 19 })}</span>
      <span class="brand__text">
        <span class="brand__name">${esc(APP_SHORT)}</span>
        <span class="brand__sub">${esc(inverse ? 'نظام موحّد لإدارة المخيمات' : 'تسجيل وإدارة النازحين')}</span>
      </span>
    </div>`;
}

/**
 * @param {{title: string, subtitle?: string, body: string, foot?: string,
 *          asideTitle?: string, asideText?: string}} options
 * @returns {string} full page markup for <body>
 */
export function authLayout({
  title,
  subtitle = '',
  body,
  foot = '',
  asideTitle = 'منصة موحّدة لإدارة مخيمات النازحين',
  asideText = 'أداة بسيطة وسريعة تساعد إدارات المخيمات على تسجيل النازحين وتنظيم الأسر وتوثيق المساعدات، وتمنح النازح متابعة واضحة لملفه.',
}) {
  return `
    <div class="auth">
      <aside class="auth__aside">
        ${brand({ inverse: true })}
        <div>
          <h2 class="auth__aside-title">${esc(asideTitle)}</h2>
          <p class="auth__aside-text">${esc(asideText)}</p>
          <ul class="auth__aside-points">
            ${POINTS.map(
              (point) => `
              <li class="auth__aside-point">${icon('checkCircle', { size: 18 })}<span>${esc(point)}</span></li>`
            ).join('')}
          </ul>
        </div>
        <p class="u-sm" style="color:rgba(255,255,255,.6)">${esc(APP_NAME)}</p>
      </aside>

      <div class="auth__body">
        <div class="auth__inner">
          <div class="auth__brand">${brand()}</div>
          <h1 class="auth__title">${esc(title)}</h1>
          ${subtitle ? `<p class="auth__subtitle">${esc(subtitle)}</p>` : ''}
          <div class="auth__card">${body}</div>
          ${foot ? `<p class="auth__foot">${foot}</p>` : ''}
        </div>
      </div>
    </div>`;
}

/** Centred status screen (pending / rejected / 404) — no form. */
export function statusLayout({ iconName, tone = 'info', title, text, actions = '', extra = '' }) {
  return `
    <div class="auth">
      <div class="auth__body">
        <div class="auth__inner" style="max-width:520px">
          <div class="auth__brand" style="display:flex">${brand()}</div>
          <div class="card">
            <div class="card__body u-text-center">
              <span class="status-icon status-icon--${esc(tone)}">${icon(iconName, { size: 30 })}</span>
              <h1 class="u-mt-4" style="font-size:var(--fs-h2)">${esc(title)}</h1>
              <p class="u-mt-3 u-secondary" style="margin-inline:auto;max-width:44ch">${esc(text)}</p>
              ${extra}
              ${actions ? `<div class="u-mt-6 u-flex u-gap-2 u-wrap" style="justify-content:center">${actions}</div>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}
