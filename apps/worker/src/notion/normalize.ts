/**
 * Notion page -> flat row normalizers.
 *
 * Property names are exact-match and several contain typos that MUST be
 * preserved verbatim ('Day Cateogry', 'Summery'). See context/notion-schema.md.
 *
 * Every accessor is defensive: a property that is missing, null, or of an
 * unexpected shape yields a null/zero default rather than throwing. One
 * malformed row should never take down a whole sync tick.
 */
import type { NotionPage } from './client'

// ---------------------------------------------------------------------------
// Property accessors
// ---------------------------------------------------------------------------

function title(p: any): string {
  const arr = p?.title
  return Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? '').join('') : ''
}

function richText(p: any): string {
  const arr = p?.rich_text
  return Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? '').join('') : ''
}

function checkbox(p: any): number {
  return p?.checkbox === true ? 1 : 0
}

function statusName(p: any): string | null {
  return p?.status?.name ?? null
}

function selectName(p: any): string | null {
  return p?.select?.name ?? null
}

function multiSelect(p: any): string[] {
  const arr = p?.multi_select
  return Array.isArray(arr) ? arr.map((o: any) => o?.name).filter(Boolean) : []
}

/**
 * RAW date start, precision preserved.
 * "2026-02-22" (date-only) and "2026-03-31T00:00:00.000+06:00" are different
 * things to the deadline rules — never normalise one into the other here.
 */
function dateStart(p: any): string | null {
  return p?.date?.start ?? null
}

function dateEnd(p: any): string | null {
  return p?.date?.end ?? p?.date?.start ?? null
}

function formulaNumber(p: any): number {
  const f = p?.formula
  return f?.type === 'number' && typeof f.number === 'number' ? f.number : 0
}

function formulaString(p: any): string {
  const f = p?.formula
  return f?.type === 'string' ? (f.string ?? '') : ''
}

function rollupNumber(p: any): number {
  const r = p?.rollup
  if (r?.type === 'number' && typeof r.number === 'number') return r.number
  return 0
}

function firstRelationId(p: any): string | null {
  const arr = p?.relation
  return Array.isArray(arr) && arr.length > 0 ? (arr[0]?.id ?? null) : null
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface TaskRow {
  notion_id: string
  title: string
  status: string | null
  category: string | null
  deadline: string | null
  date: string | null
  completed: number
  archived: number
  progress: string
  seconds_today: number
  seconds_total: number
  updated: string
}

export interface TimerRow {
  notion_id: string
  name: string
  task_id: string | null
  status: string | null
  start_time: string | null
  end_time: string | null
  total_seconds: number
  category: string
  updated: string
  notified_bucket: number
}

export interface RoutineRow {
  notion_id: string
  activity: string
  time: string
  days: string[]
  archived: number
  done: number
  updated: string
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeTask(page: NotionPage): TaskRow {
  const p = page.properties ?? {}
  return {
    notion_id: page.id,
    title: title(p['Tasks']),
    // All 359 rows are "Stoped" in practice — stored for fidelity, never used
    // as task state. Real running state lives in Time Tracker.
    status: statusName(p['Status']),
    category: selectName(p['Category']),
    deadline: dateStart(p['Deadline']),
    date: dateStart(p['Date']),
    completed: checkbox(p['Completed']),
    archived: checkbox(p['Archive']),
    progress: formulaString(p['Task Progress']),
    seconds_today: rollupNumber(p['Total Time In Seconds Today']),
    seconds_total: rollupNumber(p['Total Time In Seconds']),
    updated: page.last_edited_time,
  }
}

export function normalizeTimer(page: NotionPage): TimerRow {
  const p = page.properties ?? {}
  return {
    notion_id: page.id,
    name: title(p['Name']),
    task_id: firstRelationId(p['Tasks Relation']),
    status: statusName(p['Status']),
    start_time: dateStart(p['Start Time']),
    end_time: dateEnd(p['End Time']),
    // NOTE: this formula is 0 while a timer runs (it guards on End Time).
    // Live elapsed is computed as now - start_time in the alert rules.
    total_seconds: formulaNumber(p['Total Time In Seconds']),
    category: multiSelect(p['Category']).join(', '),
    updated: page.last_edited_time,
    notified_bucket: 0, // preserved across upserts by the ON CONFLICT clause
  }
}

export function normalizeRoutine(page: NotionPage): RoutineRow {
  const p = page.properties ?? {}
  return {
    notion_id: page.id,
    activity: title(p['Activity']),
    // Bare wall-clock "HH:MM - HH:MM", no zone. Interpreted as Asia/Dhaka.
    time: richText(p['Time']),
    days: multiSelect(p['Days']),
    archived: checkbox(p['Archive']),
    done: checkbox(p['Done']),
    updated: page.last_edited_time,
  }
}
