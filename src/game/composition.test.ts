import { describe, expect, it } from 'vitest'
import { CHUNK_H, type Cell, createGenerator, generateChunk, isPlatform, top, travel } from './composition'
import { difficultyAt } from './engine'
import { obstacleX } from './motion'
import { hopProfile, hopSeconds } from './physics'
import { hopFeasible, sampleRange } from './planner'
import { RULES, STAGE_STARTS, stageAt } from './stages'
import { horizontalReach, hopTime, MAX_GAP, MAX_SCROLL_SPEED, MIN_SCROLL_SPEED, scrollSpeedAt, SPEED_RAMP_HEIGHT } from './physics'

const chunksFor = (width: number, seed: number, count: number) => {
  const g = createGenerator(width, seed)
  return Array.from({ length: count }, () => generateChunk(g, difficultyAt(g.nextY)))
}

// The generator's own promise, restated with the planner on the final cells: a player can get from any
// place they might land on `from` to `to`, wherever a slider is along its sweep.
const canGetThere = (width: number, from: Cell, to: Cell, launchTop: number, gap: number) => {
  const slack = from.motion?.amp ?? 0 // a slider can be landed on anywhere along its sweep
  const starts = sampleRange([from.x - slack + 0.05, from.x + from.w + slack - 0.05], 0.5)
  const offsets = to.motion ? [-to.motion.amp, 0, to.motion.amp] : [0]
  return offsets.every((offset) =>
    hopFeasible(
      { width, launchT: 0, launchY: launchTop, gap, target: () => [to.x + offset + 0.15, to.x + offset + to.w - 0.15], obstacles: [] },
      starts,
    ),
  )
}

describe('generateChunk', () => {
  for (const width of [6, 8, 26]) {
    for (const seed of [1, 2, 3]) {
      it(`tiles the chunk and lays a physically reachable route (width ${width}, seed ${seed})`, () => {
        const count = 40
        const chunks = chunksFor(width, seed, count)
        const cells = chunks.flatMap((c) => c.cells)

        expect(cells.reduce((sum, c) => sum + c.w * c.h, 0)).toBe(width * CHUNK_H * count)
        expect(cells.every((c) => Number.isInteger(c.x) && Number.isInteger(c.y) && c.w >= 1 && c.h >= 1)).toBe(true)

        // every route step is a real hop; sliders and static platforms alike are reachable
        let last: Cell | null = null
        for (const chunk of chunks) {
          expect(chunk.route.length).toBeGreaterThan(0)
          for (const platform of chunk.route) {
            expect(isPlatform(platform)).toBe(true)
            if (last) {
              const gap = top(platform) - top(last)
              expect(gap).toBeGreaterThanOrEqual(1)
              expect(gap).toBeLessThanOrEqual(MAX_GAP)
              if (chunk.obstacles.length === 0) {
                if (!last.motion && !platform.motion) expect(travel(last, platform)).toBeLessThanOrEqual(horizontalReach(gap))
                else expect(canGetThere(width, last, platform, top(last), gap), `route step to ${platform.x},${top(platform)}`).toBe(true)
              }
            }
            last = platform
          }
          expect(chunk.y1 - top(last ?? chunk.route[0])).toBeLessThan(MAX_GAP) // leftover handed to the next chunk
        }

        // no coloured cell is a dead end: each has a higher one within reach, or is on the route
        for (const chunk of chunks) {
          const platforms = chunk.cells.filter(isPlatform)
          for (const cell of platforms) {
            if (chunk.route.includes(cell)) continue
            const continues = (next: Cell) => {
              const gap = top(next) - top(cell)
              return gap >= 1 && gap <= MAX_GAP && travel(cell, next) <= horizontalReach(gap)
            }
            expect(platforms.some(continues), `dead end at ${cell.x},${cell.y}`).toBe(true)
          }
        }

        // white dominates, colour (sliders included) is never absent
        for (const chunk of chunks) {
          const area = chunk.cells.reduce((sum, c) => sum + c.w * c.h, 0)
          const coloured = [...chunk.cells.filter(isPlatform), ...chunk.movers].reduce((sum, c) => sum + c.w * c.h, 0)
          expect(coloured / area).toBeGreaterThan(0.02)
          expect(coloured / area).toBeLessThanOrEqual(0.4)
        }
      })
    }
  }

  it('is deterministic: the same seed builds the same world, sliders and obstacles included', () => {
    expect(JSON.stringify(chunksFor(9, 77, 30))).toBe(JSON.stringify(chunksFor(9, 77, 30)))
    expect(JSON.stringify(chunksFor(9, 77, 30))).not.toBe(JSON.stringify(chunksFor(9, 78, 30)))
  })
})

describe('stages', () => {
  const worlds = [7, 10, 21].flatMap((width) => [1, 2, 3, 4, 5, 6].map((seed) => ({ width, chunks: chunksFor(width, seed * 31, 24) })))

  it('introduces sliders only from SHIFT on, obstacles only from OBSTACLE on, and starts with neither', () => {
    let sliders = 0
    let obstacles = 0
    for (const { chunks } of worlds) {
      for (const chunk of chunks) {
        for (const mover of chunk.movers) {
          sliders++
          expect(stageAt(top(mover))).not.toBe('still')
        }
        for (const o of chunk.obstacles) {
          obstacles++
          expect(['obstacle', 'composition']).toContain(stageAt(chunk.y0 + CHUNK_H / 2))
          expect(o.y).toBeGreaterThanOrEqual(chunk.y0 + 4.2)
          expect(o.y + o.h).toBeLessThanOrEqual(chunk.y1 - 4.4)
        }
      }
    }
    expect(sliders).toBeGreaterThan(50)
    expect(obstacles).toBeGreaterThan(10)
    for (const { chunks } of worlds) expect(chunks.filter((c) => c.y1 <= STAGE_STARTS[1].from).every((c) => c.movers.length === 0)).toBe(true)
  })

  it('keeps sliders mixed with static platforms and within each stage\'s limits', () => {
    for (const { chunks } of worlds) {
      let run = 0
      for (const platform of chunks.flatMap((c) => c.route)) {
        run = platform.motion ? run + 1 : 0
        expect(run).toBeLessThanOrEqual(RULES[stageAt(top(platform))].maxMoverRun || 0)
        if (platform.motion) {
          const { speed, amp } = RULES[stageAt(top(platform))]
          const peak = (platform.motion.amp * 2 * Math.PI) / platform.motion.period
          expect(peak).toBeLessThanOrEqual(speed[1] + 1e-9)
          expect(platform.motion.amp).toBeLessThanOrEqual(amp[1] + 1e-9)
          expect(platform.motion.amp).toBeGreaterThanOrEqual(0.8)
        }
      }
    }
  })

  it('swings every slider inside its own white rail, on the screen', () => {
    for (const { width, chunks } of worlds) {
      for (const chunk of chunks) {
        for (const mover of chunk.movers) {
          if (!mover.motion) continue
          const left = mover.x - mover.motion.amp
          const right = mover.x + mover.w + mover.motion.amp
          expect(left).toBeGreaterThanOrEqual(0)
          expect(right).toBeLessThanOrEqual(width)
          const rail = chunk.cells.find((c) => c.rail && c.x <= left && c.x + c.w >= right && c.y <= mover.y && top(c) >= top(mover))
          expect(rail, `rail for slider at ${mover.x},${mover.y}`).toBeDefined()
          expect(rail?.hue).toBe('white')
        }
      }
    }
  })

  it('keeps every obstacle in motion at a readable speed, at a height the route jumps through', () => {
    let checked = 0
    for (const { width, chunks } of worlds) {
      // when a player following the route exactly leaves each platform
      let last: Cell | null = null
      let time = 0
      const launches = new Map<Cell, number>()
      for (const platform of chunks.flatMap((c) => c.route)) {
        if (last) time += hopSeconds(top(platform) - top(last))
        if (last) launches.set(last, time - hopSeconds(top(platform) - top(last)))
        last = platform
      }
      for (const chunk of chunks) {
        for (const o of chunk.obstacles) {
          expect(o.y).toBeGreaterThanOrEqual(chunk.y0 + 4.2)
          expect(o.y + o.h).toBeLessThanOrEqual(chunk.y1 - 4.4)
          expect(o.speed).toBeGreaterThanOrEqual(RULES.obstacle.obstacleSpeed[0] - 1e-9)
          expect(o.speed).toBeLessThanOrEqual(RULES.composition.obstacleSpeed[1] + 1e-9)
          expect(Math.min(o.from, o.to)).toBeGreaterThanOrEqual(0) // it patrols a stretch on screen, always in view
          expect(Math.max(o.from, o.to) + o.w).toBeLessThanOrEqual(width)
          expect(Math.abs(o.to - o.from)).toBeGreaterThanOrEqual(2.5)
          // always moving: a moment later it is somewhere else
          expect(Math.abs(obstacleX(o, 1) - obstacleX(o, 1.4)) + Math.abs(obstacleX(o, 1.4) - obstacleX(o, 1.8))).toBeGreaterThan(0.05)

          // every hop that reaches its height has a way past at EVERY moment of the patrol, not just the expected one
          chunk.route.slice(0, -1).forEach((from, k) => {
            const to = chunk.route[k + 1]
            const gap = top(to) - top(from)
            const apex = Math.max(...hopProfile(gap).y)
            if (!(top(from) < o.y + o.h + 0.5 && top(from) + apex + 0.7 > o.y - 0.5)) return
            if (from.motion || to.motion) return
            const launchT = launches.get(from) ?? 0
            const middle = from.x + from.w / 2
            const cycle = (2 * Math.abs(o.to - o.from)) / o.speed
            for (let shift = 0; shift < cycle; shift += 0.04) {
              expect(
                hopFeasible(
                  { width, launchT: launchT + shift, launchY: top(from), gap, target: () => [to.x + 0.4, to.x + to.w - 0.4], obstacles: [o] },
                  [middle],
                  [0],
                ),
                `hop ${top(from)} -> ${top(to)} at shift ${shift}`,
              ).toBe(true)
            }
            checked++
          })
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('never lets the route settle into one column: consecutive platforms mostly clear each other', () => {
    let triples = 0
    let sameColumn = 0
    for (const { chunks } of worlds) {
      const route = chunks.flatMap((c) => c.route)
      for (let i = 2; i < route.length; i++) {
        triples++
        const [a, b, c] = [route[i - 2], route[i - 1], route[i]]
        if (Math.min(a.x + a.w, b.x + b.w, c.x + c.w) - Math.max(a.x, b.x, c.x) >= 0.5) sameColumn++
      }
    }
    expect(sameColumn / triples).toBeLessThan(0.2)
  })
})

describe('progressive speed', () => {
  it('ramps smoothly from the minimum to a hard ceiling, then stops accelerating', () => {
    expect(scrollSpeedAt(-5)).toBe(MIN_SCROLL_SPEED)
    expect(scrollSpeedAt(0)).toBe(MIN_SCROLL_SPEED)
    expect(scrollSpeedAt(SPEED_RAMP_HEIGHT)).toBeCloseTo(MAX_SCROLL_SPEED, 10)
    expect(scrollSpeedAt(SPEED_RAMP_HEIGHT * 10)).toBe(MAX_SCROLL_SPEED)

    let previous = scrollSpeedAt(0)
    let biggestStep = 0
    for (let y = 1; y <= SPEED_RAMP_HEIGHT; y++) {
      const speed = scrollSpeedAt(y)
      expect(speed).toBeGreaterThanOrEqual(previous)
      biggestStep = Math.max(biggestStep, speed - previous)
      previous = speed
    }
    expect(biggestStep).toBeLessThan(0.035) // no visible stages: at most a few hundredths per unit climbed
  })

  it('always leaves the maximum gap sustainable, even at the speed ceiling', () => {
    expect(MAX_SCROLL_SPEED * 1.15 * hopTime(MAX_GAP)).toBeLessThan(MAX_GAP)
  })
})
