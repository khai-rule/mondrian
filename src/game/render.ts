import { type Cell, type Chunk, cellX, type Hue, top } from './composition'
import { type Obstacle, obstacleX } from './motion'
import { type Game, PLAYER_H, PLAYER_W } from './engine'
import { JUMP_V } from './physics'

export const HUES: Record<Hue, string> = {
  white: '#F7F4EC',
  red: '#E2261C',
  yellow: '#F7C51E',
  blue: '#1F4DB5',
}
export const BLACK = '#141414'

export interface View {
  widthPx: number
  heightPx: number
  unit: number // px per world unit
  camY: number
}

// Black background + inset cell fills = black structural lines for free. `live` is false for prints:
// no landing pulses and no obstacles, just the composition (sliders where they were when the run ended).
export const drawWorld = (ctx: CanvasRenderingContext2D, chunks: Chunk[], view: View, time: number, live = true) => {
  const { unit, camY, heightPx } = view
  const line = unit * 0.11
  const topY = camY + heightPx / unit
  const cellRect = (cell: Cell, x: number, inset: number) => {
    ctx.fillStyle = HUES[cell.hue]
    ctx.fillRect(x * unit + inset, heightPx - (top(cell) - camY) * unit + inset, cell.w * unit - inset * 2, cell.h * unit - inset * 2)
  }
  const pulseInset = (cell: Cell) => {
    const pulse = live && cell.hitAt >= 0 ? Math.max(0, 1 - (time - cell.hitAt) / 0.3) : 0
    return (line / 2) * (1 - 0.7 * pulse)
  }
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, view.widthPx, heightPx)
  const visible = chunks.filter((chunk) => chunk.y1 >= camY && chunk.y0 <= topY)
  for (const chunk of visible) for (const cell of chunk.cells) cellRect(cell, cell.x, pulseInset(cell))
  for (const chunk of visible) {
    for (const mover of chunk.movers) {
      const x = cellX(mover, time)
      ctx.fillStyle = BLACK // its own outline, so it reads as a cell wherever it slides over the rail
      ctx.fillRect(x * unit, heightPx - (top(mover) - camY) * unit, mover.w * unit, mover.h * unit)
      cellRect(mover, x, pulseInset(mover))
    }
  }
  if (live) for (const chunk of visible) for (const o of chunk.obstacles) drawObstacle(ctx, o, time, view, line)
}

// A blocky black form, readable at a glance like a cactus or a bird in a side-scrolling runner but
// pure geometry: a long body, a raised block toward the back and a short step at the front. A
// paper-coloured halo keeps it from blending into the grid lines behind it.
const drawObstacle = (ctx: CanvasRenderingContext2D, o: Obstacle, time: number, view: View, line: number) => {
  const { unit, camY, heightPx } = view
  const x = obstacleX(o, time)
  if (x + o.w < 0 || x > view.widthPx / unit) return
  const facing = obstacleX(o, time + 0.05) >= x ? 1 : -1
  const left = x * unit
  const w = o.w * unit
  const h = o.h * unit
  const bottom = heightPx - (o.y - camY) * unit
  const parts: [number, number, number, number][] = [
    [0, 0.42, 1, 0.58], // body
    [facing > 0 ? 0.08 : 0.52, 0, 0.4, 0.5], // raised block toward the back
    [facing > 0 ? 0.88 : -0.06, 0.2, 0.18, 0.4], // step at the front
  ]
  const draw = (grow: number) => {
    for (const [px, py, pw, ph] of parts) ctx.fillRect(left + px * w - grow, bottom - h + py * h - grow, pw * w + grow * 2, ph * h + grow * 2)
  }
  ctx.fillStyle = HUES.white
  draw(line * 0.7)
  ctx.fillStyle = BLACK
  draw(0)
}

export const drawPlayer = (ctx: CanvasRenderingContext2D, game: Game, view: View) => {
  const p = game.player
  const { unit, camY, heightPx } = view
  const k = p.landedAt >= 0 ? Math.min(1, (game.time - p.landedAt) / 0.16) : 1
  const squash = Math.sin(k * Math.PI) * 0.4
  const stretch = Math.min(1, Math.abs(p.vy) / JUMP_V) * 0.15
  const sx = (1 + squash) / (1 + stretch)
  const sy = (1 - squash) * (1 + stretch)
  const w = PLAYER_W * unit * sx
  const h = PLAYER_H * unit * sy
  const cx = p.x * unit
  const feet = heightPx - (p.y - camY) * unit

  ctx.save()
  ctx.translate(cx, feet)
  ctx.rotate((p.vx / 7) * 0.12)
  ctx.fillStyle = BLACK
  ctx.fillRect(-w / 2, -h, w, h)
  ctx.fillStyle = HUES.white
  const eye = unit * 0.13
  ctx.fillRect(p.facing * w * 0.15 - eye / 2, -h * 0.68 - eye / 2, eye, eye)
  ctx.restore()
  drawLanding(ctx, game, view)
}

// "+400 ×4" drifting up from the landing spot for a moment; a miss shows nothing.
const drawLanding = (ctx: CanvasRenderingContext2D, game: Game, view: View) => {
  const landing = game.landing
  if (!landing || landing.gained === 0) return
  const age = (game.time - landing.at) / 0.7
  if (age >= 1) return
  const { unit, camY, heightPx } = view
  ctx.save()
  ctx.globalAlpha = 1 - age * age
  ctx.fillStyle = BLACK
  ctx.font = `800 ${unit * 0.32}px "Inter Tight", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const label = landing.combo >= 2 ? `+${landing.gained} ×${landing.combo}` : `+${landing.gained}`
  ctx.fillText(label, landing.x * unit, heightPx - (landing.y - camY) * unit - unit * (0.9 + age * 0.6))
  ctx.restore()
}
