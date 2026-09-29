import type { Game } from './engine'
import paperUrl from '@/assets/paper.png'
import { BLACK, drawWorld, HUES } from './render'

export interface ArtworkMeta {
  score: number
  bestCombo: number
  rank?: number // known once the score is submitted
  runNo?: number
}

export const fmtScore = (n: number) => n.toLocaleString('en-US')

const W = 1080
const H = 1350
const MARGIN = 72
const PICTURE_H = 1040

// The run's summit as a print: the composition dominates, framed by paper, with a small
// museum-style label. No player, no game UI.
export const renderArtwork = async (game: Game, meta: ArtworkMeta): Promise<Blob> => {
  await Promise.all([document.fonts.load('800 34px "Inter Tight"'), document.fonts.load('500 22px "IBM Plex Mono"')])
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')

  ctx.fillStyle = HUES.white
  ctx.fillRect(0, 0, W, H)

  const pictureW = W - MARGIN * 2
  const unit = pictureW / game.width
  const camY = Math.max(0, game.maxY + 2 - PICTURE_H / unit)
  ctx.save()
  ctx.translate(MARGIN, MARGIN)
  ctx.beginPath()
  ctx.rect(0, 0, pictureW, PICTURE_H)
  ctx.clip()
  drawWorld(ctx, game.chunks, { widthPx: pictureW, heightPx: PICTURE_H, unit, camY }, game.time, false)
  ctx.restore()
  ctx.strokeStyle = BLACK // the frame closes the edges where the composition is cropped
  ctx.lineWidth = 6
  ctx.strokeRect(MARGIN, MARGIN, pictureW, PICTURE_H)

  drawLabel(ctx, meta)

  const paper = await loadPaper().catch(() => null) // the real paper texture, laid over the whole print
  const pattern = paper && ctx.createPattern(paper, 'repeat')
  if (pattern) {
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, W, H)
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode artwork'))), 'image/png')
  })
}

let paperImage: Promise<HTMLImageElement> | null = null
const loadPaper = () =>
  (paperImage ??= new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = paperUrl
  }))

const drawLabel = (ctx: CanvasRenderingContext2D, meta: ArtworkMeta) => {
  const top = MARGIN + PICTURE_H
  const lines = [
    `SCORE ${fmtScore(meta.score)}`,
    `BEST COMBO ×${meta.bestCombo}`,
    ...(meta.rank === undefined ? [] : [`GLOBAL #${meta.rank}`]),
    ...(meta.runNo === undefined ? [] : [`RUN #${String(meta.runNo).padStart(5, '0')}`]),
  ]
  ctx.fillStyle = BLACK
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.font = '800 38px "Inter Tight", system-ui, sans-serif'
  ctx.fillText('MONDRIAN', MARGIN, top + 76)
  ctx.font = '400 20px "IBM Plex Mono", monospace'
  ctx.letterSpacing = '3px'
  ctx.fillText('PILOT 003', MARGIN, top + 112)

  ctx.font = '500 22px "IBM Plex Mono", monospace'
  ctx.textAlign = 'right'
  for (const [i, line] of lines.entries()) ctx.fillText(line, W - MARGIN + 3, top + 56 + i * 34)
  ctx.letterSpacing = '0px'
}
