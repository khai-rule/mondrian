import type { Game } from './engine'
import { BLACK, drawWorld, HUES } from './render'

export interface RunMeta {
  runNo: number
  score: number
  time: number
}

export const fmtScore = (n: number) => n.toLocaleString('en-US')
export const fmtTime = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// A clean 4:5 poster of the summit of the run's composition, no player, tiny metadata band.
export const renderArtwork = async (game: Game, meta: RunMeta) => {
  await document.fonts.ready
  const W = 1080
  const H = 1350
  const band = 120
  const artH = H - band
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const unit = W / game.width
  const camY = Math.max(0, game.maxY + 2 - artH / unit)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, W, artH)
  ctx.clip()
  drawWorld(ctx, game.chunks, { widthPx: W, heightPx: artH, unit, camY }, game.time + 10)
  ctx.restore()

  ctx.fillStyle = HUES.white
  ctx.fillRect(0, artH, W, band)
  ctx.fillStyle = BLACK
  ctx.fillRect(0, artH, W, 10)
  ctx.textBaseline = 'middle'
  ctx.font = '800 34px "Inter Tight", system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('MONDRIAN', 44, artH + band / 2 + 4)
  ctx.font = '500 22px "IBM Plex Mono", monospace'
  ctx.textAlign = 'right'
  const run = String(meta.runNo).padStart(3, '0')
  ctx.fillText(`RUN ${run}   SCORE ${fmtScore(meta.score)}   ${fmtTime(meta.time)}`, W - 44, artH + band / 2 + 4)
  return canvas
}
