/**
 * One family — members, aid history and documents.
 *
 * This is also "أسرتي" for a displaced person: with no `id` in the URL the
 * page resolves the signed-in user's own family, and refuses any other.
 */

import { esc, params, delegate } from '../utils/dom.js';
import { formatDate, formatDateTime, formatAge, formatNumber, fileSize } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  badge,
  statCard,
  emptyState,
  errorState,
  skeletonStats,
  skeletonTable,
  pageHeader,
  breadcrumb,
  definition,
  definitionList,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions } from '../ui/table.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can, getSession } from '../core/auth.js';
import * as store from '../core/store.js';
import { isOrphan } from '../core/selectors.js';
import { ROLES, labelOf, GENDERS, RELATIONSHIPS, TENT_TYPES, DOCUMENT_CATEGORIES } from '../core/config.js';
import { getFamilyByReferenceCode, deleteFamily, getOwnFamily } from '../supabase/families.js';
import { getFamilyAidHistory } from '../supabase/aids.js';
import { listDocuments } from '../supabase/documents.js';
import { getActivationStatus, generateActivationLink } from '../supabase/family-activation.js';

// A displaced person reaches this page through "أسرتي"; an administrator
// through the families list — highlight whichever nav entry they came from.
let activeNav = 'families.html';
try {
  const preSession = await getSession();
  if (preSession && preSession.role === ROLES.DISPLACED) activeNav = 'family-details.html';
} catch {
  // Best-effort only — mountShell()'s guard() below is the authoritative
  // check and will redirect appropriately if the session is invalid.
}

const shell = await mountShell({ active: activeNav, title: 'تفاصيل الأسرة' });
if (shell) init(shell);

async function init({ session, content }) {
  content.innerHTML = `<div class="grid grid--4 u-mb-6">${skeletonStats(4)}</div>${skeletonTable(5)}`;

  try {
    const data = await store.load(() => collect(session));

    if (!data.family) {
      content.innerHTML = missingView(session);
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

function collect(session) {
  const { id } = params();

  if (session.role === ROLES.DISPLACED) {
    return collectOwn(session);
  }

  return collectReal(session, id);
}

/**
 * A displaced person's own family, resolved through the authenticated
 * session only (Phase 4.13) — never `params()`. Mirrors collectReal()
 * above (same getFamilyAidHistory()/listDocuments() calls, same local
 * mappers) with the identity source swapped and no cross-camp check
 * (unneeded: RLS + the identity chain already guarantee it's the caller's
 * own family).
 */
async function collectOwn(session) {
  const family = await getOwnFamily(session);
  if (!family) return { family: null };

  const [aidRows, docsResult] = await Promise.all([
    getFamilyAidHistory(family._dbId),
    listDocuments({ familyId: family._dbId }),
  ]);

  return {
    family: { ...family, campName: session.campLabel },
    aid: aidRows.map(mapAidHistoryRow),
    documents: docsResult.rows.map(mapDocumentRow),
  };
}

/**
 * `family.campId !== session.campId` is redundant, UX-only narrowing for a
 * Camp Admin — RLS on `families` already prevents `getFamilyByReferenceCode()`
 * from returning another camp's row at all (Phase 4.4 spec §5.2). A Super
 * Admin has no single "own camp" to compare against — RLS's `is_super_admin()`
 * branch is what legitimately lets them open any camp's family here
 * (PAGE_ACCESS: family-details.html is Super Admin/Camp Admin/Displaced).
 */
async function collectReal(session, referenceCode) {
  if (!referenceCode) return { family: null };
  const family = await getFamilyByReferenceCode(referenceCode);
  if (!family) return { family: null };
  if (session.role === ROLES.CAMP_ADMIN && family.campId !== session.campId) return { family: null };

  const [aidRows, docsResult] = await Promise.all([
    getFamilyAidHistory(family._dbId),
    listDocuments({ familyId: family._dbId }),
  ]);

  return {
    family,
    aid: aidRows.map(mapAidHistoryRow),
    documents: docsResult.rows.map(mapDocumentRow),
  };
}

function mapAidHistoryRow(row) {
  const d = row.distribution;
  const labels = (d.aid_distribution_types || []).map((t) => t.aid_type?.label_ar).filter(Boolean);
  return {
    id: d.id,
    typeLabels: labels.join('، '),
    organizationName: d.organization?.name || '—',
    date: d.distributed_on,
  };
}

function mapDocumentRow(row) {
  return {
    id: row.id,
    name: row.name,
    size: row.file_size,
    categoryLabel: labelOf(DOCUMENT_CATEGORIES, row.category),
  };
}

function missingView(session) {
  if (session.role === ROLES.DISPLACED) {
    return emptyState({
      iconName: 'family',
      title: 'لم يتم ربط حسابك بأسرة بعد',
      text: 'تواصل مع إدارة المخيم لإضافتك إلى سجل أسرتك، وستظهر بياناتها هنا.',
      actions: button({
        label: 'مراسلة إدارة المخيم',
        variant: 'primary',
        iconName: 'send',
        href: pageUrl('message-compose.html'),
      }),
    });
  }
  return emptyState({
    iconName: 'alertTriangle',
    title: 'الأسرة غير موجودة',
    text: 'قد تكون محذوفة أو خارج نطاق صلاحياتك.',
    actions: button({ label: 'العودة إلى الأسر', variant: 'primary', href: pageUrl('families.html') }),
  });
}

/* ---- View ----------------------------------------------------------------- */

function view(session, { family, aid, documents }) {
  const isOwn = session.role === ROLES.DISPLACED;
  const head = family.head;

  return `
    ${
      isOwn
        ? pageHeader({ title: 'أسرتي', description: `بيانات أسرتك المسجلة في ${family.campName}.` })
        : `${breadcrumb([
            { label: 'الأسر', href: pageUrl('families.html') },
            { label: family.id },
          ])}
          ${pageHeader({
            title: `الأسرة ${family.id}`,
            description: `رب الأسرة: ${family.headName} — ${family.campName}`,
            actions: `
              ${
                can('family:activate')
                  ? button({
                      label: 'تفعيل حساب الأسرة',
                      variant: 'secondary',
                      iconName: 'userCheck',
                      attrs: 'data-activate',
                    })
                  : ''
              }
              ${
                can('aid:create')
                  ? button({
                      label: 'تسجيل مساعدة',
                      variant: 'primary',
                      iconName: 'plus',
                      href: pageUrl('aid-create.html', { familyId: family.id }),
                    })
                  : ''
              }
              ${
                can('family:delete')
                  ? button({ label: 'حذف', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
                  : ''
              }`,
          })}`
    }

    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'عدد الأفراد', value: formatNumber(family.membersCount), iconName: 'family' })}
      ${statCard({ label: 'الأطفال أقل من 18 عامًا', value: formatNumber(family.childrenCount), iconName: 'users', tone: 'success' })}
      ${statCard({ label: 'الأيتام', value: formatNumber(family.orphansCount), iconName: 'family', tone: 'warning' })}
      ${statCard({ label: 'المساعدات المستلمة', value: formatNumber(aid.length), iconName: 'aid' })}
      ${statCard({ label: 'المستندات', value: formatNumber(documents.length), iconName: 'folder', href: pageUrl('documents.html') })}
    </div>

    <div class="split">
      <div class="stack">
        ${card({
          title: 'أفراد الأسرة',
          action: can('displaced:create')
            ? `<a class="btn btn--ghost btn--sm" href="${pageUrl('displaced-create.html', {
                familyId: family.id,
              })}">إضافة فرد</a>`
            : '',
          flush: true,
          body: membersTable(family),
        })}

        ${card({
          title: 'سجل مساعدات الأسرة',
          action: aid.length
            ? `<a class="btn btn--ghost btn--sm" href="${pageUrl('aid.html', { familyId: family.id })}">عرض الكل</a>`
            : '',
          flush: true,
          body: aid.length
            ? `<div class="list">${aid
                .slice(0, 8)
                .map((record) => aidRow(record, { linked: !isOwn }))
                .join('')}</div>`
            : emptyState({
                iconName: 'aid',
                title: 'لا توجد مساعدات مسجلة',
                text: isOwn
                  ? 'ستظهر هنا المساعدات التي تسجلها إدارة المخيم لأسرتك.'
                  : 'لم تُسجَّل أي مساعدة لهذه الأسرة بعد.',
                actions: can('aid:create')
                  ? button({
                      label: 'تسجيل مساعدة',
                      variant: 'primary',
                      iconName: 'plus',
                      href: pageUrl('aid-create.html', { familyId: family.id }),
                    })
                  : '',
              }),
        })}
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'بيانات الأسرة',
          body: definitionList([
            definition('رقم الأسرة', family.id, { mono: true }),
            definition('المخيم', family.campName),
            definition('رب الأسرة', family.headName),
            definition('نوع الخيمة', head ? labelOf(TENT_TYPES, head.tentType) : ''),
            definition('تاريخ التسجيل', formatDate(family.createdAt)),
            definition('ملاحظات', family.notes),
          ]),
        })}

        ${card({
          title: 'مستندات الأسرة',
          flush: true,
          body: documents.length
            ? `<div class="list">${documents.slice(0, 6).map(documentRow).join('')}</div>`
            : emptyState({
                iconName: 'folder',
                title: 'لا توجد مستندات',
                text: 'لم يُرفع أي مستند لهذه الأسرة.',
              }),
        })}
      </aside>
    </div>`;
}

function membersTable(family) {
  if (!family.members.length) {
    return emptyState({
      iconName: 'users',
      title: 'لا يوجد أفراد مسجلون',
      text: 'أضف أفراد الأسرة من سجل النازحين.',
    });
  }

  return dataTable({
    columns: [
      {
        key: 'fullName',
        label: 'الاسم',
        primary: true,
        cell: (row) =>
          cellMain(
            row.fullName,
            `${labelOf(RELATIONSHIPS, row.relationship)} · ${labelOf(GENDERS, row.gender)}`
          ),
      },
      { key: 'relationship', label: 'صلة القرابة', cell: (row) => labelOf(RELATIONSHIPS, row.relationship) },
      { key: 'age', label: 'العمر', cell: (row) => formatAge(row.birthDate) },
      { key: 'nationalId', label: 'رقم الهوية', cell: (row) => cellMono(row.nationalId) },
      {
        key: 'health',
        label: 'الحالة',
        cell: (row) =>
          [
            row.chronicDiseases ? badge('مرض مزمن', 'warning') : '',
            row.disability ? badge('إعاقة', 'error') : '',
            isOrphan(row) ? badge('يتيم', 'info') : '',
          ]
            .filter(Boolean)
            .join(' ') || '<span class="u-muted">—</span>',
      },
      {
        key: 'actions',
        label: 'إجراءات',
        actions: true,
        cell: (row) =>
          rowActions([
            can('displaced:view') && {
              iconName: 'eye',
              title: `عرض ${row.fullName}`,
              href: pageUrl('displaced-details.html', { id: row.id }),
            },
            can('displaced:update') && {
              iconName: 'edit',
              title: `تعديل ${row.fullName}`,
              href: pageUrl('displaced-edit.html', { id: row.id }),
            },
          ]),
      },
    ],
    rows: family.members,
    caption: `أفراد الأسرة ${family.id}`,
  });
}

/**
 * A displaced person gets a read-only line; an administrator gets a link to
 * the record. Aid detail is not part of the displaced person's interface.
 */
function aidRow(record, { linked = true } = {}) {
  const inner = `
    <span class="list__main">
      <span class="list__title">${esc(record.typeLabels || '—')} — ${esc(record.organizationName)}</span>
      <span class="list__meta">${esc(formatDate(record.date))}</span>
    </span>`;

  if (!linked) return `<div class="list__row">${inner}</div>`;

  return `
    <a class="list__row" href="${pageUrl('aid-details.html', { id: record.id })}">
      ${inner}
      <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
    </a>`;
}

function documentRow(row) {
  return `
    <a class="list__row" href="${pageUrl('documents.html', { id: row.id })}">
      <span class="list__main">
        <span class="list__title">${esc(row.name)}</span>
        <span class="list__meta">${esc(row.categoryLabel)} · ${esc(fileSize(row.size))}</span>
      </span>
      <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
    </a>`;
}

/* ---- Account activation (Camp Admin only) --------------------------------- */

const ACTIVATION_STATE_LABELS = {
  none: 'لا يوجد رابط بعد',
  active: 'رابط فعّال',
  expired: 'منتهي الصلاحية',
  used: 'تم استخدامه',
  revoked: 'ملغى',
};

const ACTIVATION_STATE_VARIANTS = {
  none: 'neutral',
  active: 'success',
  expired: 'warning',
  used: 'info',
  revoked: 'error',
};

function activationLinkMarkup({ url, expiresAt }) {
  return `
    <div class="field u-mt-4" data-field="activationUrl">
      <label class="field__label" for="activation-url">رابط التفعيل</label>
      <div class="u-flex u-gap-2">
        <input id="activation-url" class="input mono" type="text" readonly value="${esc(url)}" data-activation-url />
        ${button({ label: 'نسخ', variant: 'secondary', iconName: 'clipboard', attrs: 'data-copy-link' })}
      </div>
      <p class="field__hint">صالح حتى ${esc(formatDateTime(expiresAt))}. أرسل هذا الرابط لرب الأسرة عبر واتساب أو أي وسيلة تواصل أخرى، ولا تشاركه مع أي شخص آخر.</p>
    </div>`;
}

function activationStatusMarkup(status) {
  if (status.state === 'activated') {
    return `
      <div class="u-mb-3">${badge('مُفعّل', 'success')}</div>
      <p class="u-secondary">تم تفعيل حساب رب الأسرة، ويمكنه تسجيل الدخول مباشرة من صفحة تسجيل الدخول.</p>`;
  }

  return `
    <div class="u-mb-3">${badge(ACTIVATION_STATE_LABELS[status.state] || status.state, ACTIVATION_STATE_VARIANTS[status.state] || 'neutral')}</div>
    ${
      status.expiresAt
        ? `<p class="u-secondary u-mb-4">${status.state === 'active' ? 'ينتهي في' : 'كان ينتهي في'} ${esc(formatDateTime(status.expiresAt))}</p>`
        : ''
    }
    ${button({
      label: status.state === 'none' ? 'توليد رابط تفعيل' : 'توليد رابط تفعيل جديد',
      variant: 'primary',
      iconName: 'userCheck',
      attrs: 'data-generate',
    })}
    ${
      status.state === 'active'
        ? `<p class="field__hint u-mt-2">توليد رابط جديد يُلغي الرابط الحالي فوراً.</p>`
        : ''
    }
    <div id="activation-link-slot"></div>`;
}

async function openActivationModal(family) {
  const modal = openModal({
    title: 'تفعيل حساب الأسرة',
    description: `الأسرة ${family.id} — رب الأسرة: ${family.headName}`,
    body: `<div class="u-text-center u-p-4"><span class="btn__spinner"></span></div>`,
  });

  const renderStatus = async () => {
    try {
      const status = await getActivationStatus(family._dbId);
      modal.element.querySelector('.modal__body').innerHTML = activationStatusMarkup(status);
      wireGenerate();
    } catch (error) {
      console.error(error);
      modal.element.querySelector('.modal__body').innerHTML = errorState({ retryAttrs: 'data-retry' });
      delegate(modal.element, 'click', '[data-retry]', renderStatus);
    }
  };

  const wireGenerate = () => {
    delegate(modal.element, 'click', '[data-generate]', async (event, node) => {
      node.disabled = true;
      try {
        const link = await generateActivationLink(family._dbId);
        const slot = modal.element.querySelector('#activation-link-slot');
        if (slot) slot.innerHTML = activationLinkMarkup(link);
        wireCopy();
        toast.success('تم إنشاء الرابط', 'انسخه وأرسله لرب الأسرة.');
      } catch (error) {
        console.error(error);
        toast.error('تعذر إنشاء الرابط', 'حاول مرة أخرى.');
      } finally {
        node.disabled = false;
      }
    });
  };

  const wireCopy = () => {
    delegate(modal.element, 'click', '[data-copy-link]', async () => {
      const input = modal.element.querySelector('[data-activation-url]');
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
        toast.success('تم النسخ', 'تم نسخ رابط التفعيل.');
      } catch {
        input.select();
        toast.error('تعذر النسخ', 'انسخ الرابط يدوياً من الحقل.');
      }
    });
  };

  await renderStatus();
}

function wire(content, session, { family }) {
  delegate(content, 'click', '[data-activate]', () => openActivationModal(family));

  // family:delete is Camp-Admin-only (core/auth.js PERMISSIONS), so this
  // control is never rendered for any other role in the first place.
  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف الأسرة',
      text: `سيتم حذف الأسرة ${family.id} وجميع أفرادها وسجل مساعداتها. لا يمكن التراجع عن هذا الإجراء.`,
      confirmLabel: 'حذف الأسرة',
    });
    if (!ok) return;

    const deleted = await deleteFamily(family.id);
    if (!deleted) {
      toast.error('تعذر الحذف', 'قد لا تملك صلاحية حذف هذه الأسرة.');
      return;
    }
    toast.success('تم الحذف', 'تم حذف الأسرة.');
    go('families.html');
  });
}
