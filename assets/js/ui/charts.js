/**
 * Chart.js wrappers.
 *
 * Chart.js is loaded from a CDN with a plain <script> tag on the pages that
 * need it. If it is unavailable (offline review, blocked CDN) every helper
 * degrades to the CSS `barList` component instead of leaving a blank card —
 * a dashboard that silently loses a panel is worse than a plainer one.
 */

import { esc } from '../utils/dom.js';
import { barList } from './components.js';
import { formatMonth, formatNumber } from '../utils/format.js';
import { CHART_COLORS } from '../core/config.js';

const FONT = "'Noto Sans Arabic', sans-serif";
const GRID = '#E8E8EC';
const TEXT = '#6B6B6B';

export function chartsAvailable() {
  return typeof window !== 'undefined' && typeof window.Chart !== 'undefined';
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

function create(canvasId, config, fallbackItems) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!chartsAvailable()) {
    fallback(canvasId, fallbackItems);
    return null;
  }
  // eslint-disable-next-line no-undef
  return new window.Chart(canvas, config);
}

/* ---- Chart builders ----------------------------------------------------- */

/** Registrations per month (line). */
export function monthlyLine(canvasId, buckets, label = 'عدد النازحين') {
  const labels = buckets.map((bucket) => formatMonth(bucket.date));
  const values = buckets.map((bucket) => bucket.value);

  const chart = create(
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
    buckets.map((bucket) => ({ label: formatMonth(bucket.date), value: bucket.value }))
  );

  if (chart) chart.canvas.setAttribute('aria-label', `${label} خلال آخر ${buckets.length} أشهر`);
  return chart;
}

/** Aid records by type (horizontal bar). */
export function aidTypeBar(canvasId, rows) {
  const chart = create(
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
    rows.map((row) => ({ label: row.label, value: row.count }))
  );

  if (chart) chart.canvas.setAttribute('aria-label', 'توزيع المساعدات حسب النوع');
  return chart;
}

/** Gender split (doughnut). */
export function genderDoughnut(canvasId, { males, females }) {
  const chart = create(
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
    ]
  );

  if (chart) chart.canvas.setAttribute('aria-label', `توزيع النازحين حسب الجنس: ${males} ذكور و${females} إناث`);
  return chart;
}

/** Family size distribution (bar). */
export function familySizeBar(canvasId, buckets) {
  const chart = create(
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
    buckets.map((bucket) => ({ label: bucket.label, value: bucket.count, color: CHART_COLORS[1] }))
  );

  if (chart) chart.canvas.setAttribute('aria-label', 'توزيع الأسر حسب عدد الأفراد');
  return chart;
}

/** Per-camp comparison (grouped bar) — Super Admin. */
export function campComparisonBar(canvasId, rows) {
  const chart = create(
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
    rows.map((row) => ({ label: row.name, value: row.displacedCount }))
  );

  if (chart) chart.canvas.setAttribute('aria-label', 'مقارنة المخيمات حسب عدد النازحين والأسر');
  return chart;
}
