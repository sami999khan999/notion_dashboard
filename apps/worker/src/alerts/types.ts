import type { AlertConfig } from '../settings/config'

export interface Alert {
  /** "E1".."E9" */
  rule: string
  /** Notion page id, or a synthetic id for aggregate alerts like the digest. */
  entityId: string
  /**
   * Dedupe discriminator. Anything recurring MUST embed a date here, otherwise
   * the rule fires once ever and then goes permanently silent.
   */
  threshold: string
  subject: string
  html: string
  notionUrl?: string
}

/**
 * Rules are pure: `(ctx, rows) => Alert[]`. They never touch the network, never
 * write to D1, and never read the clock — `now` is injected so every rule can
 * be tested against a frozen instant.
 *
 * `cfg` is the already-resolved, already-validated config (env defaults with
 * D1 overrides applied). Rules read typed booleans and numbers; no rule parses
 * an env string, so a bad stored value can never reach the alert logic.
 */
export interface RuleContext {
  cfg: AlertConfig
  now: Date
  /** Cached from cfg so rules don't re-read it per row. */
  offset: number
}

/** Snapshot rows as the rules see them (shapes mirror the D1 tables). */
export interface TimerSnapshot {
  notion_id: string
  name: string
  task_id: string | null
  status: string | null
  start_time: string | null
  end_time: string | null
  total_seconds: number
  notified_bucket: number
}

export interface TimerPrev {
  status: string | null
  end_time: string | null
}

export interface TaskSnapshot {
  notion_id: string
  title: string
  deadline: string | null
  completed: number
  archived: number
}

export interface RoutineSnapshot {
  notion_id: string
  activity: string
  time: string
  days: string[]
  archived: number
  done: number
}

/** Notion page URLs are the id with dashes stripped. */
export function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`
}
