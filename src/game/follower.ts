import { cellX, top } from './composition'
import type { Direction, Game } from './engine'
import { hopSeconds, JUMP_V, MOVE_ACCEL } from './physics'
import { planHop, SETTLE_TIME } from './planner'

// A player that keeps the generator's promise: on every landing it asks the planner for a path to the
// next route platform (where that platform will be when the hop ends, around every obstacle) and
// steers along it using only LEFT and RIGHT, exactly like a keyboard. Like a careful human it looks one
// jump ahead: it lands settled at a spot from which the following jump is also clear of any obstacle.
// Used by tests and stress scripts to prove the world can always be played; the game never imports it.
export const createFollower = () => {
  let plan: number[] | null = null
  let aim: { x: number; w: number } | null = null
  let sinceLanding = 0

  return (game: Game): Direction => {
    const p = game.player
    if (p.vy === JUMP_V) {
      sinceLanding = 0
      const route = game.chunks.flatMap((chunk) => chunk.route).sort((a, b) => top(a) - top(b))
      const target = route.find((cell) => top(cell) > p.y + 0.5)
      const after = target && route.find((cell) => top(cell) > top(target) + 0.5)
      aim = target ? { x: target.x, w: target.w } : null
      const obstacles = game.chunks.flatMap((chunk) => chunk.obstacles)
      const hop = (target: NonNullable<typeof route[number]>, start: number, at: number, from: number, aimAt?: [number, number], settle?: number) =>
        planHop({
          width: game.width,
          launchT: at,
          launchY: from,
          gap: top(target) - from,
          start,
          v0: 0,
          target: (t) => aimAt ?? [cellX(target, t) + 0.15, cellX(target, t) + target.w - 0.15],
          obstacles,
          settle,
        })
      plan = null
      if (target) {
        plan = planHop({
          width: game.width,
          launchT: game.time,
          launchY: p.y,
          gap: top(target) - p.y,
          start: p.x,
          v0: p.vx,
          target: (t) => [cellX(target, t) + 0.15, cellX(target, t) + target.w - 0.15],
          obstacles,
        })
        // Prefer a settled landing that leaves the next jump clear of obstacles.
        if (!target.motion && after) {
          const middle = target.x + target.w / 2
          const spots = [0, 0.25, -0.25, 0.5, -0.5].map((d) => middle + d).filter((c) => c >= target.x + 0.2 && c <= target.x + target.w - 0.2)
          const landAt = game.time + hopSeconds(top(target) - p.y)
          for (const c of spots) {
            const arrive = planHop({
              width: game.width,
              launchT: game.time,
              launchY: p.y,
              gap: top(target) - p.y,
              start: p.x,
              v0: p.vx,
              target: () => [c - 0.05, c + 0.05],
              obstacles,
              settle: SETTLE_TIME,
            })
            if (arrive && hop(after, c, landAt, top(target))) {
              plan = arrive
              break
            }
          }
        }
      }
        // Nothing clear from here? Wait: bounce once on this platform and look again a moment later.
        if (!plan) {
          const here = game.chunks
            .flatMap((chunk) => chunk.cells.concat(chunk.movers))
            .find((cell) => top(cell) === p.y && cell.hue !== 'white' && p.x > cellX(cell, game.time) - 0.3 && p.x < cellX(cell, game.time) + cell.w + 0.3)
          if (here && !here.motion) {
            plan = planHop({
              width: game.width,
              launchT: game.time,
              launchY: p.y,
              gap: 0,
              start: p.x,
              v0: p.vx,
              target: () => [here.x + 0.15, here.x + here.w - 0.15],
              obstacles,
            })
            if (plan) aim = { x: here.x, w: here.w }
          }
        }
    } else sinceLanding++

    // no plan (should not happen): head for the middle of the target
    const desired = plan ? plan[Math.min(sinceLanding + 2, plan.length - 1)] : aim ? aim.x + aim.w / 2 : p.x
    // Steer for where the player would coast to a stop, not where they are, so they brake in time.
    const coast = (p.vx * Math.abs(p.vx)) / (2 * MOVE_ACCEL)
    const error = desired - (p.x + coast)
    return Math.abs(error) < 0.04 ? 0 : error > 0 ? 1 : -1
  }
}
