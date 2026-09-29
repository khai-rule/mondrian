import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { hopTime } from '../src/game/physics'
import { type LandingRecord, round2, type RunClaim, verifyRun } from '../src/game/rules'
import { createApp } from './app.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

interface Entry {
  id: number
  rank: number
  name: string
  score: number
  bestCombo: number
}
interface Posted {
  entry: Entry
  token: string
}
interface BoardBody {
  top: Entry[]
  me: Entry | null
}

// JSON.parse yields any, so the expected shape can be declared without a cast.
const parse = async <T>(res: Response): Promise<T> => JSON.parse(await res.text())

// A physically valid run: `hops` climbing landings of 3 units each, a hair slower than the arc requires.
const validClaim = (hops: number): RunClaim => {
  const landings: LandingRecord[] = []
  let t = 0
  let top = 1
  let x = 4
  for (let i = 0; i < hops; i++) {
    t += hopTime(3) + 0.02
    top += 3
    x += i % 2 === 0 ? 0.3 : -0.3
    landings.push([round2(t), top, Math.round(x * 10) / 10])
  }
  return { width: 10, start: 1, landings, time: round2(t + 1), maxY: round2(top + 3.9) }
}

const setup = () => {
  let clock = 1_000_000_000
  const app = createApp(new Database(':memory:'), () => clock)
  const call = async (path: string, init?: RequestInit) => {
    const res = await app(new Request(`http://x${path}`, init))
    if (!res) throw new Error('unhandled route')
    return res
  }
  const newSession = async () => (await parse<{ sid: string }>(await call('/api/sessions', { method: 'POST' }))).sid
  const send = (payload: unknown) =>
    call('/api/scores', { method: 'POST', body: JSON.stringify(payload) })
  // Plays a run: opens a session, lets `wallSeconds` pass, submits.
  const play = async (name: unknown, claim: RunClaim, wallSeconds = claim.time + 1, extra: object = {}) => {
    const sid = await newSession()
    clock += wallSeconds * 1000
    const res = await send({ sid, name, ...claim, ...extra })
    return { res, sid, body: await parse<Posted>(res) }
  }
  return { app, call, play, send, newSession, advance: (s: number) => (clock += s * 1000) }
}

describe('leaderboard api', () => {
  it('ranks by the score the run log earns, breaks ties by arrival, returns top list and me', async () => {
    const { call, play } = setup()
    const a = await play('Ana', validClaim(8))
    const b = await play('Ben', validClaim(14))
    const c = await play('Cy', validClaim(8))
    expect(a.res.status).toBe(201)
    expect(a.body.entry.rank).toBe(1)
    expect(b.body.entry.rank).toBe(1)
    expect(c.body.entry.rank).toBe(3)

    const board = await parse<BoardBody>(await call(`/api/leaderboard?limit=2&id=${c.body.entry.id}`))
    expect(board.top.map((e) => e.name)).toEqual(['Ben', 'Ana'])
    expect(board.me?.rank).toBe(3)
    expect((await parse<BoardBody>(await call('/api/leaderboard'))).me).toBeNull()
  })

  it('stores the score the log earns and ignores any score the client claims', async () => {
    const { play } = setup()
    const claim = validClaim(10)
    const verdict = verifyRun(claim, 999)
    const honest = await play('Ana', claim)
    const boasting = await play('Ben', claim, claim.time + 1, { score: 999_999_999, bestCombo: 9999 })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(honest.body.entry.score).toBe(verdict.score)
    expect(boasting.body.entry.score).toBe(verdict.score)
    expect(boasting.body.entry.bestCombo).toBe(verdict.bestCombo)
  })

  it('rejects runs that break the rules of the game', async () => {
    const { play, send, newSession, advance } = setup()
    const base = validClaim(10)
    const withLanding = (i: number, patch: Partial<Record<0 | 1 | 2, number>>): RunClaim => ({
      ...base,
      landings: base.landings.map((l, j): LandingRecord =>
        j === i ? [patch[0] ?? l[0], patch[1] ?? l[1], patch[2] ?? l[2]] : l,
      ),
    })
    const cases: [string, RunClaim, number?][] = [
      ['too fast a hop', withLanding(4, { 0: base.landings[3][0] + 0.3 })],
      ['impossibly high jump', withLanding(4, { 1: base.landings[3][1] + 6 })],
      ['teleporting sideways', { ...withLanding(4, { 2: 20 }), width: 40 }],
      ['landing off screen', withLanding(4, { 2: 40 })],
      ['a lie about height', { ...base, maxY: base.maxY + 50 }],
      ['longer than the real session lasted', base, 5],
      ['a run that never ends', { ...base, time: base.time + 60 }],
      ['fake tall start', { ...base, start: 30 }],
      ['no landings and a long time', { ...base, landings: [], maxY: 3 }],
    ]
    for (const [label, claim, wall] of cases) {
      const { res } = await play('Ana', claim, wall ?? claim.time + 61)
      expect(res.status, label).toBe(422)
    }

    const sid = await newSession()
    advance(100)
    for (const bad of [
      { sid, name: ' ', ...base },
      { sid, name: 42, ...base },
      { sid, name: 'Ok', ...base, landings: 'x' },
      { sid, name: 'Ok', ...base, time: '30' },
      { sid: 'no-such-session', name: 'Ok', ...base },
      { name: 'Ok', ...base },
    ]) {
      expect((await send(bad)).status).toBe(400)
    }
  })

  it('accepts each session once: replays are refused', async () => {
    const { play, send } = setup()
    const claim = validClaim(8)
    const first = await play('Ana', claim)
    expect(first.res.status).toBe(201)
    const replay = await send({ sid: first.sid, name: 'Ana', ...claim })
    expect(replay.status).toBe(409)
  })

  it('cleans names', async () => {
    const { play } = setup()
    const ok = await play('  Khai \u0000  the   Great and Terrible  ', validClaim(6))
    expect(ok.res.status).toBe(201)
    expect(ok.body.entry.name).toBe('Khai the Gre')
  })

  it('stores artwork only for the token holder and only PNGs', async () => {
    const { call, play } = setup()
    const { body } = await play('Ana', validClaim(6))
    const put = (token: string, data: Uint8Array) =>
      call(`/api/runs/${body.entry.id}/art`, { method: 'PUT', headers: { 'x-token': token }, body: data })

    expect((await call(`/api/runs/${body.entry.id}.png`)).status).toBe(404)
    expect((await put('wrong', PNG)).status).toBe(403)
    expect((await put(body.token, new Uint8Array([1, 2, 3]))).status).toBe(400)
    expect((await put(body.token, PNG)).status).toBe(204)

    const art = await call(`/api/runs/${body.entry.id}.png`)
    expect(art.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await art.arrayBuffer())).toEqual(PNG)
  })

  it('ignores non-api routes', async () => {
    const { app } = setup()
    expect(await app(new Request('http://x/index.html'))).toBeNull()
  })
})
