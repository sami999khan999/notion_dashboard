/**
 * Stub for `cloudflare:sockets` in the Node test environment.
 *
 * The rule tests transitively import email.ts -> smtp.ts, which imports this
 * runtime-only module. Nothing under test actually opens a socket; the real
 * protocol behaviour was verified against smtp.gmail.com from a deployed
 * Worker, since it cannot be exercised outside workerd.
 */
export function connect(): never {
  throw new Error('cloudflare:sockets is not available in the Node test environment')
}
