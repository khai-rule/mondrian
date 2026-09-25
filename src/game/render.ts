import { type Chunk, type Hue, top } from './composition'
import { type Game, JUMP_V, PLAYER_H, PLAYER_W } from './engine'

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

// Black background + inset cell fills = black structural lines for free.
export const drawWorld = (ctx: CanvasRenderingContext2D, chunks: Chunk[], view: View, now: number) => {
  const { unit, camY, heightPx } = view
  const line = unit * 0.11
  const topY = camY + heightPx / unit
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, view.widthPx, heightPx)
  for (const chunk of chunks) {
    if (chunk.y1 < camY || chunk.y0 > topY) continue
    for (const cell of chunk.cells) {
      const pulse = cell.hitAt >= 0 ? Math.max(0, 1 - (now - cell.hitAt) / 0.3) : 0
      const inset = (line / 2) * (1 - 0.7 * pulse)
      ctx.fillStyle = HUES[cell.hue]
      ctx.fillRect(
        cell.x * unit + inset,
        heightPx - (top(cell) - camY) * unit + inset,
        cell.w * unit - inset * 2,
        cell.h * unit - inset * 2,
      )
    }
  }
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
}
