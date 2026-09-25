import { describe, expect, it } from 'vitest'
import { isPlatform, top } from './composition'
import { createGame, type Direction, type Game, JUMP_V, scoreOf, step } from './engine'

// A simple bot: on every bounce, pick the nearest platform top within jump reach of the
// launch point and steer toward it until the next landing. If the world is playable and the
// physics are sane, it survives well past the difficulty ramp.
const pickTarget = (game: Game): number | null => {
  const p = game.player
  let target: number | null = null
  let bestCost = Number.POSITIVE_INFINITY
  for (const chunk of game.chunks) {
    if (chunk.y1 < p.y || chunk.y0 > p.y + 4) continue
    for (const cell of chunk.cells) {
      if (!isPlatform(cell)) continue
      const t = top(cell)
      if (t < p.y + 1 || t > p.y + 3.8) continue
      const dx = wrapDx(game, cell.x + cell.w / 2)
      const cost = Math.abs(dx) - (t - p.y) * 0.4
      if (cost < bestCost) {
        bestCost = cost
        target = cell.x + cell.w / 2
      }
    }
  }
  return target
}

const steer = (game: Game, target: number | null): Direction => {
  if (target === null) return 0
  const dx = wrapDx(game, target)
  if (Math.abs(dx) < 0.1) return 0
  return dx > 0 ? 1 : -1
}

const wrapDx = (game: Game, x: number) => {
  let dx = x - game.player.x
  if (dx > game.width / 2) dx -= game.width
  if (dx < -game.width / 2) dx += game.width
  return dx
}

describe('engine', () => {
  it('starts the player on a platform and a bot survives 60 seconds', () => {
    for (const width of [8, 21]) {
      const game = createGame(width, 'playing')
      const start = game.chunks[0].cells.find((c) => isPlatform(c) && top(c) === game.player.y)
      expect(start).toBeDefined()

      const dt = 1 / 120
      let target: number | null = null
      while (game.mode === 'playing' && game.time < 60) {
        if (game.player.vy === JUMP_V) target = pickTarget(game)
        game.dir = steer(game, target)
        step(game, dt)
      }
      expect(game.mode, `died at ${game.time.toFixed(1)}s with score ${scoreOf(game)} (width ${width})`).toBe('playing')
      expect(game.maxY).toBeGreaterThan(60)
    }
  })

  it('ends the run when the player drops below the screen', () => {
    const game = createGame(8, 'playing')
    game.player.y = game.camY - 5
    game.player.vy = -1
    step(game, 1 / 60)
    expect(game.mode).toBe('dead')
    const frozenTime = game.time
    step(game, 1 / 60)
    expect(game.time).toBe(frozenTime)
  })
})
