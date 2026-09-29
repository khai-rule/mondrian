import {
  CHUNK_H,
  type Cell,
  type Chunk,
  type GeneratorState,
  type Hue,
  restoreGenerator,
  snapshotGenerator,
} from './composition'
import type { Game, Player } from './engine'
import type { Obstacle } from './motion'
import type { LandingRecord } from './rules'

// An unfinished run lives on this device only (localStorage). It is never trusted for the
// leaderboard: the server verifies a submitted run's landing log itself.
//
// The save is small: scalars, the landing log (about one entry a second) and only the chunks near
// the player. Older chunks are stored as `0` and restored as empty, which keeps array indexes valid.
const KEY = 'mondrian.run'
const VERSION = 4
const HUE_CODES: Hue[] = ['white', 'red', 'yellow', 'blue']
const KEEP_BELOW = 72 // world units of chunks kept below the screen edge (artwork can show that far down)

export const saveRun = (game: Game) => {
  if (game.mode !== 'playing' && game.mode !== 'paused') return
  try {
    localStorage.setItem(KEY, encodeRun(game))
  } catch {
    // storage full or blocked: the run simply won't be resumable
  }
}

export const clearRun = () => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to clear
  }
}

export const loadRun = (): Game | null => {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  const game = decodeRun(raw)
  if (!game) clearRun() // corrupt or from an incompatible version
  return game
}

interface SavedRun {
  v: 4
  width: number
  camY: number
  time: number
  maxY: number
  points: number
  combo: number
  bestCombo: number
  lastTop: number
  startTop: number
  sid: string | null
  log: LandingRecord[]
  player: Player
  gen: GeneratorState
  chunks: (0 | SavedChunk)[]
}

interface SavedChunk {
  cells: [number, number, number, number, number, number][] // x, y, w, h, hue code, rail (0/1)
  movers: [number, number, number, number, number, number, number, number][] // x, y, w, h, hue code, amp, period, phase
  obstacles: [number, number, number, number, number, number, number][] // y, w, h, from, to, speed, offset
  route: number[] // indexes into cells followed by movers
}

export const encodeRun = (game: Game): string => {
  const saved: SavedRun = {
    v: VERSION,
    width: game.width,
    camY: game.camY,
    time: game.time,
    maxY: game.maxY,
    points: game.points,
    combo: game.combo,
    bestCombo: game.bestCombo,
    lastTop: game.lastTop,
    startTop: game.startTop,
    sid: game.sid,
    log: game.log,
    player: game.player,
    gen: snapshotGenerator(game.gen),
    chunks: game.chunks.map((chunk) => (chunk.y1 <= game.camY - KEEP_BELOW ? 0 : encodeChunk(chunk))),
  }
  return JSON.stringify(saved)
}

const encodeChunk = (chunk: Chunk): SavedChunk => {
  const everything = chunk.cells.concat(chunk.movers)
  return {
    cells: chunk.cells.map((c) => [c.x, c.y, c.w, c.h, HUE_CODES.indexOf(c.hue), c.rail ? 1 : 0]),
    movers: chunk.movers.flatMap((c): SavedChunk['movers'] =>
      c.motion ? [[c.x, c.y, c.w, c.h, HUE_CODES.indexOf(c.hue), c.motion.amp, c.motion.period, c.motion.phase]] : [],
    ),
    obstacles: chunk.obstacles.map((o): SavedChunk['obstacles'][number] => [o.y, o.w, o.h, o.from, o.to, o.speed, o.offset]),
    route: chunk.route.map((cell) => everything.indexOf(cell)),
  }
}

// Restores a run paused, exactly where it was; the caller decides when to let it continue.
export const decodeRun = (raw: string): Game | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isSavedRun(parsed) || parsed.gen.nextY !== parsed.chunks.length * CHUNK_H) return null
  return {
    mode: 'paused',
    width: parsed.width,
    gen: restoreGenerator(parsed.gen),
    chunks: parsed.chunks.map(decodeChunk),
    player: { ...parsed.player },
    camY: parsed.camY,
    time: parsed.time,
    maxY: parsed.maxY,
    dir: 0,
    points: parsed.points,
    combo: parsed.combo,
    bestCombo: parsed.bestCombo,
    lastTop: parsed.lastTop,
    startTop: parsed.startTop,
    log: parsed.log,
    sid: parsed.sid,
    landing: null,
  }
}

const decodeChunk = (saved: 0 | SavedChunk, index: number): Chunk => {
  const y0 = index * CHUNK_H
  if (saved === 0) return { y0, y1: y0 + CHUNK_H, cells: [], movers: [], obstacles: [], route: [] }
  const cells: Cell[] = saved.cells.map(([x, y, w, h, hue, rail]) => ({
    x,
    y,
    w,
    h,
    hue: HUE_CODES[hue] ?? 'white',
    hitAt: -1,
    ...(rail === 1 ? { rail: true } : {}),
  }))
  const movers: Cell[] = saved.movers.map(([x, y, w, h, hue, amp, period, phase]) => ({
    x,
    y,
    w,
    h,
    hue: HUE_CODES[hue] ?? 'white',
    hitAt: -1,
    motion: { amp, period, phase },
  }))
  const everything = cells.concat(movers)
  const obstacles: Obstacle[] = saved.obstacles.map(([y, w, h, from, to, speed, offset]) => ({ y, w, h, from, to, speed, offset }))
  const route = saved.route.map((i) => everything[i]).filter((cell): cell is Cell => cell !== undefined)
  return { y0, y1: y0 + CHUNK_H, cells, movers, obstacles, route }
}

// Shape checks for untrusted storage contents; a type predicate lets us narrow without casts.
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const hasNumbers = (value: unknown, keys: readonly string[]) => {
  const r = record(value)
  return r !== null && keys.every((key) => isNum(r[key]))
}

const isLanding = (value: unknown): value is LandingRecord =>
  Array.isArray(value) && value.length === 3 && value.every(isNum)

const numbers = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every(isNum)

const isSavedChunk = (value: unknown): value is 0 | SavedChunk => {
  if (value === 0) return true
  const r = record(value)
  return (
    r !== null &&
    Array.isArray(r.cells) &&
    r.cells.every((cell) => numbers(cell, 6)) &&
    Array.isArray(r.movers) &&
    r.movers.every((cell) => numbers(cell, 8)) &&
    Array.isArray(r.obstacles) &&
    r.obstacles.every((o) => numbers(o, 7)) &&
    Array.isArray(r.route) &&
    r.route.every(Number.isInteger)
  )
}

const isMotionOrAbsent = (value: unknown) => value === undefined || hasNumbers(value, ['amp', 'period', 'phase'])

const isSavedRun = (value: unknown): value is SavedRun => {
  const r = record(value)
  const gen = record(r?.gen)
  const player = record(r?.player)
  return (
    r !== null &&
    gen !== null &&
    player !== null &&
    r.v === VERSION &&
    hasNumbers(r, ['width', 'camY', 'time', 'maxY', 'points', 'combo', 'bestCombo', 'lastTop', 'startTop']) &&
    (r.sid === null || typeof r.sid === 'string') &&
    hasNumbers(player, ['x', 'y', 'vx', 'vy', 'landedAt']) &&
    (player.facing === 1 || player.facing === -1) &&
    hasNumbers(gen, ['width', 'nextY', 'rngState', 'slack', 'moverRun', 'moverSign']) &&
    hasNumbers(gen.last, ['x', 'w', 'top']) &&
    isMotionOrAbsent(record(gen.last)?.motion) &&
    (gen.before === null || hasNumbers(gen.before, ['x', 'w'])) &&
    (gen.routeT === null || isNum(gen.routeT)) &&
    (gen.side === 1 || gen.side === -1) &&
    HUE_CODES.some((hue) => hue === gen.lastHue) &&
    Array.isArray(r.log) &&
    r.log.every(isLanding) &&
    Array.isArray(r.chunks) &&
    r.chunks.every(isSavedChunk)
  )
}
