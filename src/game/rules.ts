// Rules shared by the game and the leaderboard server, so a score means the same thing on both sides.
// Environment-neutral on purpose: no DOM, no Bun.
import { hopTime, JUMP_APEX, MAX_GAP, MOVE_SPEED, scrollSpeedAt } from './physics'

export const LANDING_POINTS = 10 // per landing, multiplied by the combo
export const START_CAM_Y = -1
export const MAX_RUN_SECONDS = 3 * 60 * 60

export interface ComboState {
  combo: number // consecutive climbing landings; the score multiplier
  bestCombo: number
  points: number // earned from landings
  lastTop: number // top of the platform last landed on
}

// COMBO: a landing on a higher platform than the last extends the chain and pays
// LANDING_POINTS × combo. Landing on the same platform (or lower) is a miss: no points, chain broken.
export const applyLanding = (state: ComboState, top: number) => {
  const climbed = top > state.lastTop
  state.combo = climbed ? state.combo + 1 : 0
  state.bestCombo = Math.max(state.bestCombo, state.combo)
  const gained = climbed ? LANDING_POINTS * state.combo : 0
  state.points += gained
  state.lastTop = top
  return gained
}

export const round2 = (n: number) => Math.round(n * 100) / 100

// Height and time are rounded first so client and server always agree to the point.
export const computeScore = (points: number, maxY: number, time: number) =>
  points + Math.floor(round2(maxY) * 10 + round2(time) * 15)

// One landing: [game seconds, platform top, x]
export type LandingRecord = [t: number, top: number, x: number]

export interface RunClaim {
  width: number
  start: number // top of the platform the run began on
  landings: LandingRecord[]
  time: number
  maxY: number
}

export type Verdict =
  | { ok: true; points: number; bestCombo: number; score: number }
  | { ok: false; reason: string }

const HOP_TOLERANCE = 0.12 // one 30 fps frame of quantisation plus integration error
const NEAR_APEX_EXTRA = 0.3 // hop time is very sensitive to height close to the apex
const FALL_SECONDS = 4 // longest a player can survive after their last landing
const CAMERA_MARGIN = 0.9 // landing must be no lower than the scrolling screen edge (0.7) plus rounding

// Replays a run's landing log against the physics and returns the score the log actually earns.
// Every landing must be a real hop (height and duration match the jump arc), horizontally
// reachable, and above the scrolling screen edge, so a fabricated log can't beat a perfect run.
// `elapsed` is the server-measured wall time since the run's session began.
export const verifyRun = (claim: RunClaim, elapsed: number): Verdict => {
  const { width, start, landings, time, maxY } = claim
  const fail = (reason: string): Verdict => ({ ok: false, reason })
  if (!Number.isInteger(width) || width < 4 || width > 200) return fail('bad width')
  if (!Number.isInteger(start) || start < 1 || start > MAX_GAP) return fail('bad start')
  if (!Number.isFinite(time) || time <= 0 || time > MAX_RUN_SECONDS) return fail('bad time')
  if (!Number.isFinite(maxY)) return fail('bad height')
  if (time > elapsed * 1.02 + 2) return fail('run is longer than the session')
  if (landings.length > time / 0.4 + 2) return fail('too many landings')

  const state: ComboState = { combo: 0, bestCombo: 0, points: 0, lastTop: start }
  let previous = { t: 0, top: start, x: -1 }
  let cam = START_CAM_Y
  let camT = 0
  let highest = start

  for (const [t, top, x] of landings) {
    if (!Number.isFinite(t) || !Number.isInteger(top) || !Number.isFinite(x)) return fail('bad landing')
    if (x < 0 || x > width) return fail('landing off screen')
    const dt = t - previous.t
    const dy = top - previous.top
    if (dy > JUMP_APEX) return fail('jump too high')
    const tolerance = HOP_TOLERANCE + (dy >= 3.5 ? NEAR_APEX_EXTRA : 0)
    if (Math.abs(dt - hopTime(dy)) > tolerance) return fail('impossible jump timing')
    if (previous.x >= 0 && Math.abs(x - previous.x) > MOVE_SPEED * dt + 0.6) return fail('impossible movement')
    while (camT < t) {
      const h = Math.min(0.05, t - camT)
      cam += scrollSpeedAt(cam) * h
      camT += h
    }
    if (top < cam - CAMERA_MARGIN) return fail('landing below the screen')
    applyLanding(state, top)
    highest = Math.max(highest, top)
    previous = { t, top, x }
  }

  if (time < previous.t || time - previous.t > FALL_SECONDS) return fail('inconsistent run end')
  if (maxY < highest - 0.01 || maxY > highest + JUMP_APEX + 0.3) return fail('inconsistent height')
  return { ok: true, points: state.points, bestCombo: state.bestCombo, score: computeScore(state.points, maxY, time) }
}
