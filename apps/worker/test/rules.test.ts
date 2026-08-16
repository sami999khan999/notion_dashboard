/**
 * Alert rule tests — the exit criteria from context/phase-4-alert-engine/goals.md.
 *
 * Every rule takes `now` as a parameter, so all of this runs against a frozen
 * clock in plain Node. No Workers runtime, no waiting on real time.
 */
import { describe, expect, it } from 'vitest'
import { configFromEnv } from '../src/settings/config'
import type { AlertConfig } from '../src/settings/config'
import type { AppEnv } from '../src/config'
import { ruleDeadlines } from '../src/alerts/rules/deadline'
import { ruleRoutineDigest, ruleRoutineStart } from '../src/alerts/rules/routine'
import {
  ruleTimerEnded,
  ruleTimerStarted,
  ruleTimerTick,
} from '../src/alerts/rules/timer'
import type {
  RoutineSnapshot,
  RuleContext,
  TaskSnapshot,
  TimerPrev,
  TimerSnapshot,
} from '../src/alerts/types'


function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ALERT_TZ_OFFSET_MINUTES: '360',
    ALERT_MAX_LATENESS_MIN: '10',
    ALERT_DEADLINE_STALE_HOURS: '24',
    ALERT_MISSED_GRACE_MIN: '60',
    ALERT_QUIET_HOURS: '',
    DIGEST_AT: '07:45',
    ALERT_TIMER_START: 'true',
    ALERT_TIMER_TICK: 'true',
    ALERT_TIMER_TICK_MINUTES: '30',
    ALERT_TIMER_END: 'true',
    ALERT_DEADLINE_24H: 'true',
    ALERT_DEADLINE_1H: 'true',
    ALERT_DEADLINE_HIT: 'true',
    ALERT_DEADLINE_MISSED: 'true',
    ALERT_DEADLINE_MISSED_RENAG: 'true',
    ALERT_ROUTINE_START: 'true',
    ALERT_ROUTINE_DIGEST: 'false',
    ...overrides,
  } as AppEnv
}

/**
 * Build a RuleContext through the real env -> AlertConfig path, so these tests
 * also exercise the coercion and clamping in settings/config.ts rather than
 * hand-constructing a config object the production code would never produce.
 */
function ctx(nowIso: string, overrides: Partial<AppEnv> = {}): RuleContext {
  const cfg: AlertConfig = configFromEnv(env(overrides))
  return { cfg, now: new Date(nowIso), offset: cfg.tzOffsetMinutes }
}

function timer(p: Partial<TimerSnapshot> = {}): TimerSnapshot {
  return {
    notion_id: 't1',
    name: 'Deep work',
    task_id: null,
    status: 'Running',
    start_time: null,
    end_time: null,
    total_seconds: 0,
    notified_bucket: 0,
    ...p,
  }
}

function routine(p: Partial<RoutineSnapshot> = {}): RoutineSnapshot {
  return {
    notion_id: 'r1',
    activity: 'Work',
    time: '09:00 - 13:00',
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'],
    archived: 0,
    done: 0,
    ...p,
  }
}

function task(p: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    notion_id: 'k1',
    title: 'Ship the thing',
    deadline: null,
    completed: 0,
    archived: 0,
    ...p,
  }
}

// ---------------------------------------------------------------------------
// E8 — routine block start. The highest-risk logic in the app.
// ---------------------------------------------------------------------------

describe('E8 routine block start', () => {
  // 2026-08-17T03:00:00Z === Monday 09:00 in Asia/Dhaka (+06:00)
  const MON_0900_UTC = '2026-08-17T03:00:00.000Z'

  it('fires exactly at the local start minute', () => {
    const out = ruleRoutineStart(ctx(MON_0900_UTC), [routine()])
    expect(out).toHaveLength(1)
    expect(out[0].rule).toBe('E8')
    expect(out[0].threshold).toBe('2026-08-17T09:00')
    expect(out[0].subject).toContain('09:00 – 13:00')
  })

  it('TIMEZONE REGRESSION GUARD: must NOT fire when the offset is dropped', () => {
    // Same instant, but interpreting times as UTC. If this ever produces an
    // alert, the offset is not being applied and every routine email is six
    // hours off.
    const out = ruleRoutineStart(
      ctx(MON_0900_UTC, { ALERT_TZ_OFFSET_MINUTES: '0' }),
      [routine()],
    )
    expect(out).toHaveLength(0)
  })

  it('does not fire past the lateness window', () => {
    // 09:11 local — 11 minutes late, window is 10.
    expect(
      ruleRoutineStart(ctx('2026-08-17T03:11:00.000Z'), [routine()]),
    ).toHaveLength(0)
  })

  it('still fires when a tick is a few minutes late', () => {
    // 09:07 local — inside the 10-minute window.
    expect(
      ruleRoutineStart(ctx('2026-08-17T03:07:00.000Z'), [routine()]),
    ).toHaveLength(1)
  })

  it('attributes a midnight-spanning block to the day it STARTED', () => {
    // Tuesday 00:02 local === 2026-08-17T18:02Z. The 23:55 block started
    // Monday, so both the weekday check and the dedupe key must say Monday.
    const out = ruleRoutineStart(ctx('2026-08-17T18:02:00.000Z'), [
      routine({ activity: 'Exercise', time: '23:55 - 00:00' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].threshold).toBe('2026-08-17T23:55') // Monday, not Tuesday
  })

  it('is silent on days not in Days (Fri/Sat under current data)', () => {
    // 2026-08-21 is a Friday. Every real Fri/Sat row is archived, but the
    // weekday filter must hold regardless.
    expect(
      ruleRoutineStart(ctx('2026-08-21T03:00:00.000Z'), [routine()]),
    ).toHaveLength(0)
  })

  it('skips archived rows', () => {
    expect(
      ruleRoutineStart(ctx(MON_0900_UTC), [routine({ archived: 1 })]),
    ).toHaveLength(0)
  })

  it('skips a malformed Time instead of throwing', () => {
    expect(() =>
      ruleRoutineStart(ctx(MON_0900_UTC), [routine({ time: 'whenever' })]),
    ).not.toThrow()
    expect(
      ruleRoutineStart(ctx(MON_0900_UTC), [routine({ time: 'whenever' })]),
    ).toHaveLength(0)
  })

  it('respects the off switch', () => {
    expect(
      ruleRoutineStart(ctx(MON_0900_UTC, { ALERT_ROUTINE_START: 'false' }), [
        routine(),
      ]),
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// E1 / E2 / E3 — timer lifecycle
// ---------------------------------------------------------------------------

describe('E1 timer started', () => {
  const now = '2026-08-17T03:00:00.000Z'
  const started = timer({ start_time: '2026-08-17T02:55:00.000Z' })

  it('fires on first sight of a running timer', () => {
    const out = ruleTimerStarted(ctx(now), [started], new Map())
    expect(out).toHaveLength(1)
    expect(out[0].threshold).toBe('start')
  })

  it('does not re-fire while it stays running', () => {
    const prev = new Map<string, TimerPrev>([
      ['t1', { status: 'Running', end_time: null }],
    ])
    expect(ruleTimerStarted(ctx(now), [started], prev)).toHaveLength(0)
  })

  it('ignores a stopped timer', () => {
    const stopped = timer({
      status: 'Stoped',
      start_time: '2026-08-17T02:00:00.000Z',
      end_time: '2026-08-17T02:30:00.000Z',
    })
    expect(ruleTimerStarted(ctx(now), [stopped], new Map())).toHaveLength(0)
  })
})

describe('E2 timer tick', () => {
  // Started 95 minutes before now.
  const now = '2026-08-17T04:35:00.000Z'
  const running = timer({ start_time: '2026-08-17T03:00:00.000Z' })

  it('emits only the current highest bucket', () => {
    const out = ruleTimerTick(ctx(now), [running])
    expect(out).toHaveLength(1)
    expect(out[0].threshold).toBe('90m') // not 30m/60m as well
  })

  it('does not re-emit an already-notified bucket', () => {
    expect(
      ruleTimerTick(ctx(now), [timer({ ...running, notified_bucket: 3 })]),
    ).toHaveLength(0)
  })

  it('stays silent before the first interval', () => {
    expect(
      ruleTimerTick(ctx('2026-08-17T03:20:00.000Z'), [running]),
    ).toHaveLength(0)
  })

  it('ignores a stopped timer even if long', () => {
    expect(
      ruleTimerTick(ctx(now), [
        timer({ ...running, status: 'Stoped', end_time: now }),
      ]),
    ).toHaveLength(0)
  })
})

describe('E3 timer ended', () => {
  const now = '2026-08-17T04:00:00.000Z'
  const prev = new Map<string, TimerPrev>([
    ['t1', { status: 'Running', end_time: null }],
  ])

  it('fires once on the running -> stopped transition', () => {
    const stopped = timer({
      status: 'Stoped',
      start_time: '2026-08-17T03:00:00.000Z',
      end_time: '2026-08-17T04:00:00.000Z',
    })
    const out = ruleTimerEnded(ctx(now), [stopped], prev)
    expect(out).toHaveLength(1)
    // Duration computed locally: Notion's formula would still read 0.
    expect(out[0].subject).toContain('1h')
  })

  it('does not fire while still running', () => {
    expect(
      ruleTimerEnded(ctx(now), [timer({ start_time: '2026-08-17T03:00:00.000Z' })], prev),
    ).toHaveLength(0)
  })

  it('does not fire for a timer that was already stopped', () => {
    const stopped = timer({ status: 'Stoped', end_time: now })
    expect(ruleTimerEnded(ctx(now), [stopped], new Map())).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// E4 / E5 / E6 / E7 — deadlines
// ---------------------------------------------------------------------------

describe('deadline rules', () => {
  const rules = (out: ReturnType<typeof ruleDeadlines>) => out.map((a) => a.rule)

  it('E4 fires inside the 24h window for a datetime deadline', () => {
    // Deadline 2026-08-18T12:00+06:00; now is 20h before.
    const out = ruleDeadlines(ctx('2026-08-17T10:00:00.000Z'), [
      task({ deadline: '2026-08-18T12:00:00.000+06:00' }),
    ])
    expect(rules(out)).toContain('E4')
    expect(rules(out)).not.toContain('E6')
  })

  it('E5 fires inside the final hour', () => {
    // 30 minutes before 2026-08-18T12:00+06:00 (= 06:00Z).
    const out = ruleDeadlines(ctx('2026-08-18T05:30:00.000Z'), [
      task({ deadline: '2026-08-18T12:00:00.000+06:00' }),
    ])
    expect(rules(out)).toContain('E5')
  })

  it('E5 is SKIPPED for a date-only deadline', () => {
    // Date-only resolves to 23:59 local; an hour before is 22:59 local
    // (16:59Z). Even sitting exactly there, E5 must not fire.
    const out = ruleDeadlines(ctx('2026-08-18T17:30:00.000Z'), [
      task({ deadline: '2026-08-18' }),
    ])
    expect(rules(out)).not.toContain('E5')
  })

  it('E4 for a date-only deadline anchors to 09:00 the previous day', () => {
    // 2026-08-17T09:00 local = 03:00Z. Deadline date 2026-08-18.
    const out = ruleDeadlines(ctx('2026-08-17T03:05:00.000Z'), [
      task({ deadline: '2026-08-18' }),
    ])
    expect(rules(out)).toContain('E4')
  })

  it('E6 fires once the deadline passes', () => {
    const out = ruleDeadlines(ctx('2026-08-18T06:05:00.000Z'), [
      task({ deadline: '2026-08-18T12:00:00.000+06:00' }),
    ])
    expect(rules(out)).toContain('E6')
  })

  it('the stale guard suppresses E4/E5/E6 for a long-past deadline', () => {
    // 30 days late. Only the overdue nag should survive.
    const out = ruleDeadlines(ctx('2026-08-17T03:00:00.000Z'), [
      task({ deadline: '2026-07-18T12:00:00.000+06:00' }),
    ])
    expect(rules(out)).toEqual(['E7'])
  })

  it('E7 re-nags with a per-day threshold', () => {
    const out = ruleDeadlines(ctx('2026-08-17T03:00:00.000Z'), [
      task({ deadline: '2026-07-18T12:00:00.000+06:00' }),
    ])
    expect(out[0].threshold).toBe('missed:2026-08-17')
  })

  it('E7 fires once ever when renag is off', () => {
    const out = ruleDeadlines(
      ctx('2026-08-17T03:00:00.000Z', { ALERT_DEADLINE_MISSED_RENAG: 'false' }),
      [task({ deadline: '2026-07-18T12:00:00.000+06:00' })],
    )
    expect(out[0].threshold).toBe('missed')
  })

  it('ignores completed and archived tasks', () => {
    const now = ctx('2026-08-18T06:05:00.000Z')
    const dl = '2026-08-18T12:00:00.000+06:00'
    expect(ruleDeadlines(now, [task({ deadline: dl, completed: 1 })])).toHaveLength(0)
    expect(ruleDeadlines(now, [task({ deadline: dl, archived: 1 })])).toHaveLength(0)
  })

  it('ignores tasks with no deadline (356 of 359 rows)', () => {
    expect(
      ruleDeadlines(ctx('2026-08-17T03:00:00.000Z'), [task({ deadline: null })]),
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// E9 — digest
// ---------------------------------------------------------------------------

describe('E9 routine digest', () => {
  const on = { ALERT_ROUTINE_DIGEST: 'true' }

  it('is off by default', () => {
    expect(
      ruleRoutineDigest(ctx('2026-08-17T01:45:00.000Z'), [routine()]),
    ).toHaveLength(0)
  })

  it('fires once at DIGEST_AT with the day sorted by start time', () => {
    // 07:45 local Monday === 01:45Z.
    const out = ruleRoutineDigest(ctx('2026-08-17T01:45:00.000Z', on), [
      routine({ notion_id: 'b', time: '14:00 - 16:30', activity: 'Work' }),
      routine({ notion_id: 'a', time: '09:00 - 13:00', activity: 'Work' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].threshold).toBe('2026-08-17')
    expect(out[0].html.indexOf('09:00')).toBeLessThan(out[0].html.indexOf('14:00'))
  })

  it('stays silent on a day with no blocks', () => {
    // Friday.
    expect(
      ruleRoutineDigest(ctx('2026-08-21T01:45:00.000Z', on), [routine()]),
    ).toHaveLength(0)
  })
})
