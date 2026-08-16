/**
 * Worker entry.
 *
 * Replaces the default `@tanstack/react-start/server-entry` so we can add a
 * `scheduled()` handler for the cron alongside TanStack Start's `fetch()`.
 *
 * The auth gate lives here rather than in per-route loaders: one choke point,
 * with an explicit allow-list of public paths. Anything not on that list is
 * guarded by default, so a new route cannot accidentally ship unprotected.
 */
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import {
  PUBLIC_PATHS,
  handleLogin,
  handleLogout,
  handleTestEmail,
} from './auth/routes'
import { handleApi } from './api/mobile'
import { getSession } from './auth/session'
import { pruneExpiredSessions } from './auth/session'
import { getEnv } from './env'
import type { AppEnv } from './env'
import { runSync } from './sync/run'

const startFetch = createStartHandler(defaultStreamHandler)

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } })
}

export default {
  async fetch(request: Request, ...rest: any[]): Promise<Response> {
    const env = getEnv()
    const url = new URL(request.url)
    const path = url.pathname

    // --- JSON API for the mobile app ---------------------------------------
    // Bearer-token authenticated internally, so it sits ahead of the cookie
    // gate. Returns null for non-/api paths and falls through.
    const api = await handleApi(request, env)
    if (api) return api

    // --- public paths -------------------------------------------------------
    if (path === '/login') return handleLogin(request, env)
    if (path === '/logout') return handleLogout(request, env)

    // --- everything else requires a session --------------------------------
    if (!PUBLIC_PATHS.has(path)) {
      const session = await getSession(request, env)
      if (!session) {
        // Non-GET requests get a bare 401 rather than a redirect, so a form
        // post or fetch() fails loudly instead of silently rendering HTML.
        if (request.method !== 'GET') {
          return new Response('Unauthorized', { status: 401 })
        }
        return redirect('/login')
      }
    }

    // Authenticated tooling, placed after the gate above.
    if (path === '/test-email') return handleTestEmail(request, env)

    // Dev-only: run one sync+alert pass on demand. `vite dev` does not fire
    // cron triggers, so without this a local database never fills up.
    // Hard-gated on ENVIRONMENT so it cannot exist in production.
    if (path === '/dev/sync') {
      if (env.ENVIRONMENT !== 'development') {
        return new Response('Not found', { status: 404 })
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 })
      }
      try {
        await runSync(env)
        return Response.json({ ok: true })
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
      }
    }

    return startFetch(request as any, ...rest)
  },

  async scheduled(
    _event: ScheduledController,
    _env: unknown,
    ctx: ExecutionContext,
  ): Promise<void> {
    const env = getEnv() as AppEnv
    ctx.waitUntil(
      (async () => {
        try {
          await runSync(env)
        } catch {
          // runSync already logged the failure with context. Swallow here so a
          // bad tick doesn't surface as an unhandled rejection; cursors were
          // not advanced, so the next tick retries the same window.
        }
        try {
          await pruneExpiredSessions(env)
        } catch (e) {
          console.error(
            JSON.stringify({ event: 'prune.failed', error: (e as Error).message }),
          )
        }
      })(),
    )
  },
}
