/**
 * One aid record.
 * Visible to the family it belongs to; editable only by a Camp Admin.
 */

import { esc, params, delegate } from '../utils/dom.js';
import { formatDate, formatDateTime, formatPhone } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  emptyState,
  errorState,
  skeletonForm,
  pageHeader,
  breadcrumb,
  definition,
  definitionList,
} from '../ui/components.js';
import { inputField } from '../ui/form.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, AID_TYPES } from '../core/config.js';
import { getAidDistribution, getSiblingDistributions, deleteAidDistribution } from '../supabase/aids.js';

const shell = await mountShell({ active: 'aid.html', title: 'تفاصيل المساعدة' });
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
    wire(content, session, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(session, id) {
  if (session.role === ROLES.CAMP_ADMIN) return collectReal(session, id);

  const raw = store.aid.get(id);
  if (!raw) return { record: null };

  return {
    record: select.aidRow(raw),
    donor: store.organizations.get(raw.organizationId),
    createdByName: (store.users.get(raw.createdBy) || {}).name || '—',
    // Other distributions sharing at least one beneficiary family with this one.
    siblings: dedupeById(
      (raw.familyIds || []).flatMap((familyId) => select.searchAid({ familyId }))
    )
      .filter((row) => row.id !== raw.id)
      .slice(0, 5),
  };
}

/**
 * `record.campId !== session.campId` is redundant, UX-only narrowing — RLS
 * on `aid_distributions` (`aid_distributions_select_scoped`) already
 * prevents `getAidDistribution()` from returning another camp's row at all
 * (Phase 4.6 spec, same convention as `displaced-details.js`'s
 * `collectReal()`).
 */
async function collectReal(session, id) {
  const record = await getAidDistribution(id);
  if (!record || record.campId !== session.campId) return { record: null };

  const siblings = await getSiblingDistributions(record.familyDbIds, record.id);

  return {
    record: { ...record, campName: session.campLabel },
    donor: record.donor,
    createdByName: record.createdByName,
    siblings: siblings.map((row) => ({ ...row, campName: session.campLabel })),
  };
}

function dedupeById(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

function view(session, { record, donor, createdByName, siblings }) {
  const typeIcon = (AID_TYPES.find((type) => type.value === (record.types || [])[0]) || {}).icon || 'aid';

  return `
    ${breadcrumb([
      { label: 'المساعدات', href: pageUrl('aid.html') },
      { label: record.typeLabels || 'مساعدة' },
    ])}
    ${pageHeader({
      title: `${record.typeLabels} — ${record.organizationName}`,
      description: `تم التوزيع في ${formatDate(record.date)} · ${record.beneficiaryCount} أسرة مستفيدة`,
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
          title: 'المساعدة الموزَّعة',
          body: `
            ${definitionList([
              definition('نوع المساعدة', record.typeLabels || '—'),
              definition('الجهة المانحة', record.organizationName),
              definition('عدد الأسر المستفيدة', String(record.beneficiaryCount)),
              definition('تاريخ التوزيع', formatDate(record.date)),
              definition('المخيم', record.campName),
              definition('سُجّلت بواسطة', createdByName),
              definition('تاريخ التسجيل', record.createdAt ? formatDateTime(record.createdAt) : '—'),
            ])}`,
        })}

        ${card({
          title: 'مساعدات أخرى لهذه الأسر',
          flush: true,
          body: siblings.length
            ? `<div class="list">${siblings
                .map(
                  (row) => `
                <a class="list__row" href="${pageUrl('aid-details.html', { id: row.id })}">
                  <span class="list__main">
                    <span class="list__title">${esc(row.typeLabels || '—')} — ${esc(row.organizationName)}</span>
                    <span class="list__meta">${esc(formatDate(row.date))} · ${row.beneficiaryCount} أسرة مستفيدة</span>
                  </span>
                  <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
                </a>`
                )
                .join('')}</div>`
            : emptyState({
                iconName: 'aid',
                title: 'لا توجد مساعدات أخرى',
                text: 'لم تتلقَّ هذه الأسر مساعدات أخرى بعد.',
              }),
        })}
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'الجهة المانحة',
          body: `
            <div class="u-flex u-gap-3 u-center u-mb-4">
              <span class="stat__icon">${icon(typeIcon, { size: 20 })}</span>
              <div>
                <div class="u-medium">${esc(record.organizationName)}</div>
                <div class="u-xs u-muted">${esc(record.typeLabels || '—')}</div>
              </div>
            </div>
            ${definitionList([
              definition('الاسم', record.organizationName),
              definition('الشخص المسؤول', donor ? donor.responsiblePerson : ''),
              definition('رقم الجوال', donor ? formatPhone(donor.phone) : '', { mono: true }),
            ])}`,
        })}

        ${card({
          title: `الأسر المستفيدة (${record.beneficiaryCount})`,
          flush: true,
          body: `
            <div class="u-p-4">
              ${inputField({
                name: 'beneficiary-search',
                label: 'بحث',
                value: '',
                placeholder: 'ابحث برقم الأسرة أو رب الأسرة…',
              })}
            </div>
            <div class="list" id="beneficiary-list">
              ${(record.beneficiaries || [])
                .map(
                  (row) => `
                <a class="list__row" data-beneficiary-row
                   href="${pageUrl('family-details.html', { id: row.familyId })}">
                  <span class="list__main">
                    <span class="list__title">${esc(row.familyId)}</span>
                    <span class="list__meta">${esc(row.headName)}</span>
                  </span>
                  <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
                </a>`
                )
                .join('')}
            </div>`,
        })}
      </aside>
    </div>`;
}

function wire(content, session, { record }) {
  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل المساعدة',
      text: `سيتم حذف "${record.typeLabels || 'المساعدة'}" المسجلة بتاريخ ${formatDate(record.date)} نهائياً.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;

    if (session.role === ROLES.CAMP_ADMIN) {
      try {
        const deleted = await deleteAidDistribution(record.id);
        if (!deleted) {
          toast.error('تعذر الحذف', 'قد لا تملك صلاحية حذف هذا السجل.');
          return;
        }
        toast.success('تم الحذف', 'تم حذف سجل المساعدة.');
        go('aid.html');
      } catch (error) {
        console.error(error);
        toast.error('تعذر الحذف', 'حدث خطأ أثناء الحذف، حاول مرة أخرى.');
      }
      return;
    }

    store.aid.remove(record.id);
    toast.success('تم الحذف', 'تم حذف سجل المساعدة.');
    go('aid.html');
  });

  const beneficiarySearch = content.querySelector('#beneficiary-search');
  if (beneficiarySearch) {
    beneficiarySearch.addEventListener('input', () => {
      const term = beneficiarySearch.value.trim().toLowerCase();
      content.querySelectorAll('[data-beneficiary-row]').forEach((row) => {
        row.hidden = Boolean(term) && !row.textContent.toLowerCase().includes(term);
      });
    });
  }
}
