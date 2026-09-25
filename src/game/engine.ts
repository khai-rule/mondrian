import { CHUNK_H, type Chunk, createGenerator, generateChunk, type Generator, isPlatform, top } from './composition'

export const VISIBLE_H = 16 // nominal world units visible vertically
export const PLAYER_W = 0.7
export const PLAYER_H = 0.7
export const JUMP_V = 15.5
const GRAVITY = 30 // apex = JUMP_V² / 2g ≈ 4.0 units, comfortably above MAX_GAP
const MOVE_SPEED = 7
const MOVE_ACCEL = 70
const DIFFICULTY_HEIGHT = 220 // units climbed until generation reaches full difficulty

export type Mode = 'idle' | 'playing' | 'dead'
export type Direction = -1 | 0 | 1

export interface Player {
  x: number
  y: number // feet
  vx: number
  vy: number
  facing: 1 | -1
  landedAt: number
}

export interface Game {
  mode: Mode
  width: number
  gen: Generator
  chunks: Chunk[]
  player: Player
  camY: number // world y at the bottom of the screen
  time: number
  maxY: number
  dir: Direction
}

export const createGame = (width: number, mode: Mode): Game => {
  const game: Game = {
    mode,
    width,
    gen: createGenerator(width),
    chunks: [],
    player: { x: width / 2, y: 2, vx: 0, vy: JUMP_V, facing: 1, landedAt: -1 },
    camY: mode === 'idle' ? 0 : -1,
    time: 0,
    maxY: 0,
    dir: 0,
  }
  ensureChunks(game)
  const spawn = spawnPlatform(game)
  game.player.x = spawn.x + spawn.w / 2
  game.player.y = top(spawn)
  return game
}

// Lowest platform closest to the centre, so the first bounce is always safe.
const spawnPlatform = (game: Game) => {
  const low = game.chunks[0].cells.filter((c) => isPlatform(c) && top(c) <= 3)
  let best = low[0]
  for (const c of low) {
    const better = top(c) < top(best) || (top(c) === top(best) && Math.abs(c.x + c.w / 2 - game.width / 2) < Math.abs(best.x + best.w / 2 - game.width / 2))
    if (better) best = c
  }
  return best
}

export const scrollSpeed = (time: number) => Math.min(0.5 + time * 0.025, 2.6) // 2.6 ≈ the ceiling of a perfect climb
export const difficultyAt = (y: number) => Math.min(y / DIFFICULTY_HEIGHT, 1)
export const scoreOf = (game: Game) => Math.floor(game.maxY * 10 + game.time * 15)

export const step = (game: Game, dt: number) => {
  if (game.mode === 'dead') return
  game.time += dt
  game.camY += (game.mode === 'idle' ? 0.6 : scrollSpeed(game.time)) * dt
  if (game.mode === 'playing') stepPlayer(game, dt)
  ensureChunks(game)
}

const stepPlayer = (game: Game, dt: number) => {
  const p = game.player
  const targetVx = game.dir * MOVE_SPEED
  p.vx += clamp(targetVx - p.vx, -MOVE_ACCEL * dt, MOVE_ACCEL * dt)
  p.x += p.vx * dt
  if (p.x < -PLAYER_W / 2) p.x += game.width
  if (p.x > game.width + PLAYER_W / 2) p.x -= game.width
  if (game.dir !== 0) p.facing = game.dir

  const prevY = p.y
  p.vy -= GRAVITY * dt
  p.y += p.vy * dt
  if (p.vy < 0) land(game, prevY)

  game.maxY = Math.max(game.maxY, p.y)
  const follow = p.y - VISIBLE_H * 0.45
  if (follow > game.camY) game.camY += (follow - game.camY) * Math.min(1, dt * 8)
  if (p.y + PLAYER_H < game.camY) game.mode = 'dead'
}

// One-way platforms: land only when the feet cross a coloured cell's top edge while falling.
const land = (game: Game, prevY: number) => {
  const p = game.player
  const index = Math.floor(p.y / CHUNK_H)
  for (let i = Math.max(0, index - 1); i <= Math.min(game.chunks.length - 1, index + 1); i++) {
    for (const cell of game.chunks[i].cells) {
      if (!isPlatform(cell)) continue
      const t = top(cell)
      if (prevY < t || p.y > t) continue
      if (p.x + PLAYER_W / 2 <= cell.x || p.x - PLAYER_W / 2 >= cell.x + cell.w) continue
      p.y = t
      p.vy = JUMP_V
      p.landedAt = game.time
      cell.hitAt = game.time
      return
    }
  }
}

export const ensureChunks = (game: Game) => {
  while (game.gen.nextY < game.camY + VISIBLE_H + 8) {
    game.chunks.push(generateChunk(game.gen, difficultyAt(game.gen.nextY)))
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
