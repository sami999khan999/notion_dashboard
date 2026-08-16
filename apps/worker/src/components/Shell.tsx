import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'

/**
 * Icon rail + top bar. The rail is deliberately label-free: there are only two
 * destinations, and the reference's language is a narrow glyph column with the
 * active item inverted to a white tile.
 */

function Glyph({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8a1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V8a1.7 1.7 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  search: 'M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
}

function RailLink({ to, icon, label }: { to: string; icon: string; label: string }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <Link to={to} className="rail-btn" data-active={path === to} title={label} aria-label={label}>
      <Glyph d={icon} />
    </Link>
  )
}

function Rail() {
  return (
    <nav
      className="flex h-full w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-card py-4"
      aria-label="Main"
    >
      <div className="mb-4 grid h-9 w-9 place-items-center rounded-xl bg-white text-[15px] font-bold text-page">
        N
      </div>
      <RailLink to="/" icon={ICONS.home} label="Overview" />
      <RailLink to="/settings" icon={ICONS.gear} label="Alert settings" />
      <a
        className="rail-btn"
        href="https://www.notion.so/2c18222462178014a1cfdff168501bb1"
        target="_blank"
        rel="noopener noreferrer"
        title="Time Tracker in Notion"
        aria-label="Time Tracker in Notion"
      >
        <Glyph d={ICONS.clock} />
      </a>
      <a
        className="rail-btn"
        href="https://www.notion.so/2c082224621780738f64fe38401f8460"
        target="_blank"
        rel="noopener noreferrer"
        title="Tasks in Notion"
        aria-label="Tasks in Notion"
      >
        <Glyph d={ICONS.list} />
      </a>
      <a
        className="rail-btn"
        href="https://www.notion.so/2bc82224621781b5b3d1e435e7f9dabf"
        target="_blank"
        rel="noopener noreferrer"
        title="Daily Routine in Notion"
        aria-label="Daily Routine in Notion"
      >
        <Glyph d={ICONS.chart} />
      </a>

      <form method="POST" action="/logout" className="mt-auto">
        <button type="submit" className="rail-btn" title="Log out" aria-label="Log out">
          <Glyph d={ICONS.out} />
        </button>
      </form>
    </nav>
  )
}

export function TopBar({
  title,
  meta,
  right,
}: {
  title: string
  meta?: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-5 sm:gap-4">
      <div className="min-w-0">
        <h1 className="m-0 text-[21px] leading-tight font-semibold tracking-tight sm:text-[26px]">
          {title}
        </h1>
        {meta ? <p className="m-0 mt-1 text-[13px] text-ink-2">{meta}</p> : null}
      </div>
      <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto">{right}</div>
    </header>
  )
}

/** Identity chip, in the shape of the reference's account pill. */
export function AccountChip({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-line bg-card py-1.5 pr-4 pl-1.5">
      <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[13px] font-semibold text-white">
        S
      </span>
      <span className="leading-tight">
        <span className="block text-[13px] font-medium">Sami</span>
        <span className="block text-[11px] text-ink-3">{status}</span>
      </span>
    </div>
  )
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-page">
      <div className="hidden md:block">
        <Rail />
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            className="absolute inset-0 cursor-default border-0 bg-black/60 p-0"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 shadow-2xl" onClick={() => setOpen(false)}>
            <Rail />
          </div>
        </div>
      ) : null}

      <div className="n-scroll flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="m-4 mb-0 cursor-pointer rounded-xl border border-line bg-card px-3 py-2 text-[13px] md:hidden"
          aria-label="Open menu"
        >
          ☰
        </button>
        <div className="px-4 py-5 sm:px-6">{children}</div>
      </div>
    </div>
  )
}
