import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { AccountChip, TopBar } from '../components/Shell'
import {
  Calendar,
  DayRibbon,
  DeltaPill,
  Donut,
  FocusHeatmap,
  HeroBars,
  ScoreMeter,
  dur,
} from '../components/charts'
import { KINDS } from '../dashboard/activity'
import { RANGES, getDashboardData } from '../dashboard/data'
import type { RangeId } from '../dashboard/data'

export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>): { range: RangeId } => ({
    range: (RANGES.some((r) => r.id === s.range) ? s.range : '30d') as RangeId,
  }),
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ deps }) => getDashboardData({ data: deps.range }),
  // The cron writes the mirror once a minute; anything tighter is wasted work.
  staleTime: 30_000,
  component: Dashboard,
})

function hhmm(m: number) {
  const h = Math.floor(m / 60) % 24
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function Card({
  title,
  desc,
  right,
  children,
  className = '',
}: {
  title?: string
  desc?: string
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      {title ? (
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
          {right}
        </div>
      ) : null}
      {/* Every card says what it measures. A chart that needs explaining in a
          tooltip is a chart nobody reads. */}
      {desc ? <p className="mt-0 mb-4 text-[12px] text-ink-3">{desc}</p> : <div className="mb-4" />}
      {children}
    </section>
  )
}

function MiniStat({
  label,
  value,
  badge,
  badgeTone = 'neutral',
}: {
  label: string
  value: string
  badge?: string
  badgeTone?: 'good' | 'warn' | 'neutral'
}) {
  const tone =
    badgeTone === 'good'
      ? { background: 'rgba(34,197,94,0.16)', color: '#22c55e' }
      : badgeTone === 'warn'
        ? { background: 'rgba(245,165,36,0.16)', color: '#f5a524' }
        : { background: 'rgba(255,255,255,0.07)', color: '#9a9a9a' }
  return (
    <div className="card-inner p-3.5">
      <div className="mb-2 text-[11px] text-ink-3">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[19px] leading-none font-semibold">{value}</span>
        {badge ? (
          <span className="pill shrink-0" style={tone}>
            {badge}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function TestEmailButton() {
  const [state, setState] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle')
  const [detail, setDetail] = useState('')

  async function send() {
    setState('sending')
    setDetail('')
    try {
      const res = await fetch('/test-email', { method: 'POST' })
      const body: any = await res.json().catch(() => ({}))
      if (res.ok && body.ok) {
        setState('ok')
        setDetail('Sent')
      } else {
        setState('error')
        setDetail(body.error ?? `Missing: ${(body.missing ?? []).join(', ')}`)
      }
    } catch (e) {
      setState('error')
      setDetail((e as Error).message)
    }
  }

  return (
    <span className="flex items-center gap-2">
      {detail ? (
        <span
          className={`max-w-[14rem] truncate text-[12px] ${state === 'error' ? 'text-bad' : 'text-good'}`}
          title={detail}
        >
          {detail}
        </span>
      ) : null}
      <button
        type="button"
        onClick={send}
        disabled={state === 'sending'}
        className="cursor-pointer rounded-full border border-line bg-card px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink disabled:opacity-50"
      >
        {state === 'sending' ? 'Sending…' : 'Test email'}
      </button>
    </span>
  )
}

function RangePicker({ value }: { value: RangeId }) {
  const router = useRouter()
  return (
    // Six pills do not fit a 360px screen. Scrolling the strip keeps every
    // option reachable without wrapping into a second row that shifts the
    // whole card header.
    <div
      className="n-scroll -mx-1 max-w-full overflow-x-auto px-1"
      role="group"
      aria-label="Analytics window"
    >
      <div className="seg w-max">
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-pressed={value === r.id}
          onClick={() => router.navigate({ to: '/', search: { range: r.id }, replace: true })}
        >
          {r.label}
        </button>
      ))}
      </div>
    </div>
  )
}

function Dashboard() {
  const d = Route.useLoaderData()
  const a = d.analytics
  const spec = d.current ? KINDS[d.current.kind] : null

  const dayPct = d.routineTotalMin
    ? Math.round((d.routineDoneMin / d.routineTotalMin) * 100)
    : 0

  // Highlight today's bar when it has data, otherwise the busiest in range —
  // the highlight should always land on something worth reading.
  const busiestIdx = a.bars.reduce((best, b, i) => (b.seconds > a.bars[best].seconds ? i : best), 0)
  const todayIdx = a.bars.findIndex((b) => b.date === d.localDate)
  const highlight = todayIdx >= 0 && a.bars[todayIdx].seconds > 0 ? todayIdx : busiestIdx

  return (
    <>
      <TopBar
        title="Overview"
        meta={
          <>
            {d.today}, {d.localDate} · <span className="font-mono">{d.localTime}</span> in
            Dhaka · {dayPct}% of today elapsed
          </>
        }
        right={
          <>
            <TestEmailButton />
            <AccountChip
              status={d.running.length > 0 ? 'Timer running' : 'No timer running'}
            />
          </>
        }
      />

      {/* Signature strip: the whole day as one continuous band. */}
      <Card
        title="Your day"
        desc={`All ${d.ribbon.length} routine blocks from Notion, coloured by what kind of time they are. Faded blocks have passed; the white line is now.`}
        right={
          d.current ? (
            <span className="flex items-center gap-2 text-[12px]">
              <span className="pill" style={{ background: spec!.tint, color: spec!.color }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: spec!.color }} aria-hidden />
                Now · {d.current.activity}
              </span>
              <span className="font-mono text-ink-3">ends {hhmm(d.current.endMin)}</span>
            </span>
          ) : (
            <span className="text-[12px] text-ink-3">Nothing scheduled right now</span>
          )
        }
        className="mb-4"
      >
        <DayRibbon blocks={d.ribbon} nowMin={d.nowMin} />
      </Card>

      {/* Hero row: tracked time + calendar. */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-[15px] font-semibold">Tracked time</h2>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-[28px] leading-none font-semibold tracking-tight sm:text-[34px]">
                  {a.totalLabel}
                </span>
                <DeltaPill value={a.deltaPct} />
                <span className="text-[12px] text-ink-3">
                  {a.prevTotalSeconds > 0
                    ? `vs ${dur(a.prevTotalSeconds)} previous ${a.days}d`
                    : 'no data in the previous window'}
                </span>
              </div>
            </div>
            <RangePicker value={a.range} />
          </div>

          <HeroBars bars={a.bars} bucketed={a.bucketed} highlight={highlight} />

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <MiniStat label="Active days" value={`${a.activeDays}/${a.days}`} />
            <MiniStat label="Avg active day" value={a.avgActiveDayLabel} />
            <MiniStat label="Sessions" value={String(a.sessions)} />
            <MiniStat
              label="Busiest"
              value={a.busiestLabel}
              badge={a.busiestDate?.slice(5)}
            />
          </div>
        </Card>

        <Card
          title={d.calendar.label}
          desc="Days shaded by how much you tracked. Today is highlighted."
        >
          <Calendar month={d.calendar} />
          <div className="card-inner mt-4 flex items-center justify-between gap-3 p-3.5">
            <div>
              <div className="text-[11px] text-ink-3">This month</div>
              <div className="mt-1 text-[19px] leading-none font-semibold">
                {d.calendar.monthLabel}
              </div>
            </div>
            <DeltaPill value={d.calendar.deltaPct} />
          </div>
        </Card>
      </div>

      {/* Detail row. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card
          title="Today at a glance"
          desc="What is happening now and what comes next."
        >
          <div className="space-y-2.5">
            <MiniStat
              label="Tracked today"
              value={d.todayLabel}
              badge={d.running.length > 0 ? 'Running' : undefined}
              badgeTone="good"
            />
            <MiniStat
              label="Current block"
              value={d.current ? d.current.activity : 'Free'}
              badge={d.current ? KINDS[d.current.kind].label : undefined}
            />
            <MiniStat
              label="Up next"
              value={d.next ? d.next.activity : '—'}
              badge={d.next ? hhmm(d.next.startMin) : undefined}
            />
            <div className="grid grid-cols-2 gap-2.5">
              <MiniStat label="Open tasks" value={String(d.openTasks)} />
              <MiniStat label="Completed" value={String(d.completedTasks)} />
            </div>
          </div>
        </Card>

        <Card
          title="Where the time went"
          desc={`Time Tracker categories, ${a.rangeLabel.toLowerCase()}. Exact figures are in the list — angles are only the shape.`}
        >
          <Donut slices={a.categories} total={a.totalSeconds} centerLabel={a.totalLabel} />
        </Card>

        <Card
          title="Alerts"
          desc="What the cron has emailed. Failures show their reason instead of disappearing."
        >
          <div className="card-inner mb-3 p-3.5">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[11px] text-ink-3">Delivery score</span>
              <span className="text-[11px] text-ink-3">
                {d.alertsSent} sent · {d.alertsFailed} failed
              </span>
            </div>
            <ScoreMeter value={d.deliveryScore} />
          </div>

          {d.alerts.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-3">
              Nothing sent yet. Alerts appear here as they go out.
            </p>
          ) : (
            <ul className="n-scroll m-0 max-h-[220px] list-none space-y-2 overflow-y-auto p-0">
              {d.alerts.map((al, i) => (
                <li key={i} className="flex items-center gap-2.5">
                  <span className="w-9 shrink-0 font-mono text-[11px] text-ink-3">
                    {al.sentAt.slice(11, 16)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{al.message}</span>
                  <span
                    className="pill shrink-0"
                    style={
                      al.status === 'sent'
                        ? { background: 'rgba(34,197,94,0.16)', color: '#22c55e' }
                        : al.status === 'suppressed'
                          ? { background: 'rgba(255,255,255,0.07)', color: '#9a9a9a' }
                          : { background: 'rgba(240,68,56,0.16)', color: '#f04438' }
                    }
                    title={al.status}
                  >
                    {al.status === 'sent' ? 'Sent' : al.status === 'suppressed' ? 'Quiet' : 'Failed'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Focus history"
          desc="Every day of the last six months, brighter where more time was tracked. Independent of the range above — this is the long view."
          className="sm:col-span-2 lg:col-span-2"
        >
          <FocusHeatmap cells={d.heat} weeks={d.heatWeeks} />
        </Card>

        <Card title="Deadlines" desc="Open tasks with a due date, soonest first.">
          {d.deadlines.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-3">
              Nothing due. Every task that has a deadline is archived, so the deadline
              alerts are currently silent.
            </p>
          ) : (
            <ul className="m-0 list-none space-y-2 p-0">
              {d.deadlines.map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px]">{t.title}</span>
                  <span
                    className="pill shrink-0"
                    style={
                      t.overdue
                        ? { background: 'rgba(240,68,56,0.16)', color: '#f04438' }
                        : { background: 'rgba(255,255,255,0.07)', color: '#9a9a9a' }
                    }
                  >
                    {t.deadline.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <footer className="mt-6 pb-4 text-[12px] text-ink-3">
        Mirrors Notion every minute · last sync{' '}
        <span className="font-mono">
          {d.lastSync ? d.lastSync.replace('T', ' ').slice(0, 16) : '—'}
        </span>{' '}
        UTC · read-only, start and stop timers in Notion
      </footer>
    </>
  )
}
