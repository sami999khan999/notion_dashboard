import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The alert rules are pure and run in plain Node — no Workers pool needed,
// which keeps the suite fast. `cloudflare:sockets` is a runtime-only module,
// so it is aliased to a throwing stub: importing it is fine, calling it is not.
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': fileURLToPath(
        new URL('./test/stubs/cloudflare-sockets.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
