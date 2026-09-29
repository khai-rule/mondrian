import type { LandingRecord } from './rules'

export interface Entry {
  id: number
  rank: number
  name: string
  score: number
  bestCombo: number
  createdAt: string
}

export interface Submission {
  entry: Entry
  token: string // proves ownership of the run, needed to attach its artwork
}

export interface Board {
  top: Entry[]
  me: Entry | null
}

// What the server needs to verify a run and work out its score itself.
export interface NewScore {
  sid: string
  name: string
  width: number
  start: number
  landings: LandingRecord[]
  time: number
  maxY: number
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// A session timestamps the run on the server the moment it starts.
export const startSession = async (): Promise<string> => {
  const res = await fetch('/api/sessions', { method: 'POST' })
  if (!res.ok) throw new ApiError(res.status, 'could not start a session')
  const body: { sid: string } = await res.json()
  return body.sid
}

export const submitScore = async (score: NewScore): Promise<Submission> => {
  const res = await fetch('/api/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(score),
  })
  if (!res.ok) throw new ApiError(res.status, `score submission failed (${res.status})`)
  return res.json()
}

// Best effort: the score is already saved, the picture is a bonus.
export const uploadArtwork = async (submission: Submission, art: Blob) => {
  try {
    await fetch(`/api/runs/${submission.entry.id}/art`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-token': submission.token },
      body: art,
    })
  } catch {
    // offline or server error: the leaderboard entry stands without its image
  }
}

export const fetchBoard = async (myId: number): Promise<Board> => {
  const res = await fetch(`/api/leaderboard?limit=10&id=${myId}`)
  if (!res.ok) throw new Error(`leaderboard failed (${res.status})`)
  return res.json()
}
