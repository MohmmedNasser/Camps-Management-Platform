/**
 * Displaced people — list, advanced filtering and Excel export.
 *
 * Search covers name, national ID, phone and family ID. It deliberately does
 * not cover a file number or a tent number: the domain has neither.
 *
 * Every view of the data — the table, the result count, the export — comes
 * from one call to `selectors.getFilteredDisplaced`, so the number on screen
 * is by construction the number of rows in the spreadsheet.
 */

import { delegate, params, setParams, qs } from "../utils/dom.js";
import { formatPhone } from "../utils/format.js";
import { mountShell } from "../ui/layout.js";
import {
    button,
    statusBadge,
    badge,
    emptyState,
    errorState,
    skeletonTable,
    pageHeader,
    pagination,
} from "../ui/components.js";
import {
    dataTable,
    cellMain,
    cellMono,
    rowActions,
    resultBar,
} from "../ui/table.js";
import {
    toolbar,
    initToolbar,
    activeFilters,
    filterSummary,
    syncFilterButton,
} from "../ui/toolbar.js";
import { confirmDialog } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { pageUrl } from "../core/router.js";
import { can } from "../core/auth.js";
import * as store from "../core/store.js";
import * as select from "../core/selectors.js";
import { DISPLACED_COLUMNS, displacedExportRow } from "../core/exports.js";
import { exportSheet, timestampedName } from "../utils/xlsx.js";
import {
    ROLES,
    STATUS,
    GENDERS,
    AID_TYPES,
    TENT_TYPES,
    AGE_BANDS,
    YES_NO,
    CHRONIC_FILTER,
    ORPHAN_FILTER,
    BREASTFEEDING_FILTER,
    PREGNANT_FILTER,
    STATUS_LABELS,
    PAGE_SIZE,
} from "../core/config.js";

/* ---- State --------------------------------------------------------------- */

/** Every filter the page understands; `page` and `q` are handled separately. */
const FILTER_KEYS = [
    "campId",
    "gender",
    "status",
    "tentType",
    "ageBand",
    "isChild",
    "isOrphan",
    "hasChronic",
    "isBreastfeeding",
    "isPregnant",
    "aidType",
    "organizationId",
];

const state = { q: "", page: 1 };
FILTER_KEYS.forEach((key) => {
    state[key] = "";
});

const shell = mountShell({ active: "displaced.html", title: "النازحون" });
if (shell) init(shell);

function readQuery() {
    const query = params();
    state.q = query.q || "";
    FILTER_KEYS.forEach((key) => {
        state[key] = query[key] || "";
    });
    state.page = Math.max(1, Number(query.page) || 1);
}

/** Filter values only — what the summary chips and the active count read. */
function filterValues() {
    return Object.fromEntries(FILTER_KEYS.map((key) => [key, state[key]]));
}

function activeFilterCount() {
    return FILTER_KEYS.filter((key) => state[key]).length;
}

/* ---- Filter descriptors --------------------------------------------------- */

/**
 * One list drives the panel, the active count and the summary chips, so a
 * filter can never appear in one and be missing from another.
 */
function filterSpec(session) {
    const isSuper = session.role === ROLES.SUPER_ADMIN;

    return [
        isSuper && {
            name: "campId",
            label: "المخيم",
            group: "البيانات الأساسية",
            options: select.campOptions(session),
            value: state.campId,
        },
        {
            name: "gender",
            label: "الجنس",
            group: "البيانات الأساسية",
            options: GENDERS,
            value: state.gender,
        },
        {
            name: "status",
            label: "الحالة",
            group: "البيانات الأساسية",
            options: [STATUS.APPROVED, STATUS.PENDING, STATUS.REJECTED].map(
                (value) => ({
                    value,
                    label: STATUS_LABELS[value],
                }),
            ),
            value: state.status,
        },
        {
            name: "tentType",
            label: "نوع وحدة الإيواء",
            group: "البيانات الأساسية",
            options: TENT_TYPES,
            value: state.tentType,
        },

        {
            name: "ageBand",
            label: "الفئة العمرية",
            group: "العمر",
            options: AGE_BANDS.map(({ value, label }) => ({ value, label })),
            value: state.ageBand,
        },
        {
            name: "isChild",
            label: "الأطفال أقل من 18 عامًا",
            group: "العمر",
            options: YES_NO,
            value: state.isChild,
        },

        {
            name: "hasChronic",
            label: "الأمراض المزمنة",
            group: "الحالة الصحية والاجتماعية",
            options: CHRONIC_FILTER,
            value: state.hasChronic,
        },
        {
            name: "isOrphan",
            label: "الأيتام",
            group: "الحالة الصحية والاجتماعية",
            options: ORPHAN_FILTER,
            value: state.isOrphan,
        },
        {
            name: "isBreastfeeding",
            label: "المرضعات",
            group: "الحالة الصحية والاجتماعية",
            options: BREASTFEEDING_FILTER,
            value: state.isBreastfeeding,
            placeholder: "الكل",
        },
        {
            name: "isPregnant",
            label: "الحوامل",
            group: "الحالة الصحية والاجتماعية",
            options: PREGNANT_FILTER,
            value: state.isPregnant,
            placeholder: "الكل",
        },

        {
            name: "aidType",
            label: "نوع المساعدة المستلمة",
            group: "المساعدات",
            options: AID_TYPES.map((type) => ({
                value: type.value,
                label: type.label,
            })),
            value: state.aidType,
        },
        {
            name: "organizationId",
            label: "الجهة المانحة",
            group: "المساعدات",
            options: select.organizationOptions(),
            value: state.organizationId,
        },
    ].filter(Boolean);
}

/* ---- Entry --------------------------------------------------------------- */

function init({ session, content }) {
    readQuery();

    const isSuper = session.role === ROLES.SUPER_ADMIN;
    const filters = filterSpec(session);

    content.innerHTML = `
    ${pageHeader({
        title: "النازحون",
        description: isSuper
            ? "سجل النازحين في جميع المخيمات."
            : `سجل النازحين في ${session.campLabel}.`,
        actions: `
        ${button({
            label: "تصدير إلى Excel",
            variant: "secondary",
            iconName: "download",
            attrs: "data-export",
        })}
        ${
            can("displaced:create")
                ? button({
                      label: "إضافة نازح",
                      variant: "primary",
                      iconName: "plus",
                      href: pageUrl("displaced-create.html"),
                  })
                : ""
        }`,
    })}
    ${toolbar({
        searchValue: state.q,
        searchPlaceholder: "ابحث بالاسم أو رقم الهوية أو الهاتف أو رقم الأسرة…",
        filters,
        activeCount: activeFilterCount(),
        modal: true,
    })}
    <div id="summary"></div>
    <div id="results">${skeletonTable(6)}</div>`;

    initToolbar(content, {
        onChange: (values) => {
            if (values.q !== undefined) state.q = values.q;
            FILTER_KEYS.forEach((key) => {
                if (key in values) state[key] = values[key];
            });
            state.page = 1;
            setParams({ q: state.q, ...filterValues(), page: "" });
            load(session);
        },
        // Fresh descriptors every time the sheet opens, so it always shows the
        // filters most recently applied rather than a stale snapshot from render.
        getFilters: () => filterSpec(session),
        // Live count for the values staged inside the sheet, read through the
        // exact same query the table and export use — nothing bespoke here.
        onPreview: (staged) =>
            select.getFilteredDisplaced(session, { query: state.q, ...staged })
                .length,
    });

    delegate(content, "click", "[data-page]", (event, node) => {
        const page = Number(node.dataset.page);
        if (!page || node.disabled) return;
        state.page = page;
        setParams({ page: page > 1 ? page : "" });
        load(session);
        qs("#results", content).scrollIntoView({
            behavior: "smooth",
            block: "start",
        });
    });

    // Removing a single chip from the summary.
    delegate(content, "click", "[data-remove-filter]", (event, node) => {
        const key = node.dataset.removeFilter;
        if (key === "q") {
            state.q = "";
            const search = qs("#toolbar-search", content);
            if (search) search.value = "";
        } else {
            state[key] = "";
            const field = qs(`#${key}`, content);
            if (field) field.value = "";
        }
        state.page = 1;
        setParams({ q: state.q, ...filterValues(), page: "" });
        load(session);
    });

    delegate(content, "click", "[data-delete]", async (event, node) => {
        const ok = await confirmDialog({
            title: "حذف سجل النازح",
            text: `سيتم حذف "${node.dataset.name}" وكل ما يرتبط به من مستندات. لا يمكن التراجع عن هذه العملية.`,
            confirmLabel: "حذف نهائي",
        });
        if (!ok) return;
        select.removeDisplaced(node.dataset.delete);
        toast.success("تم الحذف", "تم حذف سجل النازح.");
        load(session);
    });

    delegate(content, "click", "[data-clear-search]", () => {
        const search = qs("#toolbar-search", content);
        if (search) search.value = "";
        state.q = "";
        state.page = 1;
        FILTER_KEYS.forEach((key) => {
            state[key] = "";
            const field = qs(`#${key}`, content);
            if (field) field.value = "";
        });
        setParams({ q: "", ...filterValues(), page: "" });
        load(session);
    });

    delegate(content, "click", "[data-export]", (event, node) =>
        exportRows(session, node),
    );

    load(session);
}

/* ---- Data + rendering ----------------------------------------------------- */

/** The single query behind the table, the count and the export. */
function collect(session) {
    return select.getFilteredDisplaced(session, {
        query: state.q,
        ...filterValues(),
    });
}

async function load(session) {
    const target = qs("#results");
    if (!target) return;
    target.innerHTML = skeletonTable(6);

    try {
        const rows = await store.load(() => collect(session));
        target.innerHTML = resultsView(session, rows);

        const summary = qs("#summary");
        if (summary) {
            summary.innerHTML = filterSummary({
                active: activeFilters(filterSpec(session), filterValues()),
                total: rows.length,
                noun: "نازح",
                query: state.q,
            });
        }

        // The filter badge only knows what state.js knew at page render; every
        // apply/reset/chip-removal lands here, so this is the one place that
        // needs to keep it current.
        syncFilterButton(document, activeFilterCount());
    } catch (error) {
        console.error(error);
        target.innerHTML = errorState({ retryAttrs: "data-retry" });
        delegate(target, "click", "[data-retry]", () => load(session));
    }
}

/* ---- Excel export --------------------------------------------------------- */

/**
 * Export exactly what is on screen.
 *
 * The rows come from the same `collect()` the table used, and the scope inside
 * `getFilteredDisplaced` is taken from the session — a Camp Admin cannot widen
 * it by editing `?campId=`.
 */
async function exportRows(session, trigger) {
    const original = trigger.innerHTML;
    trigger.disabled = true;
    trigger.innerHTML = `<span class="btn__spinner"></span><span>جارٍ تجهيز ملف Excel…</span>`;

    try {
        const rows = await store.load(() => collect(session), 120);

        if (!rows.length) {
            toast.error(
                "لا توجد نتائج لتصديرها",
                "عدّل الفلاتر ثم حاول مرة أخرى.",
            );
            return;
        }

        const filtered = Boolean(state.q) || activeFilterCount() > 0;
        const count = exportSheet({
            columns: DISPLACED_COLUMNS,
            rows: rows.map(displacedExportRow),
            filename: timestampedName("النازحون", { filtered }),
            sheetName: "النازحون",
        });

        toast.success("تم التصدير", `تم تصدير ${count} سجلًا بنجاح.`);
    } catch (error) {
        console.error(error);
        toast.error(
            "تعذر التصدير",
            "حدث خطأ أثناء تجهيز الملف، حاول مرة أخرى.",
        );
    } finally {
        trigger.disabled = false;
        trigger.innerHTML = original;
    }
}

/* ---- Table ---------------------------------------------------------------- */

function resultsView(session, rows) {
    if (!rows.length) return emptyView();

    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const page = Math.min(state.page, pages);
    const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const isSuper = session.role === ROLES.SUPER_ADMIN;

    const columns = [
        {
            key: "fullName",
            label: "الاسم",
            primary: true,
            cell: (row) => cellMain(row.fullName, row.fullNameEn),
        },
        {
            key: "nationalId",
            label: "رقم الهوية",
            cell: (row) => cellMono(row.nationalId),
        },
        {
            key: "phone",
            label: "الهاتف",
            cell: (row) => cellMono(formatPhone(row.phone)),
        },
        {
            key: "familyId",
            label: "رقم الأسرة",
            cell: (row) => cellMono(row.familyLabel),
        },
        ...(isSuper ? [{ key: "campName", label: "المخيم" }] : []),
        {
            key: "flags",
            label: "الحالة الصحية والاجتماعية",
            cell: (row) => {
                const facts = select.personFacts(row);
                return (
                    [
                        facts.isChild ? badge("طفل", "info") : "",
                        facts.isOrphan ? badge("يتيم", "info") : "",
                        facts.hasChronic ? badge("مرض مزمن", "warning") : "",
                        facts.hasDisability ? badge("إعاقة", "error") : "",
                        facts.isPregnant ? badge("حامل", "success") : "",
                        facts.isBreastfeeding ? badge("مرضعة", "success") : "",
                    ]
                        .filter(Boolean)
                        .join(" ") || '<span class="u-muted">—</span>'
                );
            },
        },
        {
            key: "status",
            label: "الحالة",
            cell: (row) => statusBadge(row.status),
        },
        {
            key: "actions",
            label: "إجراءات",
            actions: true,
            cell: (row) =>
                rowActions([
                    {
                        iconName: "eye",
                        title: `عرض ${row.fullName}`,
                        href: pageUrl("displaced-details.html", { id: row.id }),
                    },
                    can("displaced:update") && {
                        iconName: "edit",
                        title: `تعديل ${row.fullName}`,
                        href: pageUrl("displaced-edit.html", { id: row.id }),
                    },
                    can("displaced:delete") && {
                        iconName: "trash",
                        title: `حذف ${row.fullName}`,
                        variant: "danger",
                        attrs: `data-delete="${row.id}" data-name="${row.fullName}"`,
                    },
                ]),
        },
    ];

    return `
    ${resultBar({ count: slice.length, total: rows.length, noun: "نازح" })}
    ${dataTable({
        columns,
        rows: slice,
        caption: "سجل النازحين",
        foot:
            rows.length > PAGE_SIZE
                ? pagination({ page, pageSize: PAGE_SIZE, total: rows.length })
                : "",
    })}`;
}

function emptyView() {
    const filtered = state.q || activeFilterCount();
    return filtered
        ? emptyState({
              iconName: "search",
              title: "لا توجد نتائج مطابقة",
              text: "جرّب تعديل كلمات البحث أو إزالة بعض الفلاتر.",
              actions: button({
                  label: "إزالة كل الفلاتر",
                  variant: "secondary",
                  attrs: "data-clear-search",
              }),
          })
        : emptyState({
              iconName: "users",
              title: "لا يوجد نازحون مسجلون",
              text: "ابدأ بتسجيل أول نازح أو أسرة في المخيم.",
              actions: can("displaced:create")
                  ? button({
                        label: "إضافة نازح",
                        variant: "primary",
                        iconName: "plus",
                        href: pageUrl("displaced-create.html"),
                    })
                  : "",
          });
}
