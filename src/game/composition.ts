// Procedural Mondrian-inspired composition. World units are integers on a grid;
// y grows upward. Coloured cells are the platforms, white cells are negative space.

export type Hue = 'white' | 'red' | 'yellow' | 'blue'

export interface Cell {
  x: number
  y: number // bottom edge
  w: number
  h: number
  hue: Hue
  hitAt: number // game time of the last landing, -1 = never
}

export interface Chunk {
  y0: number
  y1: number
  cells: Cell[]
}

export interface Generator {
  width: number
  nextY: number
  rng: () => number
  last: { cx: number; top: number } // last platform on the guaranteed route
  lastHue: Hue
}

export const CHUNK_H = 12
export const MAX_GAP = 3 // NOTE: leaf height cap; must stay below the player's jump apex
const MAX_LEAF_W = 5

export const isPlatform = (cell: Cell) => cell.hue !== 'white'
export const top = (cell: Cell) => cell.y + cell.h

export const createGenerator = (width: number, seed = Math.floor(Math.random() * 2 ** 32)): Generator => ({
  width,
  nextY: 0,
  rng: mulberry32(seed),
  last: { cx: width / 2, top: 0 },
  lastHue: 'white',
})

export const generateChunk = (g: Generator, difficulty: number): Chunk => {
  const d = clamp(difficulty, 0, 1)
  const y0 = g.nextY
  const y1 = y0 + CHUNK_H
  const cells: Cell[] = []
  subdivide(g.rng, d, { x: 0, y: y0, w: g.width, h: CHUNK_H }, cells)
  layRoute(g, cells, d)
  // Bonus platforms: generous early, rare later. Big cells stay white so the composition breathes.
  for (const cell of cells) {
    if (!isPlatform(cell) && cell.w <= 3 && cell.h <= 2 && g.rng() < 0.3 * (1 - d)) cell.hue = pickHue(g)
  }
  g.nextY = y1
  return { y0, y1, cells }
}

// Guarantees a chain of platforms whose tops are 1..MAX_GAP apart, all the way to the chunk top.
// Proof sketch: cells tile the chunk and are at most MAX_GAP tall, so the cell directly above
// the last platform always qualifies. Wrap-around movement keeps any horizontal offset reachable.
const layRoute = (g: Generator, cells: Cell[], d: number) => {
  const minGap = d > 0.55 ? 2 : 1
  const reach = 5 - 2.5 * d
  for (;;) {
    const inRange = cells.filter((c) => !isPlatform(c) && top(c) >= g.last.top + 1 && top(c) <= g.last.top + MAX_GAP)
    if (inRange.length === 0) return
    const preferred = inRange.filter((c) => top(c) >= g.last.top + minGap && wrapDx(g.width, c, g.last.cx) <= reach)
    const pool = preferred.length > 0 ? preferred : [nearest(g, inRange)]
    const pick = weightedPick(g.rng, pool, (c) => 1 + d * (top(c) - g.last.top + (4 - Math.min(c.w, 4))))
    pick.hue = pickHue(g)
    g.last = { cx: pick.x + pick.w / 2, top: top(pick) }
  }
}

const nearest = (g: Generator, cells: Cell[]) => {
  let best = cells[0]
  for (const c of cells) if (wrapDx(g.width, c, g.last.cx) < wrapDx(g.width, best, g.last.cx)) best = c
  return best
}

const wrapDx = (width: number, cell: Cell, cx: number) => {
  const raw = Math.abs(cell.x + cell.w / 2 - cx)
  return Math.max(0, Math.min(raw, width - raw) - cell.w / 2)
}

const HUE_WEIGHTS: [Hue, number][] = [
  ['red', 0.4],
  ['yellow', 0.35],
  ['blue', 0.25],
]

const pickHue = (g: Generator): Hue => {
  const options = HUE_WEIGHTS.filter(([hue]) => hue !== g.lastHue)
  const hue = weightedPick(g.rng, options, ([, w]) => w)[0]
  g.lastHue = hue
  return hue
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// Guillotine subdivision with off-centre cuts: asymmetric, varied proportions, grid-aligned.
const subdivide = (rng: () => number, d: number, r: Rect, out: Cell[]) => {
  const tooWide = r.w > MAX_LEAF_W
  const tooTall = r.h > MAX_GAP
  const canV = r.w >= 2
  const canH = r.h >= 2
  const mustSplit = tooWide || tooTall
  if (!mustSplit && (!(canV || canH) || rng() < 0.42 - 0.2 * d)) {
    out.push({ ...r, hue: 'white', hitAt: -1 })
    return
  }
  let vertical: boolean
  if (tooWide && !tooTall) vertical = true
  else if (tooTall && !tooWide) vertical = false
  else if (!canH) vertical = true
  else if (!canV) vertical = false
  else vertical = r.w / r.h > 1 + rng() * 0.8
  if (vertical) {
    const cut = pickCut(rng, r.w)
    subdivide(rng, d, { x: r.x, y: r.y, w: cut, h: r.h }, out)
    subdivide(rng, d, { x: r.x + cut, y: r.y, w: r.w - cut, h: r.h }, out)
  } else {
    const cut = pickCut(rng, r.h)
    subdivide(rng, d, { x: r.x, y: r.y, w: r.w, h: cut }, out)
    subdivide(rng, d, { x: r.x, y: r.y + cut, w: r.w, h: r.h - cut }, out)
  }
}

const pickCut = (rng: () => number, n: number) => {
  const t = rng() < 0.5 ? 0.38 : 0.62
  return clamp(Math.round(n * (t + (rng() - 0.5) * 0.35)), 1, n - 1)
}

const weightedPick = <T>(rng: () => number, items: T[], weight: (item: T) => number): T => {
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  let r = rng() * total
  for (const item of items) {
    r -= weight(item)
    if (r <= 0) return item
  }
  return items[items.length - 1]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
