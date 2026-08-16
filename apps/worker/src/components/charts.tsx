import { useState } from 'react'
import { KINDS, KIND_ORDER } from '../dashboard/activity'
import type {
  CalendarMonth,
  CategorySlice,
  DayBar,
  HeatCell,
  RibbonBlock,
} from '../dashboard/data'

const MINUTES_PER_DAY = 1440

function hhmm(m: number) {
  const h = Math.floor(m / 60) % 24
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function dur(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

function Tip({ text, sub }: { text: string; sub?: string }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full rounded-lg border border-line-strong bg-raised px-2.5 py-1.5 text-[11px] leading-tight whitespace-nowrap shadow-xl"
    >
      <span className="font-semibold">{text}</span>
      {sub ? <span className="ml-1.5 text-ink-3">{sub}</span> : null}
    </div>
  )
}

export function DeltaPill({ value }: { value: number | null }) {
  if (value == null) return null
  const up = value > 0
  const flat = value === 0
  return (
    <span
      className="pill"
      style={{
        background: flat
          ? 'rgba(255,255,255,0.07)'
          : up
            ? 'rgba(34,197,94,0.16)'
            : 'rgba(240,68,56,0.16)',
        color: flat ? '#9a9a9a' : up ? '#22c55e' : '#f04438',
      }}
      title="Compared with the previous window of the same length"
    >
      {flat ? '—' : up ? '▲' : '▼'}
      {Math.abs(value)}%
    </span>
  )
}

// ---------------------------------------------------------------------------
// Hero bars.
//
// Dark columns with a bright cap at the value, one highlighted. Height encodes
// magnitude; the cap is what makes a short bar readable at a glance on a dark
// ground, where a low dark rectangle otherwise disappears.
// ---------------------------------------------------------------------------

export function HeroBars({
  bars,
  bucketed,
  highlight,
}: {
  bars: DayBar[]
  bucketed: boolean
  highlight: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...bars.map((b) => b.seconds), 1)

  if (bars.length === 0) {
    return <p className="m-0 text-[13px] text-ink-3">No days in this range.</p>
  }

  // Round axis ceiling to a whole number of hours so ticks read cleanly.
  const ceilH = Math.max(1, Math.ceil(max / 3600))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(ceilH * f))
  const scale = (s: number) => (s / (ceilH * 3600)) * 100
  const allEmpty = bars.every((b) => b.seconds === 0)

  return (
    <figure className="m-0">
      <div className="flex gap-3">
        {/* Y axis. No gridlines — the caps already give the eye a datum. */}
        <div className="flex h-[160px] w-6 shrink-0 flex-col-reverse justify-between text-right sm:h-[200px] sm:w-8">
          {ticks.map((t, i) => (
            <span key={i} className="text-[10px] leading-none text-ink-3">
              {t}h
            </span>
          ))}
        </div>

        <div className="relative flex h-[160px] flex-1 items-end gap-[3px] sm:h-[200px] sm:gap-[6px]">
          {bars.map((b, i) => {
            const on = i === highlight && b.seconds > 0
            const h = b.seconds === 0 ? 0 : Math.max(2, scale(b.seconds))
            return (
              <div
                key={b.date}
                className="group relative flex h-full flex-1 items-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                title={`${b.date}: ${b.seconds > 0 ? dur(b.seconds) : 'nothing tracked'}`}
              >
                {b.seconds === 0 ? (
                  // A hairline, so an empty day reads as "nothing happened"
                  // rather than as missing data.
                  <div className="h-[2px] w-full rounded-full bg-line" />
                ) : (
                  <div
                    className="relative w-full rounded-t-lg transition-colors"
                    style={{
                      height: `${h}%`,
                      background: on ? 'var(--color-accent)' : '#1c1c1c',
                    }}
                  >
                    <span
                      className="absolute inset-x-0 top-0 h-[3px] rounded-full"
                      style={{ background: on ? '#fff' : 'rgba(255,255,255,0.55)' }}
                      aria-hidden
                    />
                    {on ? (
                      <span className="absolute inset-x-0 bottom-1.5 truncate px-1 text-center text-[10px] font-semibold text-white">
                        {dur(b.seconds)}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}

          {hover !== null && bars[hover] ? (
            <div
              className="absolute top-0"
              style={{ left: `${((hover + 0.5) / bars.length) * 100}%` }}
            >
              <Tip
                text={
                  bars[hover].seconds > 0 ? dur(bars[hover].seconds) : 'Nothing tracked'
                }
                sub={bars[hover].date}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex gap-[3px] pl-8 sm:gap-[6px] sm:pl-11">
        {bars.map((b, i) => (
          <span
            key={b.date}
            className="flex-1 overflow-hidden text-center text-[10px] whitespace-nowrap text-ink-3"
          >
            {bucketed
              ? i % 2 === 0
                ? b.date.slice(5)
                : ''
              : bars.length <= 15
                ? b.dow
                : i % 3 === 0
                  ? b.dow
                  : ''}
          </span>
        ))}
      </div>

      {allEmpty ? (
        <p className="mt-3 mb-0 text-[12px] text-ink-3">
          Nothing tracked in this window. Start a timer in Notion and it shows up here
          within a minute.
        </p>
      ) : null}
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Donut — share of a whole.
//
// Angle is a weak channel for comparison, so every slice is also listed with
// its exact duration and percentage. The chart shows the shape; the legend
// carries the numbers.
// ---------------------------------------------------------------------------

export function Donut({
  slices,
  total,
  centerLabel,
}: {
  slices: CategorySlice[]
  total: number
  centerLabel: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const R = 68
  const STROKE = 26
  const C = 2 * Math.PI * R
  const SIZE = 170

  if (slices.length === 0 || total === 0) {
    return (
      <div className="py-8 text-center text-[13px] text-ink-3">
        No tracked time in this range, so there is nothing to break down.
      </div>
    )
  }

  let offset = 0
  const arcs = slices.map((s) => {
    const frac = s.seconds / total
    // 2px of surface between segments so adjacent fills never merge.
    const len = Math.max(0, frac * C - 2)
    const arc = { ...s, len, gap: C - len, offset }
    offset += frac * C
    return arc
  })

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0">
        <svg width={SIZE} height={SIZE} role="img" aria-label="Share of tracked time by category">
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {arcs.map((a, i) => (
              <circle
                key={a.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                fill="none"
                stroke={a.color}
                strokeWidth={hover === i ? STROKE + 4 : STROKE}
                strokeDasharray={`${a.len} ${a.gap}`}
                strokeDashoffset={-a.offset}
                strokeLinecap="butt"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer', transition: 'stroke-width 90ms ease' }}
              >
                <title>{`${a.label}: ${dur(a.seconds)} (${a.share}%)`}</title>
              </circle>
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[20px] leading-none font-semibold">{centerLabel}</span>
          <span className="mt-1 text-[11px] text-ink-3">
            {hover !== null ? slices[hover].label : 'Total'}
          </span>
        </div>
      </div>

      <ul className="m-0 w-full list-none space-y-1.5 p-0">
        {slices.map((s, i) => (
          <li
            key={s.label}
            className="flex items-baseline gap-2 rounded-md px-1.5 py-0.5 text-[12px] transition-colors"
            style={{ background: hover === i ? 'rgba(255,255,255,0.05)' : undefined }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              className="h-2 w-2 shrink-0 translate-y-[1px] rounded-full"
              style={{ background: s.color }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-2">{dur(s.seconds)}</span>
            <span className="w-8 shrink-0 text-right font-mono text-[11px] text-ink-3">
              {s.share}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calendar — the month, shaded by how much was tracked each day.
// ---------------------------------------------------------------------------

const CAL_STEPS = ['transparent', 'rgba(59,130,246,0.18)', 'rgba(59,130,246,0.34)', 'rgba(59,130,246,0.55)', '#3b82f6'] as const

export function Calendar({ month }: { month: CalendarMonth }) {
  return (
    <div>
      <div className="mb-3 grid grid-cols-7 gap-1">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="text-center text-[10px] text-ink-3">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {month.days.map((d, i) =>
          !d.inMonth ? (
            <span key={i} className="hatched aspect-square rounded-md" aria-hidden />
          ) : (
            <span
              key={i}
              title={`${d.date}: ${d.seconds > 0 ? dur(d.seconds) : 'nothing tracked'}`}
              className={`grid aspect-square place-items-center rounded-md text-[12px] tabular-nums ${
                d.isToday ? 'font-semibold text-white ring-1 ring-accent' : 'text-ink-2'
              }`}
              style={{
                background: d.isToday ? 'var(--color-accent)' : CAL_STEPS[d.level],
                color: d.isToday || d.level >= 4 ? '#fff' : undefined,
              }}
            >
              {d.day}
            </span>
          ),
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Day ribbon — the signature.
//
// The routine tiles a complete, gapless 24 hours. That is a real and unusual
// property of this data, so the chart is one continuous band rather than a row
// of separate bars: the day is a single object, and the gaps you don't see are
// the point.
// ---------------------------------------------------------------------------

export function DayRibbon({ blocks, nowMin }: { blocks: RibbonBlock[]; nowMin: number }) {
  const [hover, setHover] = useState<RibbonBlock | null>(null)

  if (blocks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">
        No routine blocks today — every Friday and Saturday block is archived in Notion.
      </div>
    )
  }

  const pct = (m: number) => (m / MINUTES_PER_DAY) * 100

  return (
    <figure className="m-0">
      <div className="relative">
        <div
          className="relative flex h-14 w-full overflow-hidden rounded-xl sm:h-12"
          role="img"
          aria-label={`Today's routine: ${blocks.length} blocks covering 24 hours`}
        >
          {blocks.map((b) => {
            const spec = KINDS[b.kind]
            const wide = b.lengthMin >= 90
            // Elapsed blocks recede by swapping the fill for a low-alpha tint
            // and the label for light ink. Fading the whole block with opacity
            // would fade the label too, leaving unreadable text.
            const past = b.state === 'past'
            return (
              <div
                key={b.id}
                onMouseEnter={() => setHover(b)}
                onMouseLeave={() => setHover(null)}
                style={{
                  width: `${pct(b.lengthMin)}%`,
                  background: past ? spec.tint : spec.color,
                  color: past ? '#9a9a9a' : spec.onSolid,
                }}
                className={`relative min-w-[2px] border-r-2 border-card last:border-r-0 ${
                  b.state === 'active' ? 'ring-2 ring-white ring-inset' : ''
                }`}
                title={`${b.activity} · ${hhmm(b.startMin)}–${hhmm(b.endMin)} · ${dur(b.lengthMin * 60)}`}
              >
                {wide ? (
                  <span className="pointer-events-none absolute inset-0 flex items-center px-2.5 text-[11px] font-semibold">
                    <span className="truncate">{b.activity}</span>
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>

        <div
          className="pointer-events-none absolute -top-1 -bottom-1 z-20 w-[3px] rounded-full bg-white ring-2 ring-page"
          style={{ left: `calc(${pct(nowMin)}% - 1.5px)` }}
          aria-hidden
        />

        {hover ? (
          <div
            className="absolute -top-1"
            style={{ left: `${pct(hover.startMin + hover.lengthMin / 2)}%` }}
          >
            <Tip
              text={hover.activity}
              sub={`${hhmm(hover.startMin)}–${hhmm(hover.endMin)} · ${dur(hover.lengthMin * 60)}`}
            />
          </div>
        ) : null}
      </div>

      <div className="relative mt-1.5 h-3">
        {[0, 6, 12, 18, 24].map((h) => (
          <span
            key={h}
            className="absolute -translate-x-1/2 text-[10px] text-ink-3"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            {String(h).padStart(2, '0')}
          </span>
        ))}
      </div>

      {/* The legend names each kind AND what it covers, so the grouping is
          never something you reverse-engineer from the colours. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {KIND_ORDER.filter((k) => blocks.some((b) => b.kind === k)).map((k) => {
          const spec = KINDS[k]
          const mins = blocks.filter((b) => b.kind === k).reduce((s, b) => s + b.lengthMin, 0)
          return (
            <span key={k} className="flex items-baseline gap-1.5 text-[11px]">
              <span
                className="h-2 w-2 shrink-0 translate-y-[1px] rounded-full"
                style={{ background: spec.color }}
                aria-hidden
              />
              <span className="text-ink">{spec.label}</span>
              <span className="font-mono text-ink-3">{dur(mins * 60)}</span>
              <span className="text-ink-3">· {spec.covers}</span>
            </span>
          )
        })}
      </div>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Focus heatmap — sequential, one hue.
//
// Chosen over a bar chart of the full history because tracking is sparse: 53
// active days across seven months. A bar chart would be mostly empty slots; a
// density grid makes the gaps themselves readable.
// ---------------------------------------------------------------------------

const HEAT_STEPS = [
  '#1b1b1b',
  'rgba(59,130,246,0.28)',
  'rgba(59,130,246,0.5)',
  'rgba(59,130,246,0.74)',
  '#3b82f6',
] as const

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export function FocusHeatmap({ cells, weeks }: { cells: HeatCell[]; weeks: number }) {
  const [hover, setHover] = useState<HeatCell | null>(null)

  // Geometry is in viewBox units, and the SVG scales to the container width.
  // Positioning the tooltip in PERCENTAGES of those units keeps it aligned at
  // any rendered size — pixel offsets would drift as soon as the SVG scales.
  const CELL = 12
  const GAP = 3
  const PITCH = CELL + GAP
  const LEFT = 24 // gutter for the weekday initials
  const TOP = 16 // band for the month labels
  const W = LEFT + weeks * PITCH
  const H = TOP + 7 * PITCH

  // One label per month, placed on the column holding that month's first day.
  const monthLabels: Array<{ col: number; text: string }> = []
  let lastMonth = ''
  for (const c of cells) {
    const month = c.date.slice(0, 7)
    if (month !== lastMonth) {
      lastMonth = month
      // Skip a label that would overflow the right edge.
      if (c.col <= weeks - 3) {
        monthLabels.push({ col: c.col, text: MONTH_ABBR[Number(c.date.slice(5, 7)) - 1] })
      }
    }
  }

  const xOf = (col: number) => LEFT + col * PITCH
  const yOf = (row: number) => TOP + row * PITCH

  return (
    <figure className="m-0">
      {/* The tooltip lives OUTSIDE any clipping context. Previously it sat
          inside the scroll container, so a tooltip on the top row was cut off
          by the overflow — which is exactly where the cursor lands most. */}
      <div className="relative w-full" style={{ maxWidth: Math.round(W * 1.28) }}>
        {/* Scales DOWN to fit narrow screens but is capped on the way up:
            unconstrained `width: 100%` blew the cells up to ~20px on a wide
            card. maxWidth pins the largest cell at roughly 15px, and on a phone
            the same viewBox shrinks to ~9px cells without ever needing a
            scrollbar — which is what kept the tooltip un-clippable. */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMinYMid meet"
          role="img"
          aria-label={`Tracked time per day over the last ${weeks} weeks`}
          className="block w-full"
          style={{ maxWidth: Math.round(W * 1.28) }}
        >
          {monthLabels.map((m) => (
            <text
              key={`${m.col}-${m.text}`}
              x={xOf(m.col)}
              y={TOP - 6}
              fill="#6b6b6b"
              style={{ fontSize: 9 }}
            >
              {m.text}
            </text>
          ))}

          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) =>
            i % 2 === 1 ? (
              <text
                key={i}
                x={0}
                y={yOf(i) + CELL - 2}
                fill="#6b6b6b"
                style={{ fontSize: 9 }}
              >
                {d}
              </text>
            ) : null,
          )}

          {cells.map((c) => (
            <rect
              key={c.date}
              x={xOf(c.col)}
              y={yOf(c.row)}
              width={CELL}
              height={CELL}
              rx={3}
              fill={HEAT_STEPS[c.level]}
              onMouseEnter={() => setHover(c)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: c.seconds > 0 ? 'pointer' : 'default' }}
            >
              <title>{`${c.date}: ${c.seconds > 0 ? dur(c.seconds) : 'nothing tracked'}`}</title>
            </rect>
          ))}
        </svg>

        {hover ? (
          <div
            className="pointer-events-none absolute"
            style={{
              left: `${((xOf(hover.col) + CELL / 2) / W) * 100}%`,
              top: `${((yOf(hover.row) + (hover.row <= 1 ? CELL + 4 : 0)) / H) * 100}%`,
            }}
          >
            {/* Rows 0-1 have no room above them, so their tooltip flips below
                the cell rather than being clipped or covering the month band. */}
            <div className={hover.row <= 1 ? 'translate-y-full' : ''}>
              <Tip
                text={hover.seconds > 0 ? dur(hover.seconds) : 'Nothing tracked'}
                sub={hover.date}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[11px] text-ink-3">
          {cells.filter((c) => c.seconds > 0).length} active days in this window
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] text-ink-3">less</span>
          {HEAT_STEPS.map((st) => (
            <span
              key={st}
              className="h-[10px] w-[10px] rounded-[3px]"
              style={{ background: st }}
              aria-hidden
            />
          ))}
          <span className="text-[10px] text-ink-3">more</span>
        </span>
      </div>
    </figure>
  )
}


/** Delivery-health meter, in the shape of the reference's score bar. */
export function ScoreMeter({ value }: { value: number }) {
  const bars = 40
  const lit = Math.round((value / 100) * bars)
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-6 flex-1 items-end gap-[2px]" role="img" aria-label={`Delivery score ${value} out of 100`}>
        {Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            className="flex-1 rounded-full"
            style={{
              height: `${40 + (i % 5) * 14}%`,
              background:
                i < lit
                  ? `hsl(${140 - (i / bars) * 20} 60% ${45 + (i % 5) * 3}%)`
                  : 'rgba(255,255,255,0.08)',
            }}
          />
        ))}
      </div>
      <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums">{value}</span>
    </div>
  )
}
