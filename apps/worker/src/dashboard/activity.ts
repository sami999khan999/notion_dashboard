/**
 * Activity kinds and the chart palette.
 *
 * The routine has 9 distinct activity names — more categorical slots than any
 * palette can keep distinguishable. Rather than cycle hues (never do that),
 * activities fold into FOUR kinds plus a neutral. The grouping is not cosmetic:
 * it encodes what the block is for, which is the question the ribbon answers.
 *
 * Why four and not more. On a near-black ground the usable lightness band is
 * narrow, which compresses hues together, and under deuteranopia blue and
 * purple at similar lightness measure ΔE ~0.5 — literally indistinguishable.
 * Five hues could not be made to separate; four can. Checked on ALL pairs, not
 * just adjacent ones, because any two segments of a timeline ribbon or donut
 * can end up touching:
 *
 *   node scripts/validate_palette.js \
 *     "#3B82F6,#E8690F,#16A34A,#C43BA0" --mode dark --pairs all    → PASS
 *                                          (worst pair ΔE 22.6 normal vision)
 *
 * The reference design's own hues were tried first and failed: its blue and
 * purple measured ΔE 0.9 under deuteranopia, and its orange/green/yellow sat
 * above the lightness band. These four keep that vivid character while
 * actually separating.
 *
 * Do not add a fifth hue without re-running the validator. Break stays neutral
 * on purpose: it is the absence of an activity and should recede.
 */

export type Kind = 'focus' | 'learning' | 'movement' | 'downtime' | 'break'

export interface KindSpec {
  id: Kind
  label: string
  /** What this kind covers, shown in the legend so the grouping is explicit. */
  covers: string
  color: string
  /** Low-alpha ground for chips and elapsed blocks. */
  tint: string
  onSolid: string
}

const W = '#ffffff'
export const INK_DARK = '#E9E9E9'

/** The validated four, in fixed order, reused by every categorical chart. */
export const SERIES = ['#3B82F6', '#E8690F', '#16A34A', '#C43BA0'] as const
/** Neutral for "Other" / uncategorised. Participates in no hue confusion. */
export const SERIES_NEUTRAL = '#6B6B6B'

export const KINDS: Record<Kind, KindSpec> = {
  focus: {
    id: 'focus',
    label: 'Focus',
    covers: 'Work',
    color: SERIES[0],
    tint: 'rgba(59,130,246,0.16)',
    onSolid: W,
  },
  movement: {
    id: 'movement',
    label: 'Movement',
    covers: 'Travel, exercise, getting ready',
    color: SERIES[1],
    tint: 'rgba(232,105,15,0.16)',
    onSolid: W,
  },
  learning: {
    id: 'learning',
    label: 'Learning',
    covers: 'Study, English practice',
    color: SERIES[2],
    tint: 'rgba(22,163,74,0.16)',
    onSolid: W,
  },
  downtime: {
    id: 'downtime',
    label: 'Downtime',
    covers: 'Sleep, gaming',
    color: SERIES[3],
    tint: 'rgba(196,59,160,0.16)',
    onSolid: W,
  },
  break: {
    id: 'break',
    label: 'Break',
    covers: 'Short gaps between blocks',
    color: SERIES_NEUTRAL,
    tint: 'rgba(255,255,255,0.07)',
    onSolid: W,
  },
}

/** Fixed order. Legends follow it, never rank order. */
export const KIND_ORDER: Kind[] = [
  'focus',
  'learning',
  'movement',
  'downtime',
  'break',
]

/**
 * Activity name → kind. Matched on a normalised name so the real data's typos
 * still land: "Travle" sits alongside "Travel", "Practive English" alongside
 * "English Speaking Practice".
 */
const RULES: Array<[RegExp, Kind]> = [
  [/\bwork\b/i, 'focus'],
  [/sleep|nap/i, 'downtime'],
  [/gam|play|movie|watch|youtube/i, 'downtime'],
  [/stud|english|practi|read|learn|book|course/i, 'learning'],
  [/trav|exercise|workout|fresh|gym|walk|run/i, 'movement'],
  [/break|lunch|dinner|meal|rest/i, 'break'],
]

export function kindOf(activity: string): Kind {
  const name = (activity ?? '').trim()
  for (const [re, kind] of RULES) if (re.test(name)) return kind
  // An unmatched block is more likely work than nothing, so it reads as focus
  // rather than falling into the recessive break tint.
  return 'focus'
}
