// Things in the painting that move, as pure functions of game time. Nothing here is random or
// stateful, so a moving platform's position at any moment can be computed by the generator (to
// guarantee a route), the engine (to land on it), the renderer (to draw it) and a saved run
// (which only needs to keep the clock).

// A platform sweeping horizontally: offset = amp × sin(2π t / period + phase).
export interface Motion {
  amp: number // half range in world units
  period: number // seconds per full swing
  phase: number // radians
}

export const offsetAt = (motion: Motion, t: number) => motion.amp * Math.sin((2 * Math.PI * t) / motion.period + motion.phase)

// Horizontal velocity at time t, in units per second.
export const velocityAt = (motion: Motion, t: number) =>
  ((motion.amp * 2 * Math.PI) / motion.period) * Math.cos((2 * Math.PI * t) / motion.period + motion.phase)

// A black geometric form flying back and forth across the screen at one height, always moving, so it
// is already in motion when it scrolls into view. Its position is a pure function of game time.
export interface Obstacle {
  y: number // bottom edge
  w: number
  h: number
  from: number // left edge at one end of its flight (out of sight)
  to: number // left edge at the other end (out of sight)
  speed: number // units per second
  offset: number // seconds into its cycle at game time 0
}

export const obstacleX = (o: Obstacle, t: number) => {
  const length = Math.abs(o.to - o.from)
  if (length === 0) return o.from
  const along = ((o.speed * (t + o.offset)) % (2 * length) + 2 * length) % (2 * length)
  return o.from + Math.sign(o.to - o.from) * (along < length ? along : 2 * length - along)
}
