import { useEffect, useRef, useState } from 'react'
import { startSession } from '@/game/api'
import { fmtScore } from '@/game/artwork'
import { createGame, type Game, pause, resume, scoreOf, step, VISIBLE_H } from '@/game/engine'
import { createInput, type Side } from '@/game/input'
import { STEP } from '@/game/physics'
import { drawPlayer, drawWorld, type View } from '@/game/render'
import { clearRun, loadRun, saveRun } from '@/game/save'
import { getBest, setBest } from '@/game/storage'
import { LeaderboardPanel } from '@/leaderboard'
import { ResultPanel, type RunResult } from '@/result'

type Screen = 'landing' | 'playing' | 'paused' | 'countdown' | 'result' | 'leaderboard'

const AUTOSAVE_MS = 3000
const COUNTDOWN_STEP_MS = 700
const GO_FLASH_MS = 600
const MAX_CATCH_UP = 0.1 // never simulate more than this much real time per frame (a hidden or slow tab just slows down)

// Keyboard and touch both write into this one LEFT/RIGHT state; the engine only ever sees `dir`.
const input = createInput()

const unitsWide = () => Math.max(6, Math.round(window.innerWidth / (window.innerHeight / VISIBLE_H)))

const readChallenge = () => {
  const score = Number(new URLSearchParams(window.location.search).get('s'))
  return Number.isFinite(score) && score > 0 ? Math.floor(score) : 0
}

const sideOf = (clientX: number): Side => (clientX < window.innerWidth / 2 ? 'left' : 'right')

export const App = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<Game | null>(null)
  const scoreRef = useRef<HTMLSpanElement>(null)
  const comboRef = useRef<HTMLSpanElement>(null)
  const [screen, setScreen] = useState<Screen>('landing')
  const [best, setBestState] = useState(getBest)
  const [result, setResult] = useState<RunResult | null>(null)
  const [boardFrom, setBoardFrom] = useState<'landing' | 'result'>('landing')
  const [saved, setSaved] = useState(loadRun) // an unfinished run left on this device
  const [count, setCount] = useState<number | null>(null) // 3, 2, 1, then 0 = GO
  const [challenge] = useState(readChallenge)

  // Dev-only inspection hook for manual testing; compiled out of production builds.
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __game: () => gameRef.current, __setGame: (game: Game) => (gameRef.current = game) })
  }, [])

  const syncDir = () => {
    const game = gameRef.current
    if (game) game.dir = input.dir
  }

  const start = () => {
    const game = createGame(unitsWide(), 'playing')
    gameRef.current = game
    input.clear()
    setResult(null)
    setSaved(null)
    setScreen('playing')
    saveRun(game) // leaving right away still keeps the run
    void attachSession(game)
  }

  const resumeSaved = () => {
    if (!saved) return
    gameRef.current = saved
    input.clear()
    setSaved(null)
    setResult(null)
    setScreen('countdown')
  }

  const pauseRun = () => {
    const game = gameRef.current
    if (!game || game.mode !== 'playing') return
    pause(game)
    saveRun(game)
    setScreen('paused')
  }

  const openLeaderboard = (from: 'landing' | 'result') => {
    setBoardFrom(from)
    setScreen('leaderboard')
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const view: View = { widthPx: 0, heightPx: 0, unit: 1, camY: 0 }
    let raf = 0
    let last = performance.now()
    let lastSave = last
    let leftover = 0 // real time not yet simulated: the game advances in fixed steps
    let reported: Game | null = null

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2) // 3x phones render at 2x: same look, far fewer pixels
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      view.widthPx = window.innerWidth
      view.heightPx = window.innerHeight
      const game = gameRef.current
      if (!game || (game.mode === 'idle' && game.width !== unitsWide())) gameRef.current = createGame(unitsWide(), 'idle')
    }

    const finishRun = (game: Game) => {
      clearRun() // the run is over: nothing left to resume
      setSaved(null)
      const score = scoreOf(game)
      const previousBest = getBest()
      const isNewBest = score > previousBest
      if (isNewBest) setBest(score)
      const bestScore = Math.max(previousBest, score)
      setBestState(bestScore)
      setResult({ score, time: game.time, best: bestScore, bestCombo: game.bestCombo, isNewBest, game })
      setScreen('result')
    }

    const frame = (now: number) => {
      leftover += Math.min((now - last) / 1000, MAX_CATCH_UP)
      last = now
      const game = gameRef.current
      if (game) {
        for (; leftover >= STEP; leftover -= STEP) step(game, STEP)
        view.unit = view.widthPx / game.width
        view.camY = game.camY
        drawWorld(ctx, game.chunks, view, game.time)
        if (game.mode !== 'idle') drawPlayer(ctx, game, view)
        if (scoreRef.current) scoreRef.current.textContent = fmtScore(scoreOf(game))
        if (comboRef.current) {
          comboRef.current.textContent = `×${game.combo}`
          comboRef.current.hidden = game.combo < 2
        }
        if (game.mode === 'playing' && now - lastSave > AUTOSAVE_MS) {
          saveRun(game)
          lastSave = now
        }
        if (game.mode === 'dead' && reported !== game) {
          reported = game
          finishRun(game)
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

  // 3 → 2 → 1 → GO. The game stays frozen until GO, then continues from the exact saved state.
  useEffect(() => {
    if (screen !== 'countdown') return
    let remaining = 3
    setCount(remaining)
    const id = setInterval(() => {
      remaining -= 1
      if (remaining > 0) return setCount(remaining)
      clearInterval(id)
      const game = gameRef.current
      if (game) {
        resume(game)
        game.dir = input.dir
      }
      setCount(0)
      setScreen('playing')
      setTimeout(() => setCount(null), GO_FLASH_MS)
    }, COUNTDOWN_STEP_MS)
    return () => clearInterval(id)
  }, [screen])

  useEffect(() => {
    const onKey = (isDown: boolean) => (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return // typing a name, not steering
      const key = e.key.toLowerCase()
      const onControl = e.target instanceof Element && e.target.closest('button, a') !== null
      if (key === 'arrowleft' || key === 'a') input.setKey('left', isDown)
      else if (key === 'arrowright' || key === 'd') input.setKey('right', isDown)
      else if (isDown && !e.repeat && !onControl && (key === ' ' || key === 'enter' || key === 'escape' || key === 'p')) {
        e.preventDefault()
        if (screen === 'playing') pauseRun()
        else if (screen === 'paused' && key !== 'escape') setScreen('countdown')
        else if (screen === 'landing' && key !== 'escape') saved ? resumeSaved() : start()
        else if (screen === 'result' && key !== 'escape') start()
        return
      } else return
      e.preventDefault()
      syncDir()
    }
    const down = onKey(true)
    const up = onKey(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [screen, saved])

  // Leaving the page: never lose the run, never leave a key or finger "held" that can't be released.
  useEffect(() => {
    const release = () => {
      input.clear()
      syncDir()
    }
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return
      release()
      if (screen === 'playing') pauseRun()
      else if (screen === 'countdown') setScreen('paused')
    }
    const onPageHide = () => {
      const game = gameRef.current
      if (game) saveRun(game)
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('blur', release)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('blur', release)
    }
  }, [screen])

  // Browser gestures are only suppressed while a run is on screen.
  const isRun = screen === 'playing' || screen === 'paused' || screen === 'countdown'
  useEffect(() => {
    document.documentElement.classList.toggle('is-playing', isRun)
    return () => document.documentElement.classList.remove('is-playing')
  }, [isRun])

  // Touch = holding a key. Only the side of the screen where the finger lands matters (never where it
  // moves), so a finger can't position the player: it can only hold LEFT or RIGHT, like an arrow key.
  const touchDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId) // so the release is always delivered
    } catch {
      // synthetic or already-ended pointers can't be captured: the release events still arrive normally
    }
    input.touchDown(e.pointerId, sideOf(e.clientX))
    syncDir()
  }

  const touchUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    input.touchUp(e.pointerId)
    syncDir()
  }

  return (
    <main className={isRun ? 'stage stage--run' : 'stage'}>
      <canvas
        ref={canvasRef}
        className="stage__canvas"
        aria-label="MONDRIAN game"
        onPointerDown={touchDown}
        onPointerUp={touchUp}
        onPointerCancel={touchUp}
        onLostPointerCapture={touchUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="paper" aria-hidden="true" />

      {isRun && (
        <div className="hud">
          <span className="hud__chip">
            <span ref={scoreRef}>0</span>
            <span ref={comboRef} className="hud__combo" hidden />
          </span>
          <span className="hud__right">
            <button type="button" className="hud__pause" aria-label="Pause game" onClick={pauseRun} disabled={screen !== 'playing'}>
              <span aria-hidden="true">II</span>
            </button>
          </span>
        </div>
      )}

      {screen === 'paused' && (
        <section className="overlay" role="dialog" aria-modal="true" aria-label="Game paused">
          <div className="panel">
            <h1>PAUSED</h1>
            <p className="tag tag--keys">SPACE TO RESUME</p>
            <button type="button" onClick={() => setScreen('countdown')} autoFocus>
              RESUME
            </button>
          </div>
        </section>
      )}

      {count !== null && (screen === 'countdown' || screen === 'playing') && (
        <div className="countdown" role="status" aria-live="assertive">
          <span>{count === 0 ? 'GO' : count}</span>
        </div>
      )}

      {screen === 'landing' && (
        <section className="overlay">
          <div className="panel">
            <h1>MONDRIAN</h1>
            <p className="tag">JUMP. BALANCE. SURVIVE.</p>
            {saved ? (
              <>
                <p className="stat stat--first">
                  RUN IN PROGRESS <b>{fmtScore(scoreOf(saved))}</b>
                </p>
                <button type="button" onClick={resumeSaved} autoFocus>
                  RESUME RUN
                </button>
                <button type="button" className="button--secondary button--stacked" onClick={start}>
                  NEW RUN
                </button>
              </>
            ) : (
              <button type="button" onClick={start} autoFocus>
                PLAY
              </button>
            )}
            <p className="hint">← → OR A D TO MOVE · SPACE TO PLAY / PAUSE</p>
            <p className="hint hint--touch">HOLD THE LEFT OR RIGHT SIDE OF THE SCREEN</p>
            <button type="button" className="button--text" onClick={() => openLeaderboard('landing')}>
              LEADERBOARD
            </button>
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

      {result && (screen === 'result' || screen === 'leaderboard') && (
        <ResultPanel
          run={result}
          hidden={screen === 'leaderboard'}
          onPlayAgain={start}
        />
      )}

      {screen === 'leaderboard' && <LeaderboardPanel onBack={() => setScreen(boardFrom)} />}
    </main>
  )
}

// The server timestamps each run as it begins, so a submitted run can't claim more time than passed.
const attachSession = async (game: Game) => {
  try {
    game.sid = await startSession()
  } catch {
    game.sid = null // offline: the run plays fine but can't be submitted to the leaderboard
  }
}
