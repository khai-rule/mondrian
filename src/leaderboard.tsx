import { useEffect, useState } from 'react'
import { type Board, type Entry, fetchBoard } from '@/game/api'
import { fmtScore } from '@/game/artwork'
import { getMyEntry } from '@/game/storage'

interface Props {
  onBack: () => void
}

// `refreshKey` reloads the board, e.g. after this run's score is submitted.
export const BoardList = ({ refreshKey = 0, compact = false }: { refreshKey?: number; compact?: boolean }) => {
  const [board, setBoard] = useState<Board | 'loading' | 'offline'>('loading')

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only exists to retrigger the load
  useEffect(() => {
    let isCurrent = true
    const load = async () => {
      try {
        const loaded = await fetchBoard(getMyEntry()?.id ?? 0)
        if (isCurrent) setBoard(loaded)
      } catch {
        if (isCurrent) setBoard('offline')
      }
    }
    void load()
    return () => {
      isCurrent = false
    }
  }, [refreshKey])

  if (board === 'loading') return <p className="hint">LOADING…</p>
  if (board === 'offline') return <p className="hint">LEADERBOARD OFFLINE</p>
  return <Rows board={board} compact={compact} />
}

export const LeaderboardPanel = ({ onBack }: Props) => {

  return (
    <section className="overlay">
      <div className="panel">
        <h2>GLOBAL TOP 10</h2>
        <BoardList />
        <button type="button" onClick={onBack} autoFocus>
          BACK
        </button>
      </div>
    </section>
  )
}

const Rows = ({ board, compact }: { board: Board; compact: boolean }) => {
  if (board.top.length === 0) return <p className="hint">NO SCORES YET. BE THE FIRST.</p>
  const meOutside = board.me !== null && !board.top.some((entry) => entry.id === board.me?.id)
  return (
    <ol className={compact ? 'board board--compact' : 'board'}>
      {board.top.map((entry) => (
        <Row key={entry.id} entry={entry} isMe={entry.id === board.me?.id} />
      ))}
      {board.me && meOutside && (
        <>
          <li className="board__gap" aria-hidden="true">
            ···
          </li>
          <Row entry={board.me} isMe />
        </>
      )}
    </ol>
  )
}

const Row = ({ entry, isMe }: { entry: Entry; isMe: boolean }) => (
  <li className={isMe ? 'board__me' : undefined}>
    <span className="board__rank">{String(entry.rank).padStart(2, '0')}</span>
    <span className="board__name">{entry.name}</span>
    <span className="board__score">{fmtScore(entry.score)}</span>
  </li>
)
