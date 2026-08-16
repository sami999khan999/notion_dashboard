import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { TopBar } from '../components/Shell'
import { getSettings, restoreDefaults, updateSettings } from '../dashboard/settings'
import type { AlertConfig } from '../settings/config'

export const Route = createFileRoute('/settings')({
  loader: () => getSettings(),
  component: SettingsPage,
})

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="m-0 text-[14px] font-semibold">{title}</h2>
      {note ? <p className="mt-1 mb-0 text-[12px] text-ink-3">{note}</p> : null}
      <div className="mt-3 divide-y divide-line">{children}</div>
    </section>
  )
}

/**
 * Label and control sit side by side once there is room, and stack on narrow
 * screens — a right-aligned input next to a two-line hint is unusable at phone
 * width.
 */
function Row({
  label,
  hint,
  custom,
  control,
}: {
  label: React.ReactNode
  hint?: string
  custom?: boolean
  control: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px] text-ink">
          <span className="min-w-0">{label}</span>
          {custom ? (
            <span
              className="pill shrink-0"
              style={{ background: 'rgba(245,165,36,0.16)', color: '#f5a524' }}
              title="Overrides the deployed default"
            >
              custom
            </span>
          ) : null}
        </div>
        {hint ? <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

/** Pill switch, matching the reference's control language. */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[32px] shrink-0 cursor-pointer rounded-full border-0 p-0 transition-colors ${
        checked ? 'bg-accent' : 'bg-track'
      }`}
    >
      <span
        className="absolute top-[3px] h-[12px] w-[12px] rounded-full bg-white transition-all"
        style={{ left: checked ? 17 : 3 }}
      />
    </button>
  )
}

function Num({
  value,
  onChange,
  suffix,
}: {
  value: string | number
  onChange: (v: string) => void
  suffix?: string
}) {
  return (
    <span className="flex items-center gap-1.5">
      <input
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-[72px] rounded-lg border border-line bg-raised px-2.5 py-1.5 text-right font-mono text-[13px] focus:border-accent focus:outline-none"
      />
      {suffix ? <span className="w-6 text-[12px] text-ink-3">{suffix}</span> : null}
    </span>
  )
}

function SettingsPage() {
  const initial = Route.useLoaderData()
  const router = useRouter()

  const [cfg, setCfg] = useState<AlertConfig>(initial.config)
  const [overridden, setOverridden] = useState<string[]>(initial.overridden)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')

  const [qFrom, qTo] = cfg.quietHours.includes('-') ? cfg.quietHours.split('-') : ['', '']

  const set = <K extends keyof AlertConfig>(k: K, v: AlertConfig[K]) => {
    setCfg((c) => ({ ...c, [k]: v }))
    setState('idle')
  }
  const setQuiet = (from: string, to: string) =>
    set('quietHours', from && to ? `${from}-${to}` : '')
  const custom = (k: keyof AlertConfig) => overridden.includes(k)
  const dirty = state === 'idle' && JSON.stringify(cfg) !== JSON.stringify(initial.config)

  async function run(fn: () => Promise<typeof initial>) {
    setState('saving')
    setError('')
    try {
      const next = await fn()
      // The server re-validates and clamps, so adopt what it actually stored
      // rather than assuming local state was accepted verbatim.
      setCfg(next.config)
      setOverridden(next.overridden)
      setState('saved')
      router.invalidate()
    } catch (e) {
      setState('error')
      setError((e as Error).message)
    }
  }

  const sw = (k: keyof AlertConfig, label: string) => (
    <Switch label={label} checked={cfg[k] as boolean} onChange={(v) => set(k, v as any)} />
  )
  const nm = (k: keyof AlertConfig, suffix: string) => (
    <Num
      value={cfg[k] as number}
      onChange={(v) => set(k, (Number(v) || 0) as any)}
      suffix={suffix}
    />
  )

  return (
    <>
      <TopBar
        title="Alert settings"
        meta={
          <>
            Applies on the next sync — no redeploy.{' '}
            {overridden.length === 0
              ? 'All values are the deployed defaults.'
              : `${overridden.length} value${overridden.length === 1 ? '' : 's'} customised.`}
          </>
        }
      />

      <main className="pb-24">
        {/* Two columns once there is room, a single stack on phones. The four
            groups are independent, so pairing them costs nothing and halves the
            scrolling. */}
        <div className="grid items-start gap-3 xl:grid-cols-2">
          <Section title="Timer" note="Time Tracker lifecycle alerts.">
            <Row
              label="Timer started"
              hint="When a timer begins in Notion."
              custom={custom('timerStart')}
              control={sw('timerStart', 'Timer started')}
            />
            <Row
              label="Still running"
              hint="A nudge at each interval while a timer runs."
              custom={custom('timerTick')}
              control={sw('timerTick', 'Still running')}
            />
            <Row
              label="Interval"
              hint="How often the still-running nudge repeats."
              custom={custom('timerTickMinutes')}
              control={nm('timerTickMinutes', 'min')}
            />
            <Row
              label="Timer ended"
              hint="A summary with the total duration."
              custom={custom('timerEnd')}
              control={sw('timerEnd', 'Timer ended')}
            />
          </Section>

          <Section
            title="Routine"
            note="20 active blocks, Sunday to Thursday. Per-block alerts mean about 20 emails a weekday."
          >
            <Row
              label="Block started"
              hint="One email as each routine block begins."
              custom={custom('routineStart')}
              control={sw('routineStart', 'Block started')}
            />
            <Row
              label="Daily digest"
              hint="One email listing the whole day. Turn block alerts off to swap 20 emails for 1."
              custom={custom('routineDigest')}
              control={sw('routineDigest', 'Daily digest')}
            />
            <Row
              label="Digest time"
              hint="Local time, 24-hour."
              custom={custom('digestAt')}
              control={
                <input
                  value={cfg.digestAt}
                  placeholder="07:45"
                  aria-label="Digest time"
                  onChange={(e) => set('digestAt', e.target.value)}
                  className="w-[72px] rounded-lg border border-line bg-raised px-2.5 py-1.5 text-right font-mono text-[13px] focus:border-accent focus:outline-none"
                />
              }
            />
          </Section>

          <Section
            title="Deadlines"
            note="Every task that has a deadline is archived right now, so these are currently silent."
          >
            <Row
              label="24 hours before"
              custom={custom('deadline24h')}
              control={sw('deadline24h', '24 hours before')}
            />
            <Row
              label="1 hour before"
              hint="Skipped automatically for date-only deadlines."
              custom={custom('deadline1h')}
              control={sw('deadline1h', '1 hour before')}
            />
            <Row
              label="At the deadline"
              custom={custom('deadlineHit')}
              control={sw('deadlineHit', 'At the deadline')}
            />
            <Row
              label="Missed"
              hint="Fires once the deadline passes with the task still open."
              custom={custom('deadlineMissed')}
              control={sw('deadlineMissed', 'Missed')}
            />
            <Row
              label="Re-nag daily"
              hint="Off means the overdue alert fires exactly once, ever."
              custom={custom('deadlineMissedRenag')}
              control={sw('deadlineMissedRenag', 'Re-nag daily')}
            />
            <Row
              label="Grace period"
              hint="How long after the deadline before the missed alert fires."
              custom={custom('missedGraceMin')}
              control={nm('missedGraceMin', 'min')}
            />
            <Row
              label="Stale cutoff"
              hint="Suppresses the early warnings for long-past deadlines."
              custom={custom('deadlineStaleHours')}
              control={nm('deadlineStaleHours', 'hr')}
            />
          </Section>

          <Section
            title="Timing"
            note="Quiet hours suppress delivery but still record the alert, so nothing disappears silently."
          >
            <Row
              label="Quiet hours"
              hint="Leave blank to disable. May wrap past midnight."
              custom={custom('quietHours')}
              control={
                <span className="flex items-center gap-1.5">
                  <input
                    value={qFrom}
                    placeholder="00:00"
                    aria-label="Quiet hours start"
                    onChange={(e) => setQuiet(e.target.value, qTo)}
                    className="w-[66px] rounded-lg border border-line bg-raised px-2 py-1.5 text-right font-mono text-[13px] focus:border-accent focus:outline-none"
                  />
                  <span className="text-ink-3">–</span>
                  <input
                    value={qTo}
                    placeholder="07:45"
                    aria-label="Quiet hours end"
                    onChange={(e) => setQuiet(qFrom, e.target.value)}
                    className="w-[66px] rounded-lg border border-line bg-raised px-2 py-1.5 text-right font-mono text-[13px] focus:border-accent focus:outline-none"
                  />
                </span>
              }
            />
            <Row
              label="Lateness window"
              hint="How late a block start may still fire after a delayed sync."
              custom={custom('maxLatenessMin')}
              control={nm('maxLatenessMin', 'min')}
            />
            <Row
              label="UTC offset"
              hint="360 is Asia/Dhaka. Changing this shifts every routine window."
              custom={custom('tzOffsetMinutes')}
              control={nm('tzOffsetMinutes', 'min')}
            />
          </Section>
        </div>

        <p className="mt-4 mb-0 text-[12px] text-ink-3">
          Values are re-validated and clamped on the server on both save and read, so a
          bad number can never reach the alert engine.
        </p>
      </main>

      {/* Sticky action bar: the form is long enough that hunting for a save
          button at the bottom is a real annoyance, especially on a phone. */}
      <div className="fixed right-0 bottom-0 left-0 z-30 border-t border-line bg-card/95 px-4 py-3 backdrop-blur sm:px-6 md:left-[68px]">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => run(() => updateSettings({ data: cfg as any }))}
            disabled={state === 'saving'}
            className="cursor-pointer rounded-full border-0 bg-accent px-5 py-2 text-[13px] font-semibold text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            {state === 'saving' ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={() => run(() => restoreDefaults({}))}
            disabled={state === 'saving' || overridden.length === 0}
            className="cursor-pointer rounded-full border border-line bg-card px-4 py-2 text-[13px] text-ink-2 transition-colors hover:text-ink disabled:opacity-40"
          >
            Reset to defaults
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px]">
            {state === 'saved' ? (
              <span className="text-good">Saved — live on the next sync.</span>
            ) : state === 'error' ? (
              <span className="text-bad">{error}</span>
            ) : dirty ? (
              <span className="text-warn">Unsaved changes</span>
            ) : null}
          </span>
        </div>
      </div>
    </>
  )
}
