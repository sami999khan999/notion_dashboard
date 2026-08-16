/**
 * Live integration check against the real Notion workspace.
 *
 * Skipped unless NOTION_TOKEN is present, so CI and the normal `pnpm test`
 * run stay offline and deterministic. Run it deliberately:
 *
 *   NOTION_TOKEN=ntn_... npx vitest run test/live-notion.test.ts
 *
 * Its job is to catch the things unit tests cannot: a renamed property, a
 * wrong data-source id, a changed API shape.
 */
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../src/config'
import { queryAll } from '../src/notion/client'
import {
  normalizeRoutine,
  normalizeTask,
  normalizeTimer,
} from '../src/notion/normalize'

const TOKEN = process.env.NOTION_TOKEN
const run = TOKEN ? describe : describe.skip

const env = {
  NOTION_TOKEN: TOKEN ?? '',
  DS_ROUTINE: '2bc82224-6217-81a2-9b52-000b6c7526b1',
  DS_TASKS: '2c082224-6217-8061-a75e-000b079c1160',
  DS_TIMER: '2c182224-6217-80f9-b47a-000b36ded62a',
} as AppEnv

run('live Notion', () => {
  it('pulls and normalizes Daily Routine', async () => {
    const pages = await queryAll(env, env.DS_ROUTINE, {}, 3)
    expect(pages.length).toBeGreaterThan(0)

    const rows = pages.map(normalizeRoutine)
    const active = rows.filter((r) => !r.archived)

    // Every active block must have a parseable "HH:MM - HH:MM" and at least
    // one weekday, or E8 silently skips it.
    for (const r of active) {
      expect(r.time, `activity=${r.activity}`).toMatch(/^\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*$/)
      expect(r.days.length, `activity=${r.activity}`).toBeGreaterThan(0)
    }
    console.log(
      `routine: ${rows.length} rows, ${active.length} active, ` +
        `activities=${[...new Set(active.map((r) => r.activity))].join(', ')}`,
    )
  }, 60_000)

  it('pulls and normalizes Tasks', async () => {
    const pages = await queryAll(env, env.DS_TASKS, {}, 5)
    expect(pages.length).toBeGreaterThan(0)

    const rows = pages.map(normalizeTask)
    // The title property is 'Tasks' (not 'Name') — a rename would empty this.
    expect(rows.some((r) => r.title.length > 0)).toBe(true)

    const withDeadline = rows.filter((r) => r.deadline)
    for (const r of withDeadline) {
      // Precision must be preserved, not normalized.
      expect(r.deadline!).toMatch(/^\d{4}-\d{2}-\d{2}(T.*)?$/)
    }
    console.log(
      `tasks: ${rows.length} rows, ${withDeadline.length} with deadline ` +
        `(${withDeadline.map((r) => r.deadline).join(', ')})`,
    )
  }, 60_000)

  it('pulls and normalizes Time Tracker', async () => {
    const pages = await queryAll(env, env.DS_TIMER, {}, 3)
    expect(pages.length).toBeGreaterThan(0)

    const rows = pages.map(normalizeTimer)
    expect(rows.some((r) => r.name.length > 0)).toBe(true)

    // Status must be one of the two known option names — group-based filters
    // are unreliable here because 'Running' is grouped under 'Complete'.
    for (const r of rows) {
      if (r.status) expect(['Running', 'Stoped']).toContain(r.status)
    }
    const running = rows.filter((r) => r.status === 'Running' && !r.end_time)
    console.log(`timers: ${rows.length} rows, ${running.length} currently running`)
  }, 60_000)
})
