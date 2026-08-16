/**
 * Minimal Notion API client.
 *
 * Pinned to Notion-Version 2025-09-03 and the DATA SOURCE query endpoint.
 * The classic /v1/databases/{id}/query endpoint returns 400 for Daily Routine,
 * which has five data sources — see context/notion-schema.md §1. Using one
 * endpoint for every database keeps this simple and forward-compatible.
 */
import type { AppEnv } from '../config'

const NOTION_API = 'https://api.notion.com/v1'
export const NOTION_VERSION = '2025-09-03'

export interface NotionPage {
  id: string
  last_edited_time: string
  archived?: boolean
  properties: Record<string, any>
}

interface QueryResponse {
  results: NotionPage[]
  has_more: boolean
  next_cursor: string | null
}

function headers(env: AppEnv): HeadersInit {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
}

/**
 * Query one page of a data source.
 *
 * Retries once on 429 honouring Retry-After, and on 5xx. Beyond that we let the
 * error propagate — the cron runs again in a minute, so a failed tick is a
 * delay, not data loss (the sync cursor is only advanced on success).
 */
async function queryOnce(
  env: AppEnv,
  dataSourceId: string,
  body: Record<string, unknown>,
  attempt = 0,
): Promise<QueryResponse> {
  const res = await fetch(`${NOTION_API}/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(body),
  })

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 1) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? 1)
      await new Promise((r) =>
        setTimeout(r, Math.min(5000, Math.max(1000, retryAfter * 1000))),
      )
      return queryOnce(env, dataSourceId, body, attempt + 1)
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Notion ${res.status} on ${dataSourceId}: ${detail.slice(0, 300)}`)
  }
  return (await res.json()) as QueryResponse
}

/**
 * Query every page of a data source, following pagination.
 *
 * `maxPages` bounds a single cron tick so a pathological backfill can't blow
 * the Worker's subrequest budget. Hitting the cap is logged, never silent.
 */
export async function queryAll(
  env: AppEnv,
  dataSourceId: string,
  body: Record<string, unknown> = {},
  maxPages = 10,
): Promise<NotionPage[]> {
  const out: NotionPage[] = []
  let cursor: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const payload: Record<string, unknown> = { ...body, page_size: 100 }
    if (cursor) payload.start_cursor = cursor

    const data: QueryResponse = await queryOnce(env, dataSourceId, payload)
    out.push(...data.results)

    if (!data.has_more || !data.next_cursor) return out
    cursor = data.next_cursor
  }

  console.warn(
    JSON.stringify({
      event: 'notion.page_cap_reached',
      dataSourceId,
      maxPages,
      fetched: out.length,
    }),
  )
  return out
}

/** Pages edited at or after `since` (ISO). Used for the incremental cursor. */
export function editedSinceFilter(since: string): Record<string, unknown> {
  return {
    filter: {
      timestamp: 'last_edited_time',
      last_edited_time: { on_or_after: since },
    },
  }
}
