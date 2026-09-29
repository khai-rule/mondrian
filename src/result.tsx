import { useEffect, useRef, useState } from 'react'
import { ApiError, type Submission, submitScore, uploadArtwork } from '@/game/api'
import { fmtScore, renderArtwork } from '@/game/artwork'
import type { Game } from '@/game/engine'
import { round2 } from '@/game/rules'
import { BoardList } from '@/leaderboard'
import { getMyEntry, getName, setMyEntry, setName as saveName } from '@/game/storage'

export interface RunResult {
  score: number
  time: number
  best: number
  bestCombo: number
  isNewBest: boolean
  game: Game
}

interface Props {
  run: RunResult
  hidden: boolean
  onPlayAgain: () => void
}

interface Artwork {
  blob: Blob
  url: string
  entryId: number | null // which submission this picture was drawn for; null = before submitting
}

type Status = 'idle' | 'sending' | 'unreachable' | 'rejected'

const isTouch = () => window.matchMedia('(pointer: coarse)').matches

export const ResultPanel = ({ run, hidden, onPlayAgain }: Props) => {
  const [name, setName] = useState(getName)
  const [status, setStatus] = useState<Status>('idle')
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [art, setArt] = useState<Artwork | null>(null)
  const [toast, setToast] = useState('')
  const urlRef = useRef('')
  const entry = submission?.entry ?? null
  const score = entry?.score ?? run.score

  // The painting is drawn once on death, then redrawn with rank and run number once they exist.
  useEffect(() => {
    let isCurrent = true
    const draw = async () => {
      const blob = await renderArtwork(run.game, {
        score: submission?.entry.score ?? run.score,
        bestCombo: run.bestCombo,
        rank: submission?.entry.rank,
        runNo: submission?.entry.id,
      })
      if (!isCurrent) return
      if (urlRef.current !== '') URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(blob)
      setArt({ blob, url: urlRef.current, entryId: submission?.entry.id ?? null })
      if (submission) void uploadArtwork(submission, blob)
    }
    void draw()
    return () => {
      isCurrent = false
    }
  }, [run, submission])

  useEffect(() => () => URL.revokeObjectURL(urlRef.current), [])

  const submit = async () => {
    const cleaned = name.trim().replace(/\s+/g, ' ')
    if (cleaned === '' || status === 'sending') return
    setName(cleaned)
    saveName(cleaned)
    setStatus('sending')
    const { game } = run
    try {
      const sent = await submitScore({
        sid: game.sid ?? '',
        name: cleaned,
        width: game.width,
        start: game.startTop,
        landings: game.log,
        time: round2(game.time),
        maxY: round2(game.maxY),
      })
      if (sent.entry.score > (getMyEntry()?.score ?? 0)) setMyEntry({ id: sent.entry.id, score: sent.entry.score })
      setSubmission(sent)
      setStatus('idle')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status < 500 ? 'rejected' : 'unreachable')
    }
  }

  // Only ever share the picture drawn for this run and its current standing.
  const artReady = art !== null && art.entryId === (entry?.id ?? null)
  const canShare = artReady && (entry !== null || status === 'unreachable' || status === 'rejected')
  const fileName = `mondrian-${entry ? String(entry.id).padStart(5, '0') : 'run'}.png`

  const share = async () => {
    if (!art || !artReady) return
    const summary = [
      `I scored ${fmtScore(score)}${entry ? ` and reached #${fmtScore(entry.rank)}` : ''}.`,
      run.bestCombo >= 2 ? `Best combo ×${run.bestCombo}.` : '',
    ]
      .filter(Boolean)
      .join(' ')
    const message = `${summary}\nCan you beat me? 🎨`
    const link = `${window.location.origin}${window.location.pathname}?s=${score}`
    const file = new File([art.blob], fileName, { type: 'image/png' })
    const isCancel = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

    try {
      if (navigator.canShare?.({ files: [file] })) {
        // Several share targets (WhatsApp, Messages) drop a separate url field when a file is attached,
        // so the link travels inside the text.
        await navigator.share({ files: [file], title: 'MONDRIAN', text: `${message}\n${link}` })
        return
      }
    } catch (error) {
      if (isCancel(error)) return // fall through to text-only sharing on any real failure
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'MONDRIAN', text: message, url: link })
        return
      }
      await navigator.clipboard.writeText(`${message}\n${link}`)
      setToast('MESSAGE COPIED')
    } catch (error) {
      if (!isCancel(error)) setToast('COULD NOT SHARE')
    }
  }

  return (
    <section className="overlay" hidden={hidden}>
      <div className="panel panel--result">
        <div className="cell cell--score">
          {entry ? (
            <p className="rank">
              #{fmtScore(entry.rank)} <span>GLOBAL · {entry.name}</span>
            </p>
          ) : (
            <p className={run.isNewBest ? 'label label--new' : 'label'}>{run.isNewBest ? 'NEW BEST' : 'SCORE'}</p>
          )}
          <p className="score">{fmtScore(score)}</p>
          {status === 'unreachable' && <p className="toast toast--error">LEADERBOARD UNREACHABLE. TRY AGAIN.</p>}
          {status === 'rejected' && <p className="toast toast--error">THIS RUN COULD NOT BE VERIFIED.</p>}
          {toast !== '' && (
            <p className="toast" role="status">
              {toast}
            </p>
          )}
        </div>
        <div className="cell cell--best">
          BEST<b>{fmtScore(run.best)}</b>
        </div>
        <div className="cell cell--combo">
          COMBO<b>×{run.bestCombo}</b>
        </div>

        {art && (
          <div className="cell cell--art">
            <img className="art" src={art.url} alt="The composition created during this run" />
          </div>
        )}

        <aside className="cell cell--board">
          <h2>GLOBAL TOP 10</h2>
          <BoardList refreshKey={entry?.id ?? 0} compact />
        </aside>

        <div className="actions">
          {entry === null && (
            <form
              className="entry"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.repeat && e.preventDefault()} // a movement key still held from the run must not type
                placeholder="YOUR NAME"
                aria-label="Your name for the leaderboard"
                maxLength={12}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="send"
                autoFocus={!isTouch()}
              />
              <button type="submit" disabled={name.trim() === '' || status === 'sending'}>
                {status === 'sending' ? 'SENDING…' : 'SUBMIT SCORE'}
              </button>
            </form>
          )}
          {canShare && art && (
            <>
              <a className="button button--secondary" href={art.url} download={fileName}>
                SAVE ARTWORK
              </a>
              <button type="button" className="button--secondary" onClick={share}>
                SHARE
              </button>
            </>
          )}
          <button
            key={entry ? 'again-submitted' : 'again'}
            type="button"
            className={entry ? undefined : 'button--secondary'}
            onClick={onPlayAgain}
            autoFocus={entry !== null}
          >
            PLAY AGAIN
          </button>
        </div>
      </div>
    </section>
  )
}
