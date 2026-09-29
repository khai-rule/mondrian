import { describe, expect, it } from 'vitest'
import type { Obstacle } from './motion'
import { hopProfile, MOVE_SPEED, STEP } from './physics'
import { type HopSpec, hopFeasible, planHop } from './planner'

const around = (x: number, half = 0.4) => (): [number, number] => [x - half, x + half]

const base = (over: Partial<HopSpec> = {}): HopSpec => ({
  width: 20,
  launchT: 0,
  launchY: 10,
  gap: 3,
  start: 10,
  target: around(10),
  obstacles: [],
  ...over,
})

// A wall of an obstacle covering the whole hop's height and every x, but sliding: only leaves gaps.
const blocker = (over: Partial<Obstacle> = {}): Obstacle => ({ y: 11, w: 1.6, h: 0.8, from: -2, to: 22, speed: 3, offset: 0, ...over })

describe('planHop', () => {
  it('finds a path straight up and follows physics-sized steps', () => {
    const plan = planHop(base())
    expect(plan).not.toBeNull()
    expect(plan?.length).toBe(hopProfile(3).steps + 1)
    expect(plan?.[0]).toBe(10)
  })

  it('reaches a platform a sensible distance away but not one beyond the speed limit', () => {
    expect(planHop(base({ target: around(13) }))).not.toBeNull()
    const time = hopProfile(3).steps * STEP
    const tooFar = 10 + MOVE_SPEED * time + 1 // even at full speed with no reversal delay
    expect(planHop(base({ width: 40, target: around(tooFar) }))).toBeNull()
  })

  it('never plans movement faster than the assumed speed', () => {
    const plan = planHop(base({ target: around(13.2) }))
    expect(plan).not.toBeNull()
    if (!plan) return
    for (let i = 1; i < plan.length; i++) expect(Math.abs(plan[i] - plan[i - 1]) / STEP).toBeLessThanOrEqual(7.01)
  })

  it('accounts for momentum: someone landing at full speed the wrong way has drifted before they can turn', () => {
    const wrongWay = planHop(base({ v0: -MOVE_SPEED, target: around(13.2) }))
    expect(wrongWay).not.toBeNull()
    if (!wrongWay) return
    const drift = Math.min(...wrongWay.slice(0, Math.round(0.25 / STEP)))
    expect(drift).toBeLessThan(9.9) // carried left first, at least a few tenths, before it could turn
    // an obstacle parked exactly where that drift goes makes the same hop infeasible from that landing
    const parked: Obstacle = { y: 10.3, w: 1.2, h: 0.6, from: 8.05, to: 8.05, speed: 1, offset: 0 }
    expect(planHop(base({ v0: -MOVE_SPEED, target: around(13.2), obstacles: [parked] }))).toBeNull()
    expect(planHop(base({ v0: MOVE_SPEED, target: around(13.2), obstacles: [parked] }))).not.toBeNull()
  })

  it('finds the target when it is moving, evaluated at the landing time', () => {
    const landing = hopProfile(3).steps * STEP
    const slider = (t: number): [number, number] => [11 + Math.sin(t) * 2, 12 + Math.sin(t) * 2]
    expect(planHop(base({ target: slider }))).not.toBeNull()
    const gone = () => null
    expect(planHop(base({ target: gone }))).toBeNull()
    expect(landing).toBeGreaterThan(0.5)
  })

  it('steers around an obstacle that crosses the hop and reports impossible when none can be avoided', () => {
    const plan = planHop(base({ obstacles: [blocker()], target: around(10) }))
    expect(plan).not.toBeNull()
    // a full-width band at the launch height leaves no gap for the player
    const wall: Obstacle = { y: 9, w: 40, h: 8, from: -10, to: -10, speed: 1, offset: 0 }
    expect(planHop(base({ obstacles: [wall] }))).toBeNull()
  })

  it('settling means arriving at the landing spot early and holding still there', () => {
    const plan = planHop(base({ target: around(13.2, 0.3), settle: 0.12 }))
    expect(plan).not.toBeNull()
    if (!plan) return
    const held = plan.slice(-Math.round(0.1 / STEP))
    expect(Math.max(...held) - Math.min(...held)).toBeLessThan(0.05)
    expect(planHop(base({ target: around(20, 0.3), settle: 0.12 }))).toBeNull() // no time to get there and settle
  })

  it('checks every start position when asked to', () => {
    const spec = { ...base(), target: around(10.5, 0.3) }
    expect(hopFeasible(spec, [10, 10.5, 11])).toBe(true)
    expect(hopFeasible(spec, [10, 10.5, 30])).toBe(false)
  })
})
