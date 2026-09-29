// Leaderboard API. The server is the source of truth: it never trusts a client-stated score.
//
//   POST /api/sessions                                  -> {sid}      (timestamps a run as it starts)
//   POST /api/scores  {sid, name, width, start, landings, time, maxY} -> {entry, token}
//   PUT  /api/runs/:id/art      PNG body, header x-token -> 204       (artwork for that run)
//   GET  /api/runs/:id.png                               -> PNG
//   GET  /api/leaderboard?limit=10&id=N                  -> {top, me}
//
// A submission carries the run's landing log. verifyRun (shared with the game) replays it against
// the jump physics, the scroll speed and the combo rules, and the score stored is the one the log
// earns. Each session can be submitted once, and its run can't be longer than the wall-clock time
// since it began.
//
// ponytail: this stops DevTools/localStorage edits and forged numbers, not a bot that plays the game
// legitimately. Add per-IP rate limits and stronger replay checks if that ever matters.

import type { Database } from 'bun:sqlite'
import { type LandingRecord, type RunClaim, verifyRun } from '../src/game/rules'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // a saved run can be resumed for a week
const MAX_ART_BYTES = 2_000_000
const NAME_LENGTH = 12
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

interface Row {
  id: number
  name: string
  score: number
  best_combo: number
  created_at: string
}

interface Submission extends RunClaim {
  sid: string
  name: string
}

export const createApp = (db: Database, now: () => number = Date.now) => {
  db.run(`create table if not exists runs (
    id integer primary key autoincrement,
    name text not null,
    score integer not null,
    best_combo integer not null,
    time_s integer not null,
    token text not null,
    art blob,
    created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
  db.run('create index if not exists runs_rank on runs (score desc, id asc)')
  db.run(`create table if not exists sessions (
    sid text primary key,
    created_at integer not null,
    used integer not null default 0
  )`)

  const insert = db.query<{ id: number; created_at: string }, [string, number, number, number, string]>(
    'insert into runs (name, score, best_combo, time_s, token) values (?1, ?2, ?3, ?4, ?5) returning id, created_at',
  )
  const openSession = db.query<{ created_at: number; used: number }, [string]>(
    'select created_at, used from sessions where sid = ?1',
  )
  const consume = db.query<null, [string]>('update sessions set used = 1 where sid = ?1 and used = 0')
  const byId = db.query<Row, [number]>('select id, name, score, best_combo, created_at from runs where id = ?1')
  const top = db.query<Row, [number]>(
    'select id, name, score, best_combo, created_at from runs order by score desc, id asc limit ?1',
  )
  // Ties go to whoever got there first.
  const rankOf = db.query<{ rank: number }, [number, number]>(
    'select count(*) + 1 as rank from runs where score > ?1 or (score = ?1 and id < ?2)',
  )
  const artOf = db.query<{ art: Uint8Array | null }, [number]>('select art from runs where id = ?1')

  const entryFor = (row: Row) => ({
    id: row.id,
    rank: rankOf.get(row.score, row.id)?.rank ?? 0,
    name: row.name,
    score: row.score,
    bestCombo: row.best_combo,
    createdAt: row.created_at,
  })

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/')) return null

    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const sid = crypto.randomUUID()
      db.run('delete from sessions where created_at < ?1', [now() - SESSION_TTL_MS])
      db.run('insert into sessions (sid, created_at) values (?1, ?2)', [sid, now()])
      return json({ sid }, 201)
    }

    if (url.pathname === '/api/scores' && req.method === 'POST') {
      const submission = parseSubmission(await req.json().catch(() => null))
      if (!submission) return json({ error: 'malformed submission' }, 400)
      const session = openSession.get(submission.sid)
      if (!session) return json({ error: 'unknown session' }, 400)
      if (session.used) return json({ error: 'this run was already submitted' }, 409)
      const elapsed = (now() - session.created_at) / 1000
      if (elapsed * 1000 > SESSION_TTL_MS) return json({ error: 'session expired' }, 400)
      const verdict = verifyRun(submission, elapsed)
      if (!verdict.ok) return json({ error: `run rejected: ${verdict.reason}` }, 422)

      const token = crypto.randomUUID()
      const row = db.transaction(() => {
        if (consume.run(submission.sid).changes === 0) return null // lost a race with a duplicate
        const inserted = insert.get(submission.name, verdict.score, verdict.bestCombo, Math.floor(submission.time), token)
        return inserted && byId.get(inserted.id)
      })()
      if (!row) return json({ error: 'this run was already submitted' }, 409)
      return json({ entry: entryFor(row), token }, 201)
    }

    if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 50, 10)
      const meId = clampInt(url.searchParams.get('id'), 0, Number.MAX_SAFE_INTEGER, 0)
      const me = meId > 0 ? byId.get(meId) : null
      return json({ top: top.all(limit).map(entryFor), me: me ? entryFor(me) : null })
    }

    const art = url.pathname.match(/^\/api\/runs\/(\d+)(\/art|\.png)$/)
    if (art) {
      const id = Number(art[1])
      if (art[2] === '.png' && req.method === 'GET') {
        const stored = artOf.get(id)?.art
        if (!stored) return json({ error: 'no artwork' }, 404)
        return new Response(stored, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' } })
      }
      if (art[2] === '/art' && req.method === 'PUT') {
        const bytes = new Uint8Array(await req.arrayBuffer())
        if (bytes.length === 0 || bytes.length > MAX_ART_BYTES || !PNG_MAGIC.every((b, i) => bytes[i] === b)) {
          return json({ error: 'expected a PNG under 2 MB' }, 400)
        }
        const result = db.run('update runs set art = ?1 where id = ?2 and token = ?3', [
          bytes,
          id,
          req.headers.get('x-token') ?? '',
        ])
        return result.changes === 0 ? json({ error: 'wrong run or token' }, 403) : new Response(null, { status: 204 })
      }
    }

    return json({ error: 'not found' }, 404)
  }
}

const parseSubmission = (body: unknown): Submission | null => {
  if (typeof body !== 'object' || body === null) return null
  if (!('sid' in body && 'name' in body && 'width' in body && 'start' in body)) return null
  if (!('landings' in body && 'time' in body && 'maxY' in body)) return null
  const { sid, name, width, start, landings, time, maxY } = body
  const cleaned = cleanName(name)
  if (typeof sid !== 'string' || sid.length > 64 || cleaned === null) return null
  if (typeof width !== 'number' || typeof start !== 'number' || typeof time !== 'number' || typeof maxY !== 'number') return null
  if (!Array.isArray(landings) || landings.length > MAX_LANDINGS || !landings.every(isLanding)) return null
  return { sid, name: cleaned, width, start, landings, time, maxY }
}

const MAX_LANDINGS = 20_000

const isLanding = (value: unknown): value is LandingRecord =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number')

const cleanName = (value: unknown) => {
  if (typeof value !== 'string') return null
  const name = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim())
    .slice(0, NAME_LENGTH)
    .join('')
    .trim()
  return name === '' ? null : name
}

const clampInt = (raw: string | null, min: number, max: number, fallback: number) => {
  const n = Number(raw)
  return raw !== null && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const json = (data: unknown, status = 200) => Response.json(data, { status })
