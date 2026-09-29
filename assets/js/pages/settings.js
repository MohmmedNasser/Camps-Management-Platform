/**
 * Settings.
 *
 * Notification and display preferences per account.
 */

import { delegate } from '../utils/dom.js';
import { formatNumber } from '../utils/format.js';
import { mountShell, applyDensity } from '../ui/layout.js';
import {
  button,
  card,
  badge,
  errorState,
  skeletonForm,
  pageHeader,
  definition,
  definitionList,
  statCard,
} from '../ui/components.js';
import { switchField } from '../ui/form.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { getOwnPreferences, updateOwnPreferences } from '../supabase/preferences.js';
import { getDashboardStatistics, getDocumentCount } from '../supabase/statistics.js';
import { ROLES, ROLE_LABELS, APP_NAME } from '../core/config.js';

const shell = await mountShell({ active: 'settings.html', title: 'الإعدادات' });
if (shell) init(shell);

/** get_dashboard_statistics() raises for a displaced caller (private.is_displaced()
 *  check), and "محتوى النظام" never renders for that role anyway — skip the
 *  fetch entirely rather than catching an expected error. */
async function loadStats(session) {
  if (session.role === ROLES.DISPLACED) return null;
  const campId = session.role === ROLES.CAMP_ADMIN ? session.campId : null;
  const [dashboard, documents] = await Promise.all([
    getDashboardStatistics(campId),
    getDocumentCount(campId),
  ]);
  return {
    displaced: Number(dashboard?.total_members) || 0,
    families: Number(dashboard?.total_families) || 0,
    aid: Number(dashboard?.aid_distributions) || 0,
    documents,
  };
}

async function init({ session, content }) {
  content.innerHTML = skeletonForm(4);

  try {
    const [preferences, stats] = await Promise.all([getOwnPreferences(), loadStats(session)]);
    content.innerHTML = view(session, { preferences, stats });
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
      description: 'تفضيلات الإشعارات والعرض.',
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

        ${
          isDisplaced
            ? ''
            : card({
                title: 'محتوى النظام',
                body: `<div class="grid grid--2">
            ${statCard({ label: 'النازحون', value: formatNumber(stats.displaced), iconName: 'users' })}
            ${statCard({ label: 'الأسر', value: formatNumber(stats.families), iconName: 'family', tone: 'success' })}
            ${statCard({ label: 'المساعدات', value: formatNumber(stats.aid), iconName: 'aid', tone: 'warning' })}
            ${statCard({ label: 'المستندات', value: formatNumber(stats.documents), iconName: 'folder' })}
          </div>`,
              })
        }

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
  delegate(content, 'change', '.switch__input', async (event, node) => {
    try {
      await updateOwnPreferences({ [node.name]: node.checked });
      if (node.name === 'denseTables') applyDensity(node.checked);
      toast.success('تم الحفظ', 'تم تحديث تفضيلاتك.');
    } catch (error) {
      console.error(error);
      node.checked = !node.checked;
      toast.error('تعذر الحفظ', 'حدث خطأ أثناء حفظ التفضيلات، حاول مرة أخرى.');
    }
  });
}
