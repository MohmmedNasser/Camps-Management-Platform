/**
 * Chart.js wrappers.
 *
 * Chart.js is loaded lazily from a CDN the first time a chart is actually
 * drawn, so pages that never draw one (and the first paint of those that do)
 * don't pay for it. If it is unavailable (offline review, blocked CDN) every
 * helper degrades to the CSS `barList` component instead of leaving a blank
 * card — a dashboard that silently loses a panel is worse than a plainer one.
 */

import { esc } from '../utils/dom.js';
import { barList } from './components.js';
import { formatMonth, formatNumber } from '../utils/format.js';
import { CHART_COLORS } from '../core/config.js';

const FONT = "'Noto Sans Arabic', sans-serif";
const GRID = '#E8E8EC';
const TEXT = '#6B6B6B';

const CHART_JS_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

export function chartsAvailable() {
  return typeof window !== 'undefined' && typeof window.Chart !== 'undefined';
}

let chartJsPromise = null;

/** Load Chart.js once; resolves true when `window.Chart` exists, false if the CDN failed. */
function loadChartJs() {
  if (chartsAvailable()) return Promise.resolve(true);
  if (!chartJsPromise) {
    chartJsPromise = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = CHART_JS_SRC;
      script.async = true;
      script.onload = () => resolve(chartsAvailable());
      script.onerror = () => {
        chartJsPromise = null; // allow a retry on the next draw
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }
  return chartJsPromise;
}

function baseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    locale: 'ar',
    plugins: {
      legend: { display: false },
      tooltip: {
        rtl: true,
        textDirection: 'rtl',
        backgroundColor: '#0A0A0A',
        padding: 10,
        cornerRadius: 6,
        titleFont: { family: FONT, size: 13 },
        bodyFont: { family: FONT, size: 13 },
        displayColors: false,
      },
    },
    ...extra,
  };
}

function axisScales({ stepSize } = {}) {
  return {
    x: {
      reverse: true, // RTL: earliest category on the right
      grid: { display: false },
      border: { color: GRID },
      ticks: { color: TEXT, font: { family: FONT, size: 11 } },
    },
    y: {
      position: 'right',
      beginAtZero: true,
      grid: { color: GRID },
      border: { display: false },
      ticks: { color: TEXT, font: { family: FONT, size: 11 }, precision: 0, stepSize },
    },
  };
}

/** Shared card wrapper so every chart panel looks identical. */
export function chartCard({ id, title, subtitle = '', legend = '', tall = false }) {
  return `
    <section class="chart-card">
      <div class="chart-card__head">
        <div>
          <h3 class="chart-card__title">${esc(title)}</h3>
          ${subtitle ? `<p class="chart-card__sub">${esc(subtitle)}</p>` : ''}
        </div>
      </div>
      <div class="chart-card__body">
        <div class="chart-canvas${tall ? ' chart-canvas--tall' : ''}" id="${esc(id)}-wrap">
          <canvas id="${esc(id)}" role="img"></canvas>
        </div>
      </div>
      ${legend ? `<div class="chart-legend" id="${esc(id)}-legend">${legend}</div>` : ''}
    </section>`;
}

export function legendItems(items) {
  return items
    .map(
      (item, index) => `
      <span class="chart-legend__item">
        <span class="chart-legend__swatch" style="background:${esc(item.color || CHART_COLORS[index % CHART_COLORS.length])}"></span>
        <span>${esc(item.label)}</span>
        <span class="chart-legend__value">${esc(formatNumber(item.value))}</span>
      </span>`
    )
    .join('');
}

/** Replace a chart canvas with the CSS bar fallback. */
function fallback(canvasId, items) {
  const wrap = document.getElementById(`${canvasId}-wrap`);
  if (!wrap) return;
  wrap.style.height = 'auto';
  wrap.innerHTML = barList(items);
}

async function create(canvasId, config, fallbackItems, ariaLabel) {
  if (!document.getElementById(canvasId)) return null;
  const ready = await loadChartJs();
  // Re-query: the page may have re-rendered while the script was loading.
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!ready) {
    fallback(canvasId, fallbackItems);
    return null;
  }
  // eslint-disable-next-line no-undef
  const chart = new window.Chart(canvas, config);
  canvas.setAttribute('aria-label', ariaLabel);
  return chart;
}

/* ---- Chart builders ----------------------------------------------------- */

/** Registrations per month (line). */
export function monthlyLine(canvasId, buckets, label = 'عدد النازحين') {
  const labels = buckets.map((bucket) => formatMonth(bucket.date));
  const values = buckets.map((bucket) => bucket.value);

  return create(
    canvasId,
    {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label,
            data: values,
            borderColor: CHART_COLORS[0],
            backgroundColor: 'rgba(99,102,241,.12)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#fff',
            pointBorderColor: CHART_COLORS[0],
            pointBorderWidth: 2,
            pointHoverRadius: 5,
          },
        ],
      },
      options: baseOptions({ scales: axisScales() }),
    },
    buckets.map((bucket) => ({ label: formatMonth(bucket.date), value: bucket.value })),
    `${label} خلال آخر ${buckets.length} أشهر`
  );
}

/** Aid records by type (horizontal bar). */
export function aidTypeBar(canvasId, rows) {
  return create(
    canvasId,
    {
      type: 'bar',
      data: {
        labels: rows.map((row) => row.label),
        datasets: [
          {
            label: 'عدد المساعدات',
            data: rows.map((row) => row.count),
            backgroundColor: CHART_COLORS[0],
            borderRadius: 5,
            barThickness: 18,
          },
        ],
      },
      options: baseOptions({
        indexAxis: 'y',
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: GRID },
            border: { display: false },
            ticks: { color: TEXT, font: { family: FONT, size: 11 }, precision: 0 },
          },
          y: {
            position: 'right',
            grid: { display: false },
            border: { color: GRID },
            ticks: { color: TEXT, font: { family: FONT, size: 12 } },
          },
        },
      }),
    },
    rows.map((row) => ({ label: row.label, value: row.count })),
    'توزيع المساعدات حسب النوع'
  );
}

/** Gender split (doughnut). */
export function genderDoughnut(canvasId, { males, females }) {
  return create(
    canvasId,
    {
      type: 'doughnut',
      data: {
        labels: ['ذكور', 'إناث'],
        datasets: [
          {
            data: [males, females],
            backgroundColor: [CHART_COLORS[0], CHART_COLORS[4]],
            borderWidth: 0,
            hoverOffset: 6,
          },
        ],
      },
      options: baseOptions({ cutout: '62%' }),
    },
    [
      { label: 'ذكور', value: males },
      { label: 'إناث', value: females },
    ],
    `توزيع النازحين حسب الجنس: ${males} ذكور و${females} إناث`
  );
}

/** Family size distribution (bar). */
export function familySizeBar(canvasId, buckets) {
  return create(
    canvasId,
    {
      type: 'bar',
      data: {
        labels: buckets.map((bucket) => bucket.label),
        datasets: [
          {
            label: 'عدد الأسر',
            data: buckets.map((bucket) => bucket.count),
            backgroundColor: CHART_COLORS[1],
            borderRadius: 5,
            barThickness: 30,
          },
        ],
      },
      options: baseOptions({ scales: axisScales({ stepSize: 1 }) }),
    },
    buckets.map((bucket) => ({ label: bucket.label, value: bucket.count, color: CHART_COLORS[1] })),
    'توزيع الأسر حسب عدد الأفراد'
  );
}

/** Per-camp comparison (grouped bar) — Super Admin. */
export function campComparisonBar(canvasId, rows) {
  return create(
    canvasId,
    {
      type: 'bar',
      data: {
        labels: rows.map((row) => row.name),
        datasets: [
          {
            label: 'النازحون',
            data: rows.map((row) => row.displacedCount),
            backgroundColor: CHART_COLORS[0],
            borderRadius: 5,
          },
          {
            label: 'الأسر',
            data: rows.map((row) => row.familiesCount),
            backgroundColor: CHART_COLORS[1],
            borderRadius: 5,
          },
        ],
      },
      options: baseOptions({ scales: axisScales({ stepSize: 2 }) }),
    },
    rows.map((row) => ({ label: row.name, value: row.displacedCount })),
    'مقارنة المخيمات حسب عدد النازحين والأسر'
  );
}
