/**
 * Settings persistence (D1).
 *
 * One row per overridden field. Absent key = "use the env default", which is
 * what makes "Reset to defaults" a simple DELETE rather than a re-write of
 * every value.
 */
import type { AppEnv } from '../config'
import type { AlertConfig } from './config'
import { FIELD_KEYS, configFromEnv, mergeOverrides, sanitizeForStorage } from './config'

export interface ConfigState {
  config: AlertConfig
  /** Which fields are currently overridden in D1 (rest come from env). */
  overridden: string[]
  updatedAt: string | null
}

async function readOverrides(env: AppEnv): Promise<{
  values: Record<string, string>
  updatedAt: string | null
}> {
  const res = await env.DB.prepare(
    `SELECT key, value, updated_at FROM settings`,
  ).all<{ key: string; value: string; updated_at: string }>()

  const values: Record<string, string> = {}
  let updatedAt: string | null = null
  for (const row of res.results ?? []) {
    values[row.key] = row.value
    if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at
  }
  return { values, updatedAt }
}

/** Effective config for this tick: env defaults with D1 overrides applied. */
export async function loadConfig(env: AppEnv): Promise<AlertConfig> {
  const base = configFromEnv(env)
  try {
    const { values } = await readOverrides(env)
    return mergeOverrides(base, values)
  } catch (e) {
    // A settings read must never take down the alert pipeline — fall back to
    // the deployed defaults and say so.
    console.error(
      JSON.stringify({ event: 'settings.read_failed', error: (e as Error).message }),
    )
    return base
  }
}

/** Config plus provenance, for the settings UI. */
export async function loadConfigState(env: AppEnv): Promise<ConfigState> {
  const base = configFromEnv(env)
  const { values, updatedAt } = await readOverrides(env)
  return {
    config: mergeOverrides(base, values),
    overridden: FIELD_KEYS.filter((k) => k in values),
    updatedAt,
  }
}

/**
 * Persist every field. Values equal to the env default are deleted rather than
 * stored, so `overridden` stays an honest record of what you actually changed.
 */
export async function saveConfig(
  env: AppEnv,
  input: Record<string, unknown>,
): Promise<ConfigState> {
  const base = configFromEnv(env)
  const clean = sanitizeForStorage(base, input)
  const now = new Date().toISOString()

  const statements = FIELD_KEYS.map((key) => {
    const value = clean[key]
    return value === String(base[key])
      ? env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(key)
      : env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                          updated_at = excluded.updated_at`,
        ).bind(key, value, now)
  })

  await env.DB.batch(statements)
  return loadConfigState(env)
}

/** Drop every override; the deployed env vars take over again. */
export async function resetConfig(env: AppEnv): Promise<ConfigState> {
  await env.DB.prepare(`DELETE FROM settings`).run()
  return loadConfigState(env)
}
