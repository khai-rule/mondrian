import { CHUNK_H, type Chunk, cellX, createGenerator, generateChunk, type Generator, isPlatform, top } from './composition'
import { obstacleX } from './motion'
import { CAMERA_FOLLOW, GRAVITY, JUMP_V, MIN_SCROLL_SPEED, MOVE_ACCEL, MOVE_SPEED, PLAYER_H, PLAYER_W, scrollSpeedAt, VISIBLE_H } from './physics'
import { applyLanding, computeScore, type LandingRecord, LANDING_POINTS, round2, START_CAM_Y } from './rules'

export { LANDING_POINTS }

export { VISIBLE_H }
export { PLAYER_H, PLAYER_W }
// Route difficulty keeps rising after the speed ceiling (reached at SPEED_RAMP_HEIGHT): past it, the
// challenge is route design and risk, not more speed.
const DIFFICULTY_HEIGHT = 260

export type Mode = 'idle' | 'playing' | 'paused' | 'dead'
export type Direction = -1 | 0 | 1

export interface Player {
  x: number
  y: number // feet
  vx: number
  vy: number
  facing: 1 | -1
  landedAt: number
}

export interface Landing {
  x: number
  y: number
  at: number
  gained: number
  combo: number
}

export interface Game {
  mode: Mode
  width: number
  gen: Generator
  chunks: Chunk[]
  player: Player
  camY: number // world y at the bottom of the screen
  time: number // game seconds: only advances while playing
  maxY: number
  dir: Direction
  points: number // earned from landings
  combo: number // consecutive climbing landings; the score multiplier
  bestCombo: number
  lastTop: number // top of the platform last landed on
  startTop: number // top of the platform the run began on
  log: LandingRecord[] // every landing, so the server can verify the score
  sid: string | null // server session that timestamps the run
  landing: Landing | null // most recent landing, for feedback
}

export const createGame = (width: number, mode: Mode, seed?: number): Game => {
  const game: Game = {
    mode,
    width,
    gen: createGenerator(width, seed),
    chunks: [],
    player: { x: width / 2, y: 2, vx: 0, vy: JUMP_V, facing: 1, landedAt: -1 },
    camY: mode === 'idle' ? 0 : START_CAM_Y,
    time: 0,
    maxY: 0,
    dir: 0,
    points: 0,
    combo: 0,
    bestCombo: 0,
    lastTop: 0,
    startTop: 0,
    log: [],
    sid: null,
    landing: null,
  }
  ensureChunks(game)
  const spawn = game.chunks[0].route[0] // the route's first platform: the guarantee starts under the player's feet
  game.player.x = spawn.x + spawn.w / 2
  game.player.y = top(spawn)
  game.lastTop = game.player.y
  game.startTop = game.player.y
  game.maxY = game.player.y
  return game
}

export const difficultyAt = (y: number) => Math.min(y / DIFFICULTY_HEIGHT, 1)
export const scoreOf = (game: Game) => computeScore(game.points, game.maxY, game.time)

// Pausing freezes everything: scrolling, physics, time and score all stop advancing.
export const pause = (game: Game) => {
  if (game.mode === 'playing') game.mode = 'paused'
}

export const resume = (game: Game) => {
  if (game.mode === 'paused') game.mode = 'playing'
}

export const step = (game: Game, dt: number) => {
  if (game.mode === 'dead' || game.mode === 'paused') return
  game.time += dt
  game.camY += (game.mode === 'idle' ? MIN_SCROLL_SPEED : scrollSpeedAt(game.camY)) * dt
  if (game.mode === 'playing') stepPlayer(game, dt)
  ensureChunks(game, 1)
}

const stepPlayer = (game: Game, dt: number) => {
  const p = game.player
  const targetVx = game.dir * MOVE_SPEED
  p.vx += clamp(targetVx - p.vx, -MOVE_ACCEL * dt, MOVE_ACCEL * dt)
  p.x += p.vx * dt
  const half = PLAYER_W / 2
  if (p.x < half || p.x > game.width - half) {
    p.x = clamp(p.x, half, game.width - half) // the screen edges are walls
    p.vx = 0
  }
  if (game.dir !== 0) p.facing = game.dir

  const prevY = p.y
  p.vy -= GRAVITY * dt
  p.y += p.vy * dt
  if (p.y + PLAYER_H < game.camY) {
    game.mode = 'dead' // fell below the screen edge before landing anywhere
    return
  }
  if (hitsObstacle(game)) {
    game.mode = 'dead' // flew into one of the black forms
    return
  }
  if (p.vy < 0) land(game, prevY)

  game.maxY = Math.max(game.maxY, p.y)
  const follow = p.y - VISIBLE_H * CAMERA_FOLLOW
  if (follow > game.camY) game.camY += (follow - game.camY) * Math.min(1, dt * 8)
}

// One-way platforms: land only when the feet cross a coloured cell's top edge while falling.
// Sliding platforms are checked where they are at this moment.
const land = (game: Game, prevY: number) => {
  const p = game.player
  const index = Math.floor(p.y / CHUNK_H)
  for (let i = Math.max(0, index - 1); i <= Math.min(game.chunks.length - 1, index + 1); i++) {
    const { cells, movers } = game.chunks[i]
    for (const cell of cells.concat(movers)) {
      if (!isPlatform(cell)) continue
      const t = top(cell)
      if (prevY < t || p.y > t) continue
      const x = cellX(cell, game.time)
      if (p.x + PLAYER_W / 2 <= x || p.x - PLAYER_W / 2 >= x + cell.w) continue
      p.y = t
      p.vy = JUMP_V
      p.landedAt = game.time
      cell.hitAt = game.time
      registerLanding(game, t)
      return
    }
  }
}

// A little forgiveness (the generator keeps 0.2 of clear room around every obstacle it plans for).
const HIT_FORGIVENESS = 0.12

const hitsObstacle = (game: Game) => {
  const p = game.player
  const index = Math.floor(p.y / CHUNK_H)
  for (let i = Math.max(0, index - 1); i <= Math.min(game.chunks.length - 1, index + 1); i++) {
    for (const o of game.chunks[i].obstacles) {
      const x = obstacleX(o, game.time)
      const overlapsX = p.x + PLAYER_W / 2 - HIT_FORGIVENESS > x && p.x - PLAYER_W / 2 + HIT_FORGIVENESS < x + o.w
      const overlapsY = p.y + PLAYER_H - HIT_FORGIVENESS > o.y && p.y + HIT_FORGIVENESS < o.y + o.h
      if (overlapsX && overlapsY) return true
    }
  }
  return false
}

export const registerLanding = (game: Game, platformTop: number) => {
  const gained = applyLanding(game, platformTop)
  game.log.push([round2(game.time), platformTop, Math.round(game.player.x * 10) / 10])
  game.landing = { x: game.player.x, y: platformTop, at: game.time, gained, combo: game.combo }
}

// Chunks are built a little ahead of the screen, at most one per step, so the (heavier) generation
// is spread out instead of landing on a single frame.
const LOOKAHEAD = 20

export const ensureChunks = (game: Game, limit = Number.POSITIVE_INFINITY) => {
  for (let built = 0; built < limit && game.gen.nextY < game.camY + VISIBLE_H + LOOKAHEAD; built++) {
    game.chunks.push(generateChunk(game.gen, difficultyAt(game.gen.nextY)))
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
