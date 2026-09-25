import { useEffect, useRef, useState } from 'react'
import { fmtScore, fmtTime, renderArtwork } from '@/game/artwork'
import { createGame, type Direction, type Game, scoreOf, step, VISIBLE_H } from '@/game/engine'
import { drawPlayer, drawWorld, type View } from '@/game/render'
import { getBest, nextRunNumber, setBest } from '@/game/storage'

type Screen = 'landing' | 'playing' | 'result'

interface RunResult {
  score: number
  time: number
  best: number
  isNewBest: boolean
  runNo: number
  art: HTMLCanvasElement
  artUrl: string
}

const unitsWide = () => Math.max(6, Math.round(window.innerWidth / (window.innerHeight / VISIBLE_H)))

const readChallenge = () => {
  const score = Number(new URLSearchParams(window.location.search).get('s'))
  return Number.isFinite(score) && score > 0 ? Math.floor(score) : 0
}

export const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const held = useRef({ left: false, right: false })
  const [screen, setScreen] = useState<Screen>('landing')
  const [best, setBestState] = useState(getBest)
  const [result, setResult] = useState<RunResult | null>(null)
  const [toast, setToast] = useState('')
  const [challenge] = useState(readChallenge)

  const start = () => {
    held.current = { left: false, right: false }
    gameRef.current = createGame(unitsWide(), 'playing')
    setToast('')
    setScreen('playing')
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const view: View = { widthPx: 0, heightPx: 0, unit: 1, camY: 0 }
    let raf = 0
    let last = performance.now()
    let reported: Game | null = null

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      view.widthPx = window.innerWidth
      view.heightPx = window.innerHeight
      const game = gameRef.current
      if (!game || (game.mode === 'idle' && game.width !== unitsWide())) gameRef.current = createGame(unitsWide(), 'idle')
    }

    const finishRun = async (game: Game) => {
      const score = scoreOf(game)
      const previousBest = getBest()
      const isNewBest = score > previousBest
      if (isNewBest) setBest(score)
      const runNo = nextRunNumber()
      const art = await renderArtwork(game, { runNo, score, time: game.time })
      setBestState(Math.max(previousBest, score))
      setResult({ score, time: game.time, best: Math.max(previousBest, score), isNewBest, runNo, art, artUrl: art.toDataURL('image/png') })
      setScreen('result')
    }

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      const game = gameRef.current
      if (game) {
        step(game, dt)
        view.unit = view.widthPx / game.width
        view.camY = game.camY
        drawWorld(ctx, game.chunks, view, game.time)
        if (game.mode !== 'idle') drawPlayer(ctx, game, view)
        if (scoreRef.current) scoreRef.current.textContent = fmtScore(scoreOf(game))
        if (timeRef.current) timeRef.current.textContent = fmtTime(game.time)
        if (game.mode === 'dead' && reported !== game) {
          reported = game
          void finishRun(game)
        }
      }
      raf = requestAnimationFrame(frame)
    }

    resize()
    window.addEventListener('resize', resize)
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => {
    const applyDir = () => {
      const game = gameRef.current
      if (game) game.dir = ((held.current.right ? 1 : 0) - (held.current.left ? 1 : 0)) as Direction
    }
    const onKey = (isDown: boolean) => (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (key === 'arrowleft' || key === 'a') held.current.left = isDown
      else if (key === 'arrowright' || key === 'd') held.current.right = isDown
      else if (isDown && (key === ' ' || key === 'enter') && screen !== 'playing') {
        e.preventDefault()
        start()
        return
      } else return
      e.preventDefault()
      applyDir()
    }
    const down = onKey(true)
    const up = onKey(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [screen])

  const setTouchDir = (clientX: number | null) => {
    const game = gameRef.current
    if (!game || game.mode !== 'playing') return
    game.dir = clientX === null ? 0 : clientX < window.innerWidth / 2 ? -1 : 1
  }

  const share = async () => {
    if (!result) return
    const url = `${window.location.origin}${window.location.pathname}?s=${result.score}&t=${Math.floor(result.time)}`
    const text = `I scored ${fmtScore(result.score)} in MONDRIAN and made this. PLAY MONDRIAN →`
    const blob = await new Promise<Blob | null>((resolve) => result.art.toBlob(resolve, 'image/png'))
    const file = blob ? new File([blob], 'mondrian.png', { type: 'image/png' }) : null
    try {
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'MONDRIAN', text, url })
        return
      }
      await navigator.clipboard.writeText(url)
      if (file) {
        const a = document.createElement('a')
        a.href = result.artUrl
        a.download = `mondrian-run-${String(result.runNo).padStart(3, '0')}.png`
        a.click()
      }
      setToast('LINK COPIED · ARTWORK SAVED')
    } catch {
      setToast('SHARE CANCELLED')
    }
  }

  return (
    <main className="stage">
      <canvas
        ref={canvasRef}
        className="stage__canvas"
        aria-label="MONDRIAN game"
        onPointerDown={(e) => setTouchDir(e.clientX)}
        onPointerMove={(e) => e.buttons > 0 && setTouchDir(e.clientX)}
        onPointerUp={() => setTouchDir(null)}
        onPointerCancel={() => setTouchDir(null)}
      />

      {screen === 'playing' && (
        <div className="hud" aria-live="off">
          <span ref={scoreRef}>0</span>
          <span ref={timeRef}>00:00</span>
        </div>
      )}

      {screen === 'landing' && (
        <section className="overlay">
          <div className="panel">
            <h1>MONDRIAN</h1>
            <p className="tag">JUMP. BALANCE. SURVIVE.</p>
            <button type="button" onClick={start} autoFocus>
              PLAY
            </button>
            <p className="hint">← → OR A D TO MOVE · SPACE TO PLAY</p>
            <p className="hint hint--touch">TAP LEFT / RIGHT SIDE OF THE SCREEN</p>
            {best > 0 && (
              <p className="stat">
                BEST <b>{fmtScore(best)}</b>
              </p>
            )}
            {challenge > 0 && (
              <p className="stat stat--red">
                SOMEONE SCORED <b>{fmtScore(challenge)}</b>. BEAT IT.
              </p>
            )}
          </div>
        </section>
      )}

      {screen === 'result' && result && (
        <section className="overlay">
          <div className="panel panel--result">
            <p className={result.isNewBest ? 'label label--new' : 'label'}>{result.isNewBest ? 'NEW BEST' : 'SCORE'}</p>
            <p className="score">{fmtScore(result.score)}</p>
            <div className="stats">
              <div>
                TIME<b>{fmtTime(result.time)}</b>
              </div>
              <div>
                BEST<b>{fmtScore(result.best)}</b>
              </div>
            </div>
            <img className="art" src={result.artUrl} alt={`Composition from run ${result.runNo}`} />
            <div className="actions">
              <button type="button" onClick={start} autoFocus>
                PLAY AGAIN
              </button>
              <button type="button" className="button--secondary" onClick={share}>
                SHARE
              </button>
            </div>
            {toast !== '' && <p className="toast">{toast}</p>}
          </div>
        </section>
      )}
    </main>
  )
}
