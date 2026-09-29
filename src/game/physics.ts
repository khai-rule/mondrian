// Player physics and world speed, shared by the engine (simulation) and the generator (route planning).
export const GRAVITY = 30
export const JUMP_V = 15.5
export const MOVE_SPEED = 7
export const MOVE_ACCEL = 70
export const PLAYER_W = 0.7
export const PLAYER_H = 0.7
export const VISIBLE_H = 16 // nominal world units visible vertically
export const CAMERA_FOLLOW = 0.45 // the camera is pulled up whenever the player is above this fraction of the screen
export const JUMP_APEX = JUMP_V ** 2 / (2 * GRAVITY) // ≈ 4.0 units
export const MAX_GAP = Math.floor(JUMP_APEX - 0.5) // 3: largest vertical step the route may ask for

// Time to reach the top of a jump, and the height above the screen bottom the player can be at the
// apex before the camera is pulled up after them.
export const APEX_TIME = JUMP_V / GRAVITY

// Seconds between leaving one platform and landing on one `dy` units higher.
export const hopTime = (dy: number) => (JUMP_V + Math.sqrt(JUMP_V ** 2 - 2 * GRAVITY * dy)) / GRAVITY

// Horizontal distance the player can be relied on to cover during that hop. Worst case: they land
// moving at full speed the wrong way and must reverse (2 × MOVE_SPEED / MOVE_ACCEL seconds spent
// getting nowhere), plus a little for the player's own width.
const REVERSAL_LOSS = MOVE_SPEED * ((2 * MOVE_SPEED) / MOVE_ACCEL)
export const horizontalReach = (dy: number) => Math.max(0, MOVE_SPEED * hopTime(dy) - REVERSAL_LOSS - 0.4)

// WORLD SPEED. Scroll speed is a function of altitude, not of the clock: the generator builds
// each chunk knowing exactly how fast the world will move there. Altitude tracks time closely
// (the camera climbs with the world), so it still reads as "gradually faster the longer you last".
// Smoothstep gives a gentle start, a smooth middle and an ease into the ceiling, then it stays put.
export const MIN_SCROLL_SPEED = 0.7 // units/second
export const MAX_SCROLL_SPEED = 2.7 // hard ceiling; a perfect climber manages 3.87 (MAX_GAP hops back to back), and 3.37 is the most the route can pace against
export const SPEED_RAMP_HEIGHT = 130 // altitude at which the ceiling is reached (a bit over a minute in)

export const scrollSpeedAt = (altitude: number) => {
  const t = Math.max(0, altitude / SPEED_RAMP_HEIGHT)
  if (t >= 1) return MAX_SCROLL_SPEED // exactly the ceiling, never a hair above it
  return MIN_SCROLL_SPEED + (MAX_SCROLL_SPEED - MIN_SCROLL_SPEED) * t * t * (3 - 2 * t)
}

// FIXED STEP. The game advances in constant 1/120 s steps, whatever the display's frame rate. That makes
// every hop last an exact whole number of steps, so the generator can compute precisely when a player
// following the route lands on each platform, and decide where moving platforms will be at that moment.
export const STEP = 1 / 120

export interface HopProfile {
  steps: number // steps from leaving a platform to landing `gap` units higher
  y: number[] // height above the launch platform after each step, 0..steps
}

const profiles = new Map<number, HopProfile>()

// Replays the engine's own integrator (same operations, same order), so it can't drift from it.
export const hopProfile = (gap: number): HopProfile => {
  const cached = profiles.get(gap)
  if (cached) return cached
  const y = [0]
  let height = 0
  let vy = JUMP_V
  for (;;) {
    const previous = height
    vy -= GRAVITY * STEP
    height += vy * STEP
    if (vy < 0 && previous >= gap && height <= gap) {
      y.push(gap) // the engine snaps the player to the platform top
      break
    }
    y.push(height)
    if (y.length > 2000) throw new Error(`no landing at gap ${gap}`)
  }
  const profile = { steps: y.length - 1, y }
  profiles.set(gap, profile)
  return profile
}

export const hopSeconds = (gap: number) => hopProfile(gap).steps * STEP
