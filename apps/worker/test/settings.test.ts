/**
 * Settings resolution: env defaults, D1 overrides, and validation.
 *
 * The validation cases matter most. Overrides are stored as free-text strings
 * in D1 and re-read on every cron tick, so a hand-edited row or a bad form post
 * must never be able to put a nonsense value into the alert engine.
 */
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/config'
import {
  configFromEnv,
  mergeOverrides,
  sanitizeForStorage,
} from '../src/settings/config'

function env(over: Partial<AppEnv> = {}): AppEnv {
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
    ...over,
  } as AppEnv
}

const base = () => configFromEnv(env())

describe('configFromEnv', () => {
  it('coerces the deployed vars into typed values', () => {
    const c = base()
    expect(c.timerStart).toBe(true)
    expect(c.routineDigest).toBe(false)
    expect(c.timerTickMinutes).toBe(30)
    expect(c.tzOffsetMinutes).toBe(360)
    expect(c.quietHours).toBe('')
  })

  it('treats anything other than the exact string "true" as false', () => {
    expect(configFromEnv(env({ ALERT_TIMER_START: 'TRUE' })).timerStart).toBe(false)
    expect(configFromEnv(env({ ALERT_TIMER_START: '1' })).timerStart).toBe(false)
    expect(configFromEnv(env({ ALERT_TIMER_START: '' })).timerStart).toBe(false)
  })

  it('falls back when a var is missing or unparseable', () => {
    expect(
      configFromEnv(env({ ALERT_TIMER_TICK_MINUTES: 'banana' })).timerTickMinutes,
    ).toBe(30)
    expect(configFromEnv(env({ DIGEST_AT: '25:99' })).digestAt).toBe('07:45')
  })
})

describe('mergeOverrides', () => {
  it('applies an override over the env default', () => {
    const c = mergeOverrides(base(), { routineStart: 'false', timerTickMinutes: '45' })
    expect(c.routineStart).toBe(false)
    expect(c.timerTickMinutes).toBe(45)
    expect(c.timerStart).toBe(true) // untouched
  })

  it('ignores keys that are not real settings', () => {
    const c = mergeOverrides(base(), { notAThing: 'x' } as any)
    expect(c).toEqual(base())
  })

  it('clamps an out-of-range interval instead of trusting it', () => {
    expect(mergeOverrides(base(), { timerTickMinutes: '0' }).timerTickMinutes).toBe(1)
    expect(mergeOverrides(base(), { timerTickMinutes: '99999' }).timerTickMinutes).toBe(
      1440,
    )
    expect(mergeOverrides(base(), { timerTickMinutes: '-5' }).timerTickMinutes).toBe(1)
  })

  it('falls back to the base when a number is garbage', () => {
    expect(
      mergeOverrides(base(), { timerTickMinutes: 'banana' }).timerTickMinutes,
    ).toBe(30)
  })

  it('rounds a fractional interval rather than producing a fraction', () => {
    expect(mergeOverrides(base(), { timerTickMinutes: '30.7' }).timerTickMinutes).toBe(
      31,
    )
  })

  it('accepts a valid quiet-hours window, including one that wraps midnight', () => {
    expect(mergeOverrides(base(), { quietHours: '00:00-07:45' }).quietHours).toBe(
      '00:00-07:45',
    )
    expect(mergeOverrides(base(), { quietHours: '22:00-06:00' }).quietHours).toBe(
      '22:00-06:00',
    )
  })

  it('rejects a malformed window instead of half-applying it', () => {
    // A window that parsed loosely could silently mute every alert.
    for (const bad of ['7:45-8:00', '0000-0745', '25:00-26:00', 'morning', '09:00-']) {
      expect(mergeOverrides(base(), { quietHours: bad }).quietHours).toBe('')
    }
  })

  it('treats an empty window as "disabled"', () => {
    const withWindow = mergeOverrides(base(), { quietHours: '00:00-07:45' })
    expect(mergeOverrides(withWindow, { quietHours: '' }).quietHours).toBe('')
  })

  it('keeps the timezone offset inside a real-world range', () => {
    expect(mergeOverrides(base(), { tzOffsetMinutes: '-9999' }).tzOffsetMinutes).toBe(
      -720,
    )
    expect(mergeOverrides(base(), { tzOffsetMinutes: '9999' }).tzOffsetMinutes).toBe(840)
  })
})

describe('sanitizeForStorage', () => {
  it('renders every field as a storable string', () => {
    const out = sanitizeForStorage(base(), { routineStart: false, digestAt: '08:30' })
    expect(out.routineStart).toBe('false')
    expect(out.digestAt).toBe('08:30')
    expect(out.timerTickMinutes).toBe('30')
  })

  it('stores the clamped value, not the submitted one', () => {
    expect(sanitizeForStorage(base(), { timerTickMinutes: 100000 }).timerTickMinutes).toBe(
      '1440',
    )
  })

  it('drops unknown fields from a hostile payload', () => {
    const out = sanitizeForStorage(base(), { __proto__: 'x', evil: 1 } as any)
    expect(out).not.toHaveProperty('evil')
    expect(Object.keys(out).sort()).toEqual(Object.keys(base()).sort())
  })
})
