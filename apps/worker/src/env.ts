/**
 * Live Worker bindings.
 *
 * `cloudflare:workers` gives us the bindings anywhere in the Worker — the cron
 * handler, TanStack Start server functions, the auth routes — without
 * threading `env` through every call site.
 *
 * Keep this module thin: anything that imports it can only run inside the
 * Workers runtime. The shape and coercion helpers live in `config.ts` so the
 * alert engine stays testable in plain Node.
 */
import { env as cfEnv } from 'cloudflare:workers'
import type { AppEnv } from './config'

export type { AppEnv }
export { flag, num } from './config'

/** The live bindings for the current request / cron invocation. */
export function getEnv(): AppEnv {
  return cfEnv as unknown as AppEnv
}
