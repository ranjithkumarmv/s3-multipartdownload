// Renders a static, theme-aware horizontal bar chart (throughput per strategy) as SVG.
const W = 760
const ROW = 46
const LEFT = 250
const RIGHT = 120
const TOP = 78

function renderChart(c, report) {
    const max = Math.max(...c.results.map(r => r.throughputMBps))
    const plotW = W - LEFT - RIGHT
    const H = TOP + c.results.length * ROW + 44
    const x = v => (v / max) * plotW
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const subtitle = report.mode === 'simulated'
        ? `${Math.round(c.sizeMB)} MB object · simulated S3: ${report.network.perConnMBps} MB/s per connection, ${report.network.aggregateMBps} MB/s total`
        : `${Math.round(c.sizeMB)} MB object · real Amazon S3`

    const ticks = niceTicks(max)
    const grid = ticks.map(t => `
    <line class="grid" x1="${LEFT + x(t)}" x2="${LEFT + x(t)}" y1="${TOP - 8}" y2="${TOP + c.results.length * ROW}"/>
    <text class="axis" x="${LEFT + x(t)}" y="${TOP + c.results.length * ROW + 18}" text-anchor="middle">${t}</text>`).join('')

    const bars = c.results.map((r, i) => {
        const y = TOP + i * ROW + 8
        const w = Math.max(4, x(r.throughputMBps))
        const cls = r.strategy === 'single' ? 'bar base' : 'bar'
        return `
    <text class="label" x="${LEFT - 12}" y="${y + 19}" text-anchor="end">${esc(r.label)}</text>
    <path class="${cls}" d="M${LEFT},${y} h${w - 4} a4,4 0 0 1 4,4 v20 a4,4 0 0 1 -4,4 h-${w - 4} z"><title>${esc(r.label)}: ${r.throughputMBps.toFixed(1)} MB/s, ${r.medianSeconds.toFixed(2)} s</title></path>
    <text class="value" x="${LEFT + w + 8}" y="${y + 19}">${r.throughputMBps.toFixed(0)} MB/s <tspan class="muted">${r.strategy === 'single' ? '' : r.speedup.toFixed(1) + '×'}</tspan></text>`
    }).join('')

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Download throughput by strategy">
  <style>
    .bg { fill: #fcfcfb }
    .title { font: 600 18px system-ui, -apple-system, Segoe UI, sans-serif; fill: #0b0b0b }
    .sub, .axis, .muted { font: 12px system-ui, -apple-system, Segoe UI, sans-serif; fill: #52514e }
    .label, .value { font: 13px system-ui, -apple-system, Segoe UI, sans-serif; fill: #0b0b0b }
    .value { font-weight: 600 }
    .muted { font-weight: 400 }
    .grid { stroke: #e4e3df; stroke-width: 1 }
    .bar { fill: #2a78d6 }
    .bar.base { fill: #a3a29b }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #1a1a19 }
      .title, .label, .value { fill: #f0efec }
      .sub, .axis, .muted { fill: #c3c2b7 }
      .grid { stroke: #3a3a37 }
      .bar { fill: #3987e5 }
      .bar.base { fill: #6f6e68 }
    }
  </style>
  <rect class="bg" width="${W}" height="${H}" rx="12"/>
  <text class="title" x="24" y="34">Download throughput (higher is better)</text>
  <text class="sub" x="24" y="56">${esc(subtitle)}</text>${grid}${bars}
  <text class="axis" x="${LEFT + plotW / 2}" y="${H - 6}" text-anchor="middle">MB/s · median of ${report.runs} runs</text>
</svg>
`
}

function niceTicks(max) {
    const raw = max / 4
    const mag = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)
    const out = []
    for (let t = 0; t <= max; t += step) out.push(+t.toFixed(6))
    return out
}

module.exports = { renderChart }
