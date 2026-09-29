import { type Obstacle, obstacleX } from './motion'
import { hopProfile, MOVE_ACCEL, MOVE_SPEED, PLAYER_H, PLAYER_W, STEP } from './physics'

// Answers one question: can a player who leaves a platform at a known moment steer to the target
// platform, given where it will be at landing time and where every obstacle will be along the way?
// The generator uses it to guarantee routes; tests use its path to drive a bot through the world.
//
// It searches over sets of possible x positions (unions of intervals), one checkpoint at a time.
// Two limits shape those sets. The player is assumed slower than they really are (PLAN_SPEED <
// MOVE_SPEED), so a plan is comfortably executable. And the player keeps the momentum they landed
// with: at full speed the wrong way they drift about 0.35 units before they can turn (see
// kinematics), so a hop is only judged feasible if it works for every landing velocity that matters.
const PLAN_SPEED = 6
const MOMENTUM_WINDOW = 0.25 // seconds in which the landing velocity, not the player's choices, dominates
// Feasibility isn't smooth (dodging left needs little momentum, dodging right needs a lot), so a
// handful of speeds isn't enough: sample across the whole range.
const LANDING_VELOCITIES = [-MOVE_SPEED, -MOVE_SPEED / 2, 0, MOVE_SPEED / 2, MOVE_SPEED]
const CLEARANCE = 0.3 // extra room kept around obstacles, so states between the sampled ones are safe too
const STRIDE = 2 // steps between checkpoints (1/60 s)

type Interval = [number, number]

export interface HopSpec {
  width: number
  launchT: number // game time the player leaves the platform
  launchY: number // height of the platform they leave
  gap: number // how much higher the target is
  start: number // player centre x at launch
  v0?: number // horizontal velocity at launch (default 0)
  target: (t: number) => Interval | null // player-centre x range that lands on the target at time t
  obstacles: readonly Obstacle[]
  // Arrive settled: be at the landing spot this long before landing, and hold still there, so the landing
  // is at rest. Only for targets that don't move. Used where the next hop needs a sensible landing.
  settle?: number
  clearance?: number // room kept around obstacles (default CLEARANCE); the generator's proofs use less
}

export const SETTLE_TIME = 0.12 // long enough to brake from full speed (7 / 70 = 0.1 s)

// The middle of a platform, for landings that must be centred.
export const middleOf = (x: number, w: number): [number, number] => {
  const half = Math.max(w / 6, 0.3)
  return [x + w / 2 - half, x + w / 2 + half]
}

// Player centre x after every step of the hop (index 0..steps), or null if there is no way.
export const planHop = (spec: HopSpec): number[] | null => {
  const { steps, y } = hopProfile(spec.gap)
  const half = PLAYER_W / 2
  const lo = half
  const hi = spec.width - half
  const checkpoints = [0]
  for (let s = STRIDE; s < steps; s += STRIDE) checkpoints.push(s)
  checkpoints.push(steps)

  const start = Math.min(hi, Math.max(lo, spec.start))
  // Momentum into a nearby wall is lost at the wall (the game zeroes it), so it can't carry them on.
  const v0 = (spec.v0 ?? 0) > 0 && hi - start < stoppingDistance(spec.v0 ?? 0) ? 0 : (spec.v0 ?? 0) < 0 && start - lo < stoppingDistance(spec.v0 ?? 0) ? 0 : (spec.v0 ?? 0)
  const history: Interval[][] = [[[start, start]]]

  // Everywhere they can be at each later checkpoint, given where they can be at `from`.
  const advance = (fromK: number) => {
    for (let k = fromK + 1; k < checkpoints.length; k++) {
      const [drift0, drift1] = kinematics(v0, checkpoints[k] * STEP)
      const speed = checkpoints[k] * STEP <= MOMENTUM_WINDOW ? MOVE_SPEED : PLAN_SPEED
      const grown = intersect(dilate(history[k - 1], (checkpoints[k] - checkpoints[k - 1]) * STEP * speed, lo, hi), [start + drift0, start + drift1])
      history[k] = subtract(grown, forbidden(spec, checkpoints[k], y[checkpoints[k]]))
      if (history[k].length === 0) return false
    }
    return true
  }
  if (!advance(0)) return null

  const end = spec.target(spec.launchT + steps * STEP)
  if (!end) return null
  if (spec.settle !== undefined) {
    let ks = checkpoints.length - 1
    while (ks > 0 && checkpoints[ks] * STEP > steps * STEP - spec.settle) ks--
    const near = intersect(history[ks], end)
    if (near.length === 0) return null
    history[ks] = near
    for (let k = ks + 1; k < checkpoints.length; k++) {
      history[k] = subtract(near, forbidden(spec, checkpoints[k], y[checkpoints[k]])) // hold still
      if (history[k].length === 0) return null
    }
  }
  const landing = intersect(history[history.length - 1], end)
  if (landing.length === 0) return null

  const best = landing.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a))
  const atCheckpoint = new Array<number>(checkpoints.length)
  atCheckpoint[checkpoints.length - 1] = (best[0] + best[1]) / 2
  for (let k = checkpoints.length - 2; k >= 0; k--) atCheckpoint[k] = nearest(history[k], atCheckpoint[k + 1])

  const path: number[] = []
  for (let k = 0; k < checkpoints.length - 1; k++) {
    const span = checkpoints[k + 1] - checkpoints[k]
    for (let i = 0; i < span; i++) path.push(atCheckpoint[k] + ((atCheckpoint[k + 1] - atCheckpoint[k]) * i) / span)
  }
  path.push(atCheckpoint[checkpoints.length - 1])
  return path
}

// Whether the hop works from every one of these starting positions (where the player might land),
// however fast they were moving sideways when they did.
export const hopFeasible = (
  spec: Omit<HopSpec, 'start' | 'v0'>,
  starts: readonly number[],
  velocities: readonly number[] = LANDING_VELOCITIES,
) => starts.every((start) => velocities.every((v0) => planHop({ ...spec, start, v0 }) !== null))

const stoppingDistance = (v: number) => (v * v) / (2 * MOVE_ACCEL)

// Where a player who is moving at v0 can be after t seconds, as offsets: from full acceleration one
// way to full acceleration the other, with the speed limit. Momentum makes the inside of that range
// (turning back the way they came) cost time: at t = 0.2 s moving 7 the wrong way, the near end is 0.
const kinematics = (v0: number, t: number): [number, number] => {
  const toTop = (MOVE_SPEED - v0) / MOVE_ACCEL
  const right = t <= toTop ? v0 * t + 0.5 * MOVE_ACCEL * t * t : v0 * toTop + 0.5 * MOVE_ACCEL * toTop * toTop + MOVE_SPEED * (t - toTop)
  const toBottom = (MOVE_SPEED + v0) / MOVE_ACCEL
  const left = t <= toBottom ? v0 * t - 0.5 * MOVE_ACCEL * t * t : v0 * toBottom - 0.5 * MOVE_ACCEL * toBottom * toBottom - MOVE_SPEED * (t - toBottom)
  return [left, right]
}

// Evenly spaced positions across a range, always including both ends.
export const sampleRange = ([a, b]: Interval, spacing: number) => {
  if (a >= b) return [a]
  const count = Math.max(2, Math.ceil((b - a) / spacing) + 1)
  return Array.from({ length: count }, (_, i) => a + ((b - a) * i) / (count - 1))
}

const forbidden = (spec: HopSpec, step: number, height: number): Interval[] => {
  const half = PLAYER_W / 2
  const t = spec.launchT + step * STEP
  const feet = spec.launchY + height
  const out: Interval[] = []
  for (const o of spec.obstacles) {
    const room = spec.clearance ?? CLEARANCE
    if (feet >= o.y + o.h + room || feet + PLAYER_H <= o.y - room) continue
    const x = obstacleX(o, t)
    out.push([x - half - room, x + o.w + half + room])
  }
  return out
}

const dilate = (set: Interval[], by: number, lo: number, hi: number): Interval[] =>
  merge(set.map(([a, b]): Interval => [Math.max(lo, a - by), Math.min(hi, b + by)]))

const merge = (set: Interval[]): Interval[] => {
  const sorted = [...set].sort((a, b) => a[0] - b[0])
  const out: Interval[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const subtract = (set: Interval[], cuts: Interval[]): Interval[] => {
  let out = set
  for (const [ca, cb] of cuts) {
    const next: Interval[] = []
    for (const [a, b] of out) {
      if (cb <= a || ca >= b) next.push([a, b])
      else {
        if (ca > a) next.push([a, ca])
        if (cb < b) next.push([cb, b])
      }
    }
    out = next
  }
  return out
}

const intersect = (set: Interval[], [ca, cb]: Interval): Interval[] =>
  set.flatMap(([a, b]): Interval[] => (Math.max(a, ca) <= Math.min(b, cb) ? [[Math.max(a, ca), Math.min(b, cb)]] : []))

const nearest = (set: Interval[], x: number) => {
  let best = set[0][0]
  for (const [a, b] of set) {
    const candidate = Math.min(b, Math.max(a, x))
    if (Math.abs(candidate - x) < Math.abs(best - x)) best = candidate
  }
  return best
}
