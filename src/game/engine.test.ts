import { describe, expect, it } from 'vitest'
import { top } from './composition'
import { createGame, type Direction, type Game, LANDING_POINTS, pause, registerLanding, resume, scoreOf, step } from './engine'
import { JUMP_V, MAX_SCROLL_SPEED, SPEED_RAMP_HEIGHT, scrollSpeedAt, STEP } from './physics'
import { createFollower } from './follower'
import { round2, verifyRun } from './rules'
import { decodeRun, encodeRun } from './save'

describe('engine', () => {
  it('starts the player on the route\'s first platform', () => {
    for (const width of [8, 21]) {
      const game = createGame(width, 'playing')
      expect(top(game.chunks[0].route[0])).toBe(game.player.y)
      expect(game.startTop).toBe(game.player.y)
    }
  })

  it('builds the combo on climbing landings and breaks it on a repeat or lower landing', () => {
    const game = createGame(8, 'playing')
    const start = game.lastTop
    registerLanding(game, start + 2)
    registerLanding(game, start + 4)
    registerLanding(game, start + 7)
    expect(game.combo).toBe(3)
    expect(game.points).toBe(LANDING_POINTS * (1 + 2 + 3))
    expect(game.landing?.gained).toBe(LANDING_POINTS * 3)

    registerLanding(game, start + 7) // bounced in place: a miss
    expect(game.combo).toBe(0)
    expect(game.points).toBe(LANDING_POINTS * 6)
    expect(game.landing?.gained).toBe(0)

    registerLanding(game, start + 8)
    expect(game.combo).toBe(1)
    registerLanding(game, start + 6) // dropped back down
    expect(game.combo).toBe(0)
    expect(game.bestCombo).toBe(3)
    expect(scoreOf(game)).toBeGreaterThanOrEqual(game.points)
  })

  // The route is the generator's promise: following it hop by hop, with the real physics and the
  // real scroll, must never lose to the camera, including long after the speed ceiling.
  for (const width of [8, 14, 26]) {
    it(`a player who follows the guaranteed route survives past max speed (width ${width})`, () => {
      const game = createGame(width, 'playing')
      const follow = createFollower()
      const reachedTop = SPEED_RAMP_HEIGHT * 2 // through every stage, well past the speed ceiling
      let closestCall = Number.POSITIVE_INFINITY // distance of a landing above the screen's bottom edge

      while (game.mode === 'playing' && game.maxY < reachedTop && game.time < 600) {
        // Flyers are best-effort fair, not guaranteed (see the composition tests), so this checks the route alone.
        for (const chunk of game.chunks) chunk.obstacles = []
        game.dir = follow(game)
        step(game, STEP)
        if (game.player.vy === JUMP_V) closestCall = Math.min(closestCall, game.player.y - game.camY)
      }
      expect(game.mode, `died at ${game.time.toFixed(1)}s, height ${game.maxY.toFixed(0)}, speed ${scrollSpeedAt(game.camY).toFixed(2)}`).toBe('playing')
      expect(game.maxY).toBeGreaterThanOrEqual(reachedTop)
      expect(scrollSpeedAt(game.camY)).toBe(MAX_SCROLL_SPEED)
      expect(closestCall, 'route leaves room to spare, not a photo finish').toBeGreaterThan(1)
    })
  }

  it('pauses completely and resumes exactly where it stopped', () => {
    const game = createGame(8, 'playing', 5)
    for (let i = 0; i < 90; i++) step(game, 1 / 60)
    const before = JSON.stringify({ ...game, gen: undefined })
    pause(game)
    game.dir = 1
    for (let i = 0; i < 600; i++) step(game, 1 / 60)
    expect(JSON.stringify({ ...game, gen: undefined, dir: 0, mode: 'playing' })).toBe(
      JSON.stringify({ ...JSON.parse(before), dir: 0, mode: 'playing' }),
    )
    resume(game)
    expect(game.mode).toBe('playing')
    step(game, 1 / 60)
    expect(game.time).toBeGreaterThan(1.5)
  })

  // The still stage has nothing on a timetable, so the run can be played at any frame rate.
  for (const dt of [STEP, 1 / 60, 1 / 30]) {
    it(`the server accepts a legitimately played run and recomputes its exact score (dt ${dt.toFixed(3)})`, () => {
      const game = createGame(10, 'playing', 11)
      const follow = createFollower()
      while (game.mode === 'playing' && game.maxY < 27) {
        game.dir = follow(game)
        step(game, dt)
      }
      // let the run end naturally so the claim covers a full life
      game.player.y = game.camY - 5
      step(game, dt)
      expect(game.mode).toBe('dead')
      const verdict = verifyRun(
        { width: game.width, start: game.startTop, landings: game.log, time: round2(game.time), maxY: round2(game.maxY) },
        game.time + 1,
      )
      expect(verdict.ok, JSON.stringify(verdict)).toBe(true)
      if (verdict.ok) {
        expect(verdict.score).toBe(scoreOf(game))
        expect(verdict.bestCombo).toBe(game.bestCombo)
      }
    })
  }

  it('the server accepts a run through every stage, sliders and obstacles included', () => {
    const game = createGame(10, 'playing', 12)
    const follow = createFollower()
    while (game.mode === 'playing' && game.maxY < 170) {
      game.dir = follow(game)
      step(game, STEP)
    }
    expect(game.mode).toBe('playing')
    game.player.y = game.camY - 5
    step(game, STEP)
    const verdict = verifyRun(
      { width: game.width, start: game.startTop, landings: game.log, time: round2(game.time), maxY: round2(game.maxY) },
      game.time + 1,
    )
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true)
  })

  it('a saved run resumes into exactly the same future as the uninterrupted run', () => {
    const original = createGame(9, 'playing', 2024)
    const followOriginal = createFollower()
    // save the instant after a landing, when a fresh session would pick up exactly where this one is
    for (let i = 0; i < 120 * 40 || original.player.vy !== JUMP_V; i++) {
      original.dir = followOriginal(original)
      step(original, STEP)
    }
    expect(original.mode).toBe('playing')
    const restored = decodeRun(encodeRun(original))
    expect(restored).not.toBeNull()
    if (!restored) return
    expect(restored.mode).toBe('paused')
    resume(restored)
    const followRestored = createFollower() // picks its first target from the restored state, like a fresh session

    for (let i = 0; i < 120 * 45; i++) {
      original.dir = followOriginal(original)
      step(original, STEP)
      restored.dir = followRestored(restored)
      step(restored, STEP)
    }
    expect(restored.player).toEqual(original.player)
    expect(restored.camY).toBe(original.camY)
    expect(scoreOf(restored)).toBe(scoreOf(original))
    expect(restored.combo).toBe(original.combo)
    expect(restored.log).toEqual(original.log)
    const ahead = (game: Game) => game.chunks.slice(-4).map((chunk) => chunk.cells.map((c) => [c.x, c.y, c.w, c.h, c.hue]))
    expect(ahead(restored)).toEqual(ahead(original)) // the world generated after the save is identical too
  })

  it('rejects damaged saves instead of restoring a broken run', () => {
    const game = createGame(8, 'playing', 3)
    const good = JSON.parse(encodeRun(game))
    expect(decodeRun(JSON.stringify({ ...good, v: 5 }))).toBeNull()
    expect(decodeRun(JSON.stringify({ ...good, camY: 'x' }))).toBeNull()
    expect(decodeRun(JSON.stringify({ ...good, chunks: good.chunks.slice(1) }))).toBeNull()
    expect(decodeRun('not json')).toBeNull()
    expect(decodeRun('{}')).toBeNull()
  })

  it('stops the player at the screen edges instead of wrapping', () => {
    const game = createGame(8, 'playing')
    const walk = (dir: Direction) => {
      game.dir = dir
      for (let i = 0; i < 240; i++) {
        game.player.y = game.camY + 8 // hover, so only the walls are under test
        game.player.vy = 0
        step(game, 1 / 60)
      }
    }
    walk(1)
    expect(game.player.x).toBeLessThanOrEqual(8)
    expect(game.player.x).toBeGreaterThan(7)
    walk(-1)
    expect(game.player.x).toBeGreaterThanOrEqual(0)
    expect(game.player.x).toBeLessThan(1)
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
