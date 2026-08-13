/**
 * Settings.
 *
 * Notification preferences per account, plus the demo dataset controls that
 * make the prototype reviewable: restore the seed data, or empty it to inspect
 * every empty state in the app.
 */

import { delegate } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  alert,
  badge,
  errorState,
  skeletonForm,
  pageHeader,
  definition,
  definitionList,
} from '../ui/components.js';
import { switchField } from '../ui/form.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, ROLE_LABELS, APP_NAME } from '../core/config.js';

const shell = mountShell({ active: 'settings.html', title: 'الإعدادات' });
if (shell) init(shell);

async function init({ session, content }) {
  content.innerHTML = skeletonForm(4);

  try {
    const data = await store.load(() => ({
      preferences: store.preferences.get(session.id),
      stats: select.statistics(session),
    }));
    content.innerHTML = view(session, data);
    wire(content, session);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function view(session, { preferences, stats }) {
  const isDisplaced = session.role === ROLES.DISPLACED;

  return `
    ${pageHeader({
      title: 'الإعدادات',
      description: 'تفضيلات الإشعارات وبيانات النموذج التجريبي.',
    })}

    <div class="split">
      <div class="stack">
        ${card({
          title: 'الإشعارات',
          body: `
            <p class="u-sm u-secondary u-mb-4">اختر الأحداث التي تريد أن يصلك إشعار عنها داخل المنصة.</p>
            <div class="stack">
              ${switchField({
                name: 'notifyAid',
                label: isDisplaced ? 'مساعدة جديدة على ملفي' : 'تسجيل مساعدة جديدة',
                description: isDisplaced
                  ? 'إشعار عند إضافة مساعدة جديدة لك أو لأسرتك.'
                  : 'إشعار عند تسجيل مساعدة جديدة في المخيم.',
                checked: preferences.notifyAid,
              })}
              ${
                isDisplaced
                  ? ''
                  : switchField({
                      name: 'notifyRequests',
                      label: 'طلبات التسجيل الجديدة',
                      description: 'إشعار عند ورود طلب انضمام جديد إلى المخيم.',
                      checked: preferences.notifyRequests,
                    })
              }
              ${switchField({
                name: 'notifyMessages',
                label: isDisplaced ? 'ردود إدارة المخيم' : 'الرسائل الواردة',
                description: isDisplaced
                  ? 'إشعار عند رد الإدارة على رسالتك.'
                  : 'إشعار عند وصول رسالة جديدة من نازح.',
                checked: preferences.notifyMessages,
              })}
            </div>`,
        })}

        ${card({
          title: 'العرض',
          body: switchField({
            name: 'denseTables',
            label: 'عرض مضغوط للجداول',
            description: 'مسافات أقل بين صفوف الجداول لعرض عدد أكبر من السجلات.',
            checked: preferences.denseTables,
          }),
        })}

        ${card({
          title: 'بيانات النموذج التجريبي',
          body: `
            ${alert({
              variant: 'warning',
              title: 'نموذج أولي',
              text: 'هذه نسخة واجهة فقط: البيانات محفوظة في متصفحك ولا تُرسل إلى أي خادم. أي إعادة ضبط تؤثر على هذا الجهاز وحده.',
            })}
            <div class="row u-gap-3 u-wrap u-mt-4">
              ${button({ label: 'إعادة ضبط البيانات التجريبية', variant: 'secondary', iconName: 'refresh', attrs: 'data-reset' })}
              ${button({ label: 'إفراغ السجلات', variant: 'danger', iconName: 'trash', attrs: 'data-clear' })}
            </div>
            <p class="u-xs u-muted u-mt-3">
              «إعادة الضبط» تستعيد البيانات الأصلية، و«إفراغ السجلات» يمسح كل السجلات مع الإبقاء على المخيمات لمراجعة الحالات الفارغة.
            </p>`,
        })}
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'عن الحساب',
          body: definitionList([
            definition('الاسم', session.name),
            definition('البريد الإلكتروني', session.email),
            definition('الدور', ROLE_LABELS[session.role]),
            definition('النطاق', session.campLabel),
          ]),
          foot: button({
            label: 'الملف الشخصي',
            variant: 'secondary',
            iconName: 'user',
            href: pageUrl('profile.html'),
            block: true,
          }),
        })}

        ${card({
          title: 'محتوى النظام',
          body: definitionList([
            definition('النازحون', String(stats.displaced)),
            definition('الأسر', String(stats.families)),
            definition('المساعدات', String(stats.aid)),
            definition('المستندات', String(stats.documents)),
          ]),
        })}

        ${card({
          title: 'عن المنصة',
          body: `
            <p class="u-sm u-secondary">${APP_NAME}</p>
            <div class="row u-gap-2 u-wrap u-mt-3">
              ${badge('نموذج أولي للواجهة', 'info')}
              ${badge('الإصدار 1.0', 'neutral')}
            </div>`,
        })}
      </aside>
    </div>`;
}

function wire(content, session) {
  delegate(content, 'change', '.switch__input', (event, node) => {
    store.preferences.set(session.id, { [node.name]: node.checked });
    toast.success('تم الحفظ', 'تم تحديث تفضيلاتك.');
  });

  delegate(content, 'click', '[data-reset]', async () => {
    const ok = await confirmDialog({
      title: 'إعادة ضبط البيانات التجريبية',
      text: 'سيتم استعادة البيانات الأصلية وحذف كل ما أضفته أو عدّلته في هذه النسخة.',
      confirmLabel: 'إعادة الضبط',
    });
    if (!ok) return;
    store.resetDemoData();
    toast.success('تمت إعادة الضبط', 'تمت استعادة البيانات التجريبية الأصلية.');
    setTimeout(() => window.location.reload(), 600);
  });

  delegate(content, 'click', '[data-clear]', async () => {
    const ok = await confirmDialog({
      title: 'إفراغ السجلات',
      text: 'سيتم حذف النازحين والأسر والمساعدات والمستندات والرسائل، مع الإبقاء على المخيمات والحسابات.',
      confirmLabel: 'إفراغ السجلات',
    });
    if (!ok) return;
    store.clearRecords();
    toast.success('تم الإفراغ', 'أصبحت السجلات فارغة — يمكنك الآن مراجعة الحالات الفارغة.');
    setTimeout(() => window.location.reload(), 600);
  });
}
