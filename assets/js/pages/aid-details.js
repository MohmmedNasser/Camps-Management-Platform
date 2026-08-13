/**
 * One aid record.
 * Visible to the family it belongs to; editable only by a Camp Admin.
 */

import { esc, params, delegate } from '../utils/dom.js';
import { formatDate, formatCurrency, formatDateTime } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  badge,
  emptyState,
  errorState,
  skeletonForm,
  pageHeader,
  breadcrumb,
  definition,
  definitionList,
} from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, labelOf, AID_TYPES } from '../core/config.js';

const shell = mountShell({ active: 'aid.html', title: 'تفاصيل المساعدة' });
if (shell) init(shell);

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonForm(6);

  try {
    const data = await store.load(() => collect(session, id));

    if (!data.record) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'سجل المساعدة غير موجود',
        text: 'قد يكون محذوفاً أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى المساعدات', variant: 'primary', href: pageUrl('aid.html') }),
      });
      return;
    }

    content.innerHTML = view(session, data);
    wire(content, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(session, id) {
  const raw = store.aid.get(id);
  if (!raw) return { record: null };

  // Camp Admin: own camp only. Displaced: own family or own record only.
  if (session.role === ROLES.CAMP_ADMIN && raw.campId !== session.campId) return { record: null };
  if (session.role === ROLES.DISPLACED) {
    const person = store.displaced.get(session.displacedId);
    const own = person && (raw.familyId === person.familyId || raw.displacedId === person.id);
    if (!own) return { record: null };
  }

  return {
    record: select.aidRow(raw),
    family: raw.familyId ? select.familyWithStats(raw.familyId) : null,
    person: store.displaced.get(raw.displacedId),
    createdByName: (store.users.get(raw.createdBy) || {}).name || '—',
    siblings: select
      .searchAid({ familyId: raw.familyId })
      .filter((row) => row.id !== raw.id)
      .slice(0, 5),
  };
}

function view(session, { record, family, person, createdByName, siblings }) {
  const typeIcon = (AID_TYPES.find((type) => type.value === record.type) || {}).icon || 'aid';

  return `
    ${breadcrumb([
      { label: session.role === ROLES.DISPLACED ? 'مساعداتي' : 'المساعدات', href: pageUrl('aid.html') },
      { label: record.typeLabel },
    ])}
    ${pageHeader({
      title: `${record.typeLabel} — ${record.organizationName}`,
      description: `تم التسليم في ${formatDate(record.date)}`,
      actions: `
        ${
          can('aid:update')
            ? button({
                label: 'تعديل',
                variant: 'secondary',
                iconName: 'edit',
                href: pageUrl('aid-edit.html', { id: record.id }),
              })
            : ''
        }
        ${
          can('aid:delete')
            ? button({ label: 'حذف', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
            : ''
        }`,
    })}

    <div class="split">
      <div class="stack">
        ${card({
          title: 'تفاصيل المساعدة',
          body: definitionList([
            definition('نوع المساعدة', labelOf(AID_TYPES, record.type)),
            definition('المؤسسة المانحة', record.organizationName),
            definition('الكمية', record.quantity),
            definition('القيمة التقديرية', formatCurrency(record.value)),
            definition('تاريخ التسليم', formatDate(record.date)),
            definition('المخيم', record.campName),
            definition('سُجّلت بواسطة', createdByName),
            definition('تاريخ التسجيل', record.createdAt ? formatDateTime(record.createdAt) : '—'),
          ]),
        })}

        ${
          record.notes
            ? card({ title: 'ملاحظات', body: `<p class="u-secondary">${esc(record.notes)}</p>` })
            : ''
        }

        ${card({
          title: 'مساعدات أخرى لنفس الأسرة',
          flush: true,
          body: siblings.length
            ? `<div class="list">${siblings
                .map(
                  (row) => `
                <a class="list__row" href="${pageUrl('aid-details.html', { id: row.id })}">
                  <span class="list__main">
                    <span class="list__title">${esc(row.typeLabel)} — ${esc(row.organizationName)}</span>
                    <span class="list__meta">${esc(formatDate(row.date))}</span>
                  </span>
                  <span class="list__side">
                    <span class="mono u-sm">${esc(formatCurrency(row.value))}</span>
                    ${icon('chevronLeft', { size: 16 })}
                  </span>
                </a>`
                )
                .join('')}</div>`
            : emptyState({
                iconName: 'aid',
                title: 'لا توجد مساعدات أخرى',
                text: 'هذه أول مساعدة مسجلة لهذه الأسرة.',
              }),
        })}
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'المستفيد',
          body: definitionList([
            definition('المستلم', person ? person.fullName : '—'),
            definition('رقم الهوية', person ? person.nationalId : '', { mono: true }),
            definition('رقم الأسرة', record.familyId, { mono: true }),
            definition('رب الأسرة', family ? family.headName : '—'),
            definition('عدد أفراد الأسرة', family ? String(family.membersCount) : '—'),
          ]),
          foot: family
            ? button({
                label: 'ملف الأسرة',
                variant: 'secondary',
                iconName: 'family',
                href: pageUrl('family-details.html', { id: family.id }),
                block: true,
              })
            : '',
        })}

        ${card({
          title: 'التصنيف',
          body: `
            <div class="u-flex u-gap-3 u-center">
              <span class="stat__icon">${icon(typeIcon, { size: 20 })}</span>
              <div>
                <div class="u-medium">${esc(record.typeLabel)}</div>
                <div class="u-xs u-muted">${esc(record.organizationName)}</div>
              </div>
            </div>
            <div class="u-mt-4">${badge(formatCurrency(record.value), 'info')}</div>`,
        })}
      </aside>
    </div>`;
}

function wire(content, { record }) {
  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل المساعدة',
      text: `سيتم حذف "${record.typeLabel}" المسجلة بتاريخ ${formatDate(record.date)} نهائياً.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.aid.remove(record.id);
    toast.success('تم الحذف', 'تم حذف سجل المساعدة.');
    go('aid.html');
  });
}
