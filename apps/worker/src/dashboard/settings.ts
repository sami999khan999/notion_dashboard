/**
 * Settings server functions.
 *
 * These run on the Worker (SSR and client navigation alike), behind the auth
 * gate in worker.ts, so they can touch D1 directly.
 */
import { createServerFn } from '@tanstack/react-start'
import { getEnv } from '../env'
import { loadConfigState, resetConfig, saveConfig } from '../settings/store'
import type { ConfigState } from '../settings/store'

export type { ConfigState }

export const getSettings = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ConfigState> => loadConfigState(getEnv()),
)

export const updateSettings = createServerFn({ method: 'POST' })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }): Promise<ConfigState> => saveConfig(getEnv(), data))

export const restoreDefaults = createServerFn({ method: 'POST' }).handler(
  async (): Promise<ConfigState> => resetConfig(getEnv()),
)
