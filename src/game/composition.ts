// Procedural Mondrian-inspired composition. World units are integers on a grid; y grows upward.
// Coloured cells are the platforms, white cells are negative space.
//
// Generation is route-first. Each chunk continues the guaranteed route from where the previous
// chunk left off, using the real jump physics for every step, paced against the world's scroll
// speed at that altitude (see PACING below), then adds optional platforms that
// are also reachable, and only then builds the layered composition (MACRO fields → MEDIUM
// subdivisions → MICRO detail) around those platforms. Decorative cells are pass-through, so
// nothing generated afterwards can invalidate the route.
//
// MOVING THINGS. A sliding platform is accepted only if the planner can steer to it at every position
// it swings through (and from anywhere on the previous platform's whole sweep), so its guarantee
// doesn't depend on timing. An obstacle patrols the screen all the time, moving as it scrolls into
// view; it is accepted only if the hops it crosses have a way past on the timeline of a player
// following the route, with some give either side. Anything that fails a check is replaced by a
// static platform or dropped, so the route never depends on luck.

import { type Motion, type Obstacle, obstacleX, offsetAt } from './motion'
import { hopFeasible, planHop, sampleRange } from './planner'
import { APEX_TIME, CAMERA_FOLLOW, MOVE_SPEED, hopProfile, hopSeconds, horizontalReach, JUMP_APEX, MAX_GAP, PLAYER_H, PLAYER_W, scrollSpeedAt, STEP, VISIBLE_H } from './physics'
import { RULES, type StageRules, stageAt } from './stages'

export type Hue = 'white' | 'red' | 'yellow' | 'blue'

export interface Cell {
  x: number
  y: number // bottom edge
  w: number
  h: number
  hue: Hue
  hitAt: number // game time of the last landing, -1 = never
  motion?: Motion // a sliding platform: x is the centre of its swing
  rail?: boolean // the white slot a sliding platform swings in: never coloured
}

export interface Chunk {
  y0: number
  y1: number
  cells: Cell[] // tiles the chunk exactly
  movers: Cell[] // sliding platforms, drawn and landed on over the cells
  obstacles: Obstacle[]
  route: Cell[] // the guaranteed platforms, bottom to top (static cells or movers)
}

export interface Generator {
  width: number
  nextY: number
  rngBox: { s: number } // mulberry32 state, a plain number so a run can be saved and resumed exactly
  rng: () => number
  last: Platform & { top: number } // last route platform: its horizontal extent and landing height
  before: Span | null // the route platform before that, so the route can't settle into one column
  routeT: number | null // when a player following the route exactly would land on `last`; only used to line sliders up, never to judge safety
  moverRun: number // consecutive sliding route platforms so far
  moverSign: number // direction (±1) the last slider was moving at its landing time
  lastHue: Hue
  side: -1 | 1 // direction the route is currently wandering
  slack: number // worst-case units between a perfect climber's feet and the bottom of the screen
}

export const CHUNK_H = 24

// PACING. Hopping by `gap` units takes hopTime(gap) seconds, during which the screen scrolls
// speed × hopTime units. A step therefore changes the climber's slack by gap − speed × hopTime.
// The camera also gets pulled up after a high jump (see FOLLOW_SLACK), which caps how much slack a
// hop can leave: a gap-1 hop at full speed leaves under 3 units however much there was before.
// The generator tracks slack along the route with both effects and only picks gaps that keep it
// above MIN_SLACK, planning against SPEED_MARGIN × the true speed. MAX_GAP always nets positive even
// at the speed ceiling (checked in the tests), so a sustainable step always exists, at every speed.
const START_SLACK = 2 // the player spawns 2..4 units above the screen bottom
const MIN_SHIFT = 1.5 // consecutive route platforms differ by at least this much (centre to centre)
const START_SPACING = 0.5 // where on the previous platform the player might land, sampled this finely
const MIN_SLACK = 2
const FOLLOW_SLACK = VISIBLE_H * CAMERA_FOLLOW - JUMP_APEX // slack left at a jump's apex once the camera has followed
const SPEED_MARGIN = 1.15
const COLOUR_BUDGET = 0.32 // max share of a chunk's area that may be coloured (platforms exempt)

export const isPlatform = (cell: Cell) => cell.hue !== 'white'
export const top = (cell: Cell) => cell.y + cell.h

// Left edge of a cell at a moment in time (sliding platforms move; everything else doesn't).
export const cellX = (cell: Cell, t: number) => (cell.motion ? cell.x + offsetAt(cell.motion, t) : cell.x)

export interface GeneratorState {
  width: number
  nextY: number
  rngState: number
  last: Platform & { top: number }
  before: Span | null
  routeT: number | null
  moverRun: number
  moverSign: number
  lastHue: Hue
  side: -1 | 1
  slack: number
}

export const createGenerator = (width: number, seed = Math.floor(Math.random() * 2 ** 32)): Generator =>
  restoreGenerator({
    width,
    nextY: 0,
    rngState: seed | 0,
    last: { x: Math.max(0, Math.floor(width / 2) - 1), w: 2, top: 0 },
    before: null,
    routeT: null,
    moverRun: 0,
    moverSign: 0,
    lastHue: 'white',
    side: 1,
    slack: START_SLACK,
  })

export const restoreGenerator = (state: GeneratorState): Generator => {
  const rngBox = { s: state.rngState }
  return { ...state, last: { ...state.last }, before: state.before && { ...state.before }, rngBox, rng: mulberry32(rngBox) }
}

export const snapshotGenerator = (g: Generator): GeneratorState => ({
  width: g.width,
  nextY: g.nextY,
  rngState: g.rngBox.s,
  last: { ...g.last },
  before: g.before && { ...g.before },
  routeT: g.routeT,
  moverRun: g.moverRun,
  moverSign: g.moverSign,
  lastHue: g.lastHue,
  side: g.side,
  slack: g.slack,
})

export const generateChunk = (g: Generator, difficulty: number): Chunk => {
  const d = clamp(difficulty, 0, 1)
  const y0 = g.nextY
  const y1 = y0 + CHUNK_H
  const rules = RULES[stageAt(y0 + CHUNK_H / 2)]
  // A narrow screen leaves little room to dodge round anything, so it gets fewer obstacles.
  const wantsObstacle = g.rng() < rules.obstacleChance * clamp(g.width / 12, 0.6, 1)
  const moversAllowed = !(wantsObstacle && rules.obstacleChunksStatic)
  const laid = layRoute(g, d, y0, y1, moversAllowed)
  const routeRects = laid.rects
  const optionalRects = optionalPlatforms(g, d, routeRects, y0, y1)
  const cells = macroFields(g, y0)
  refine(g, cells, d)
  const platforms = [...routeRects, ...optionalRects]
  const route: Cell[] = []
  const movers: Cell[] = []
  for (const rect of routeRects) {
    if (!rect.motion) {
      route.push(imprint(g, cells, snap(cells, platforms, rect)))
      continue
    }
    carve(cells, hull(rect)).push({ ...hull(rect), hue: 'white', hitAt: -1, rail: true })
    const mover: Cell = { ...rect, hue: pickHue(g), hitAt: -1 }
    movers.push(mover)
    route.push(mover)
  }
  const optional = optionalRects.map((r) => imprint(g, cells, snap(cells, platforms, r)))
  colourFields(g, cells, d)
  enforceBudget(cells, new Set([...route, ...optional]))
  pruneDeadEnds(cells, new Set(route))
  const obstacles: Obstacle[] = []
  // A second flyer, far enough above or below the first that no jump can meet both: each is proved
  // dodgeable on its own, and two together could not be.
  for (let n = 0; n < MAX_OBSTACLES && (n === 0 ? wantsObstacle : g.rng() < rules.obstacleChance); n++) {
    const found = planObstacleRetrying(g, rules, laid.hops, route, obstacles, y0, y1)
    if (!found) break
    obstacles.push(found)
    clearAirspace(cells, route, found)
  }
  if (obstacles.length > 0) pruneDeadEnds(cells, new Set(route)) // clearing airspace can strand a block that led only to a cleared one
  g.nextY = y1
  return {
    y0,
    y1,
    cells,
    movers,
    obstacles,
    route,
  }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
  motion?: Motion
}

// A platform for planning purposes: where it sits and how (if at all) it slides.
export interface Platform {
  x: number
  w: number
  motion?: Motion
}

interface Hop {
  launchT: number // when a player following the route exactly leaves `from`
  launchTop: number
  gap: number
  from: Platform
  to: Platform
}

// The whole strip a sliding platform sweeps, rounded out to the composition's grid: the white slot
// it swings in.
const hull = (r: Rect): Rect => {
  if (!r.motion) return r
  const left = Math.floor(r.x - r.motion.amp + 1e-9)
  const right = Math.ceil(r.x + r.w + r.motion.amp - 1e-9)
  return { ...r, x: left, w: right - left }
}

const centres = ([a, b]: [number, number], margin: number): [number, number] => [a + margin, b - margin]

// Everywhere a platform's left edge can be: one place, or all along its sweep.
const positions = (p: Platform) => (p.motion ? [-p.motion.amp, 0, p.motion.amp] : [0]).map((offset) => p.x + offset)

// Can a player leaving `from` reach `to`, from wherever they landed and however they were moving,
// whatever moment it is? Two static platforms with nothing in the way use the plain reach model;
// otherwise the planner checks each place a slider can be, around any obstacle whose height the
// flight passes, at game time `launchT`.
interface HopOptions {
  launchT?: number // game time the player leaves `from`
  snapSlack?: number // room a static origin may have gained from snapping to the grid
  share?: number // the part of the origin (from its middle) that counts as somewhere they might land
  velocities?: readonly number[] // sideways speeds they might land with
}

// Obstacle hops guarantee a dodge for a player who lands sensibly: on the middle of the platform, at
// no more than half top speed sideways. (Guaranteeing it from every edge landing at full tilt leaves
// almost no obstacle that matters at all: it is a choice of landing, not something the world forces.)
const SENSIBLE: HopOptions = { snapSlack: 0, share: 0.6, velocities: [-MOVE_SPEED / 2, 0, MOVE_SPEED / 2] }

const hopOk = (g: Generator, hop: Hop, obstacles: Obstacle[], reach: number, options: HopOptions = {}) => {
  const { launchT = 0, snapSlack = 1, share = 1, velocities } = options
  const { from, to } = hop
  const hits = obstacles.filter((o) => touches(hop, o))
  if (!from.motion && !to.motion && hits.length === 0) return travel(from, to) <= reach
  // Where they might land: anywhere along a slider's sweep, or on a static platform including the unit
  // snapping may add to it.
  const slack = from.motion?.amp ?? snapSlack
  const half = ((from.w + 2 * slack) / 2) * share
  const middle = from.x + from.w / 2
  const starts = sampleRange(centres([middle - half, middle + half], 0.05), START_SPACING)
  return positions(to).every((x) =>
    hopFeasible(
      // the target is shrunk by half the sampling step, so states between the sampled ones are safe too
      {
        width: g.width,
        launchT,
        launchY: hop.launchTop,
        gap: hop.gap,
        target: () => centres([x, x + to.w], 0.15 + START_SPACING / 2),
        obstacles: hits,
      },
      starts,
      velocities,
    ),
  )
}

// ROUTE: every step is a vertical gap of 1..MAX_GAP and a horizontal trip that the physical reach
// allows even from the worst spot on the last platform (see travel), and
// the gap is paced so a perfect climber outruns the scroll. Difficulty pushes hops toward the
// limit and narrows platforms; it never exceeds the reach. A chunk ends when no sustainable gap
// still fits; the leftover (< MAX_GAP) is picked up by the next chunk.
const layRoute = (g: Generator, d: number, y0: number, y1: number, moversAllowed: boolean) => {
  const rects: Rect[] = []
  const hops: Hop[] = []
  for (;;) {
    const gap = nextGap(g, d, y0, y1)
    if (gap === null) return { rects, hops }
    const platformTop = g.last.top + gap
    const rules = RULES[stageAt(platformTop)]
    g.slack = slackAfter(g.slack, gap, scrollSpeedAt(g.last.top))
    const first = g.routeT === null
    const landT = first ? 0 : (g.routeT ?? 0) + hopSeconds(gap) // the first platform is where the run begins
    if (g.rng() < 0.3) g.side = g.side > 0 ? -1 : 1
    const wantsMover = !first && moversAllowed && g.moverRun < rules.maxMoverRun && g.rng() < rules.moverShare
    const reach = plannedReach(gap, d, 0.9)
    // narrow enough that the hop can clear the previous platform's width: forces sideways movement
    const fits = Math.max(1, Math.floor(reach - 0.2))
    const w = wantsMover ? 2 : Math.min(platformWidth(g, d), fits)
    const h = Math.min(gap, platformTop - y0, g.width > 10 ? weightedPick(g.rng, [1, 2, 3], (h) => [0.55, 0.3, 0.15][h - 1]) : 1)
    const hopTo = (to: Platform): Hop => ({ launchT: g.routeT ?? 0, launchTop: g.last.top, gap, from: g.last, to })
    const feasible = (to: Platform) => hopOk(g, hopTo(to), [], reach)

    const xs = candidateXs(g, w, reach)
    let choice: { x: number; motion?: Motion } | null = null
    if (wantsMover) {
      search: for (const x of xs) {
        const motion = pickMotion(g, rules, landT, x, w)
        // a slide that is too long to catch is shortened until it can be, rather than dropped
        for (let shrink = 1; motion && shrink > 0.4; shrink -= 0.2) {
          const slide = { ...motion, amp: motion.amp * shrink }
          if (slide.amp >= 0.8 && feasible({ x, w, motion: slide })) {
            choice = { x, motion: slide }
            break search
          }
        }
      }
    }
    if (!choice) {
      const x = first ? xs[0] : xs.find((candidate) => feasible({ x: candidate, w }))
      if (x !== undefined) choice = { x }
    }
    // Nothing fit: stack directly over the last platform's centre, which always works.
    choice ??= { x: clamp(Math.round(g.last.x + g.last.w / 2 - w / 2), 0, g.width - w) }

    const platform: Platform = { x: choice.x, w, motion: choice.motion }
    if (!first) hops.push(hopTo(platform))
    rects.push({ x: choice.x, y: platformTop - h, w, h, motion: choice.motion })
    g.before = { x: g.last.x, w: g.last.w }
    g.last = { ...platform, top: platformTop }
    g.routeT = landT
    g.moverRun = choice.motion ? g.moverRun + 1 : 0
  }
}

// A slide that fits its rail on the screen, at a speed and direction from the stage's rules. In
// stages where neighbours oppose, its direction at landing time is opposite the last slider's.
const pickMotion = (g: Generator, rules: StageRules, landT: number, x: number, w: number): Motion | null => {
  const room = Math.min(x, g.width - (x + w))
  const [ampMin, ampMax] = rules.amp
  const amp = Math.min(room, ampMin + g.rng() * (ampMax - ampMin))
  if (amp < 0.8) return null
  const speed = rules.speed[0] + g.rng() * (rules.speed[1] - rules.speed[0])
  const period = (2 * Math.PI * amp) / speed
  const theta =
    rules.opposing && g.moverSign !== 0
      ? (g.moverSign > 0 ? Math.PI : 0) + (g.rng() - 0.5) * Math.PI * 0.6
      : g.rng() * 2 * Math.PI
  g.moverSign = Math.sign(Math.cos(theta)) || 1
  return { amp, period, phase: theta - (2 * Math.PI * landT) / period }
}

// Where the next route platform could go, best first: spread out sideways so the route keeps
// wandering. Best is clear of the last platform altogether (the player must move to reach it), next
// is a column that the last three platforms don't all share, and then anything that is reachable.
const candidateXs = (g: Generator, w: number, reach: number) => {
  const other: -1 | 1 = g.side > 0 ? -1 : 1
  const tries: [-1 | 1, number][] = [
    [g.side, 0.55 + 0.45 * g.rng()],
    [other, 0.55 + 0.45 * g.rng()],
    [g.side, 1],
    [other, 1],
    [g.side, 0.8],
    [other, 0.8],
  ]
  const xs = [...new Set(tries.map(([side, share]) => placeAt(g, g.last, reach * share, w, reach, side)))]
  return xs.sort((a, b) => variety(g, { x: b, w }) - variety(g, { x: a, w }))
}

const centre = (s: Span) => s.x + s.w / 2

// 2 = clear of the last platform (moving is unavoidable), 1 = no column shared by the last three, 0 = neither.
const variety = (g: Generator, next: Span) => {
  if (Math.abs(centre(next) - centre(g.last)) >= (next.w + g.last.w) / 2 + 0.3) return 2
  if (Math.abs(centre(next) - centre(g.last)) < MIN_SHIFT) return 0
  if (!g.before) return 1
  const shared = Math.min(next.x + next.w, g.last.x + g.last.w, g.before.x + g.before.w) - Math.max(next.x, g.last.x, g.before.x)
  return shared < 0.5 ? 1 : 0
}

// Slack after a hop: what scrolling leaves, capped by where the camera ends up after following the jump.
const slackAfter = (slack: number, gap: number, speed: number) =>
  Math.min(slack + gap - speed * hopSeconds(gap), gap + FOLLOW_SLACK - speed * (hopSeconds(gap) - APEX_TIME))

const nextGap = (g: Generator, d: number, y0: number, y1: number): number | null => {
  const fits = [1, 2, 3].filter((gap) => gap <= MAX_GAP && g.last.top + gap >= y0 + 1 && g.last.top + gap <= y1)
  const speed = scrollSpeedAt(g.last.top) * SPEED_MARGIN
  const sustainable = fits.filter((gap) => slackAfter(g.slack, gap, speed) >= MIN_SLACK)
  if (sustainable.length > 0) {
    const weights = [lerp(0.6, 0.3, d), lerp(1.5, 1, d), lerp(1.5, 3, d)]
    return weightedPick(g.rng, sustainable, (gap) => weights[gap - 1])
  }
  return fits.includes(MAX_GAP) ? MAX_GAP : null
}

// OPTIONAL: extra platforms reachable from a route platform. Plentiful early (many easy
// alternatives), scarce late (the route narrows).
const optionalPlatforms = (g: Generator, d: number, route: Rect[], y0: number, y1: number): Rect[] => {
  const extras: Rect[] = []
  const count = Math.round(lerp(0.45, 0.12, d) * g.width)
  for (let i = 0; i < count; i++) {
    const base = route[Math.floor(g.rng() * route.length)]
    const baseTop = base.y + base.h
    if (baseTop >= y1) continue
    const gap = 1 + Math.floor(g.rng() * Math.min(MAX_GAP, y1 - baseTop))
    const w = 1 + Math.round(g.rng() * lerp(2, 1, d))
    const reach = plannedReach(gap, d, 0.95)
    const x = placeAt(g, base, reach * (0.3 + 0.7 * g.rng()), w, reach, g.rng() < 0.5 ? -1 : 1)
    const h = Math.min(gap, 1 + Math.round(g.rng()))
    const rect = { x, y: baseTop + gap - h, w, h }
    if (rect.y < y0 || [...route.map(hull), ...extras].some((other) => overlaps(other, rect))) continue
    extras.push(rect)
  }
  return extras
}

// OBSTACLES: a black form patrolling the screen at one height, always moving, so it is already in motion
// when it scrolls into view and can be read and anticipated. It is placed around the top of a jump on the
// route, so it has to be avoided sideways. It is only kept if it really crosses the straight path and every
// hop it can touch has a way past for a player following the route, with a little give in the timing either
// side (players don't land exactly on schedule) on the jump it is placed to threaten.
const OBSTACLE_W = 1.1
const OBSTACLE_H = 0.65
const PATROL_HALF = [4.5, 7] // half-length of the stretch it patrols, in units
const SAFE_REL = 3.7 // height of the obstacle's underside above any platform it can hover over
const MAX_OBSTACLES = 2
const OBSTACLE_SEPARATION = 7 // vertical distance between two flyers: more than a jump reaches, so none meets both
const OBSTACLE_RETRIES = 2
const SEARCH_ATTEMPTS = 60 // heights/speeds/directions to try; each is scanned across its whole cycle
const MOMENT_STEP = 0.1 // seconds between the moments of its patrol a dodge is proved for
const PHASE_STEP = 0.4 // seconds between the phases tried

// A placement search often finds nothing on the first try; fresh random picks usually do.
const planObstacleRetrying = (g: Generator, rules: StageRules, hops: Hop[], route: Cell[], taken: Obstacle[], y0: number, y1: number): Obstacle | null => {
  for (let attempt = 0; attempt < OBSTACLE_RETRIES; attempt++) {
    const found = planObstacle(g, rules, hops, route, taken, y0, y1)
    if (found) return found
  }
  return null
}

const planObstacle = (g: Generator, rules: StageRules, hops: Hop[], route: Cell[], taken: Obstacle[], y0: number, y1: number): Obstacle | null => {
  // The world is built by now, so judge the hops between the final platforms (snapped to the grid).
  const finalHops = hops.map((hop, j): Hop => ({
    ...hop,
    from: j === 0 ? hop.from : { x: route[j - 1].x, w: route[j - 1].w, motion: route[j - 1].motion },
    to: { x: route[j].x, w: route[j].w, motion: route[j].motion },
  }))
  const candidates = finalHops.flatMap((hop, j) => (!hop.from.motion && !hop.to.motion ? [j] : []))
  if (candidates.length === 0) return null
  for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt++) {
    const hop = finalHops[candidates[Math.floor(g.rng() * candidates.length)]]
    // Near the top of the jump. A player needs about 0.27 s to rise SAFE_REL above a platform, enough time to
    // sidestep, so even an obstacle directly overhead can be dodged. Clear of the chunk's edges, so hops that
    // start in another chunk (which this generator can't see) can't meet it.
    const y = Math.round((hop.launchTop + SAFE_REL + g.rng() * 0.6) * 4) / 4
    if (y < y0 + 4.2 || y + OBSTACLE_H > y1 - 4.4) continue
    if (taken.some((t) => Math.abs(t.y - y) < OBSTACLE_SEPARATION)) continue
    const flipped = g.rng() < 0.5
    // It patrols a stretch centred on the path this jump takes, not the whole screen width: a full-width
    // sweep is only near the player a small share of the time, which made it easy to ignore.
    // Its stretch ends short of the platform the jump lands on, so that platform is never overhung.
    const half = PATROL_HALF[0] + g.rng() * (PATROL_HALF[1] - PATROL_HALF[0])
    const towards = Math.sign(hop.to.x + hop.to.w / 2 - (hop.from.x + hop.from.w / 2)) || (g.rng() < 0.5 ? -1 : 1)
    const near = towards > 0 ? hop.to.x - 0.7 - OBSTACLE_W : hop.to.x + hop.to.w + 0.7
    const edge =
      towards > 0
        ? [Math.max(0, near - 2 * half), Math.min(near, g.width - OBSTACLE_W)]
        : [Math.max(near, 0), Math.min(near + 2 * half, g.width - OBSTACLE_W)]
    if (edge[1] - edge[0] < 2.5) continue
    if (route.some((p) => hoversOver(hull(p), y, edge))) continue
    const speed = rules.obstacleSpeed[0] + g.rng() * (rules.obstacleSpeed[1] - rules.obstacleSpeed[0])
    const length = edge[1] - edge[0]
    const cycle = (2 * length) / speed
    // Where it is when the player arrives is not up to the generator, so it must be dodgeable at EVERY moment
    // of its patrol, not only on the expected timeline. The offset only decides the expected timeline, which
    // is used to make sure the expected path really crosses it (a threat, not scenery).
    for (let offset = g.rng() * PHASE_STEP; offset < cycle; offset += PHASE_STEP) {
      const obstacle: Obstacle = { y, w: OBSTACLE_W, h: OBSTACLE_H, from: edge[flipped ? 1 : 0], to: edge[flipped ? 0 : 1], speed, offset }
      if (!crossesStraightPath(hop, obstacle)) continue
      const crossed = finalHops.filter((h) => touches(h, obstacle))
      // Moments are sampled, so plan against a flyer padded by the ground it covers between two samples: any
      // moment in between is then covered by the padding.
      const pad = (speed * MOMENT_STEP) / 4
      const padded: Obstacle = { ...obstacle, w: OBSTACLE_W + 2 * pad, from: obstacle.from - pad, to: obstacle.to - pad }
      const moments: number[] = []
      // coarse moments first, so a candidate that fails somewhere is rejected after a few checks
      for (const stride of [16, 8, 4, 2, 1]) {
        for (let k = 0; k * MOMENT_STEP < cycle; k++) if (k % stride === 0 && (stride === 16 || k % (stride * 2) !== 0)) moments.push(k * MOMENT_STEP)
      }
      // cheap first: someone in the middle of the platform, then the full set of sensible landings
      const middle = (h: Hop, shift: number) =>
        planHop({
          width: g.width,
          launchT: h.launchT + shift,
          launchY: h.launchTop,
          gap: h.gap,
          start: h.from.x + h.from.w / 2,
          target: () => centres([h.to.x, h.to.x + h.to.w], 0.4),
          obstacles: [padded],
        }) !== null
      const everyMoment = (check: (h: Hop, shift: number) => boolean) => moments.every((shift) => crossed.every((h) => check(h, shift)))
      if (!everyMoment(middle)) break
      // The guarantee: at any moment of its patrol, from anywhere in the middle of the platform, standing
      // still, a way past exists: from the middle of the platform for every jump it crosses, from the whole
      // middle stretch for the jump it is placed to threaten. (Landing while sliding fast the other way is
      // left to the player.)
      if (everyMoment((h, shift) => h !== hop || hopOk(g, h, [padded], 0, { ...SENSIBLE, velocities: [0], launchT: h.launchT + shift }))) return obstacle
      break
    }
  }
  return null
}

// No platform may sit where the obstacle could hover right above it (closer than SAFE_REL): a player
// landing there could not get out from under it in time. Platforms above it are no problem. Route
// platforms are never moved, so a placement that meets one is rejected; every other coloured block in
// that airspace is turned to paper (see clearAirspace).
const hoversOver = (p: Rect, y: number, edge: number[]) => {
  const lo = Math.min(...edge) - 0.1
  const hi = Math.max(...edge) + OBSTACLE_W + 0.1
  const t = p.y + p.h
  return p.x + p.w > lo && p.x < hi && t > y - SAFE_REL && t < y + OBSTACLE_H
}

const clearAirspace = (cells: Cell[], route: Cell[], o: Obstacle) => {
  const edge = [o.from, o.to]
  for (const cell of cells) {
    if (cell.hue !== 'white' && !route.includes(cell) && hoversOver(cell, o.y, edge)) cell.hue = 'white'
  }
}

// Would someone flying straight from the middle of one platform to the middle of the next hit it?
const crossesStraightPath = (hop: Hop, o: Obstacle) => {
  const { steps, y } = hopProfile(hop.gap)
  const start = hop.from.x + hop.from.w / 2
  const end = hop.to.x + hop.to.w / 2
  for (let s = 0; s <= steps; s++) {
    const feet = hop.launchTop + y[s]
    if (feet + PLAYER_H <= o.y || feet >= o.y + o.h) continue
    const x = start + ((end - start) * s) / steps
    const ox = obstacleX(o, hop.launchT + s * STEP)
    if (x + PLAYER_W / 2 > ox && x - PLAYER_W / 2 < ox + o.w) return true
  }
  return false
}

// Whether a hop's flight passes the obstacle's height (with room to spare).
const touches = (hop: Hop, o: Obstacle) => {
  const apex = Math.max(...hopProfile(hop.gap).y)
  return hop.launchTop < o.y + o.h + 0.5 && hop.launchTop + apex + PLAYER_H > o.y - 0.5
}

// TRAVEL: the player may land anywhere on a platform, so a hop must work from its worst spot: the
// longest horizontal trip from any point of `from` to the nearest point of `to`.
export interface Span {
  x: number
  w: number
}

export const travel = (from: Span, to: Span) => {
  const distance = (x: number) => Math.max(0, to.x - x, x - (to.x + to.w))
  return Math.max(distance(from.x), distance(from.x + from.w))
}

// Place a platform of width w about `distance` from the anchor on the given side (default: the side
// the route is wandering toward), then pull it toward the anchor until travel fits within `reach`.
// Centred over the anchor is the best spot there is, and the planned reach always allows it.
const placeAt = (g: Generator, from: Span, distance: number, w: number, reach: number, side = g.side) => {
  const wanted = side > 0 ? Math.floor(from.x + distance) : Math.ceil(from.x + from.w - distance - w)
  let x = clamp(wanted, 0, g.width - w)
  if (side === g.side && x !== wanted) g.side = g.side > 0 ? -1 : 1 // hit the edge: turn around
  for (let i = 0; i <= g.width && travel(from, { x, w }) > reach; i++) x += Math.sign(from.x + from.w / 2 - (x + w / 2))
  return x
}

// Reach the generator may plan with: physical reach scaled by difficulty (calm early), minus a unit
// for snapping, which can widen a platform by one on each side.
const plannedReach = (gap: number, d: number, safety: number) => Math.max(0, horizontalReach(gap) * safety - 1) * lerp(0.8, 1, d)

// Platforms stay narrow (never wider than 3) so that each hop has to move sideways: a wide bar would let a
// player stand in one column while the route stacks above them. They get narrower as difficulty rises.
const platformWidth = (g: Generator, d: number) => {
  if (d < 0.35) return 2 + Math.round(g.rng())
  if (d < 0.7) return 2 + Math.round(g.rng() * 0.7)
  return 1 + Math.round(g.rng())
}

// Widen a platform to a nearby field edge (≤ 1 unit) so imprinting leaves fewer slivers. Widening
// shifts the centre by at most half a unit, which plannedReach already allows for.
const snap = (cells: Cell[], platforms: Rect[], r: Rect): Rect => {
  const host = cells.find((c) => c.x <= r.x + r.w / 2 && r.x + r.w / 2 < c.x + c.w && c.y <= r.y && r.y < top(c))
  if (!host) return r
  const snapped = { ...r }
  if (r.x - host.x === 1) {
    snapped.x -= 1
    snapped.w += 1
  } else if (host.x + host.w - (r.x + r.w) === 1) snapped.w += 1
  return platforms.some((p) => p !== r && overlaps(hull(p), snapped)) ? r : snapped
}

// Cut a rectangle out of the composition: every overlapping cell is replaced by its remainder
// strips (above/below at full host width, left/right within the rectangle's band). Returns `cells`
// so the caller can add whatever now fills the hole.
const carve = (cells: Cell[], platform: Rect) => {
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]
    if (!overlaps(c, platform)) continue
    const bandBottom = Math.max(c.y, platform.y)
    const bandTop = Math.min(top(c), platform.y + platform.h)
    const pieces: Rect[] = []
    if (top(c) > bandTop) pieces.push({ x: c.x, y: bandTop, w: c.w, h: top(c) - bandTop })
    if (c.y < bandBottom) pieces.push({ x: c.x, y: c.y, w: c.w, h: bandBottom - c.y })
    if (c.x < platform.x) pieces.push({ x: c.x, y: bandBottom, w: platform.x - c.x, h: bandTop - bandBottom })
    const right = platform.x + platform.w
    if (c.x + c.w > right) pieces.push({ x: right, y: bandBottom, w: c.x + c.w - right, h: bandTop - bandBottom })
    cells.splice(i, 1, ...pieces.map(white))
  }
  return cells
}

// Cut a coloured platform into the composition.
const imprint = (g: Generator, cells: Cell[], platform: Rect): Cell => {
  const cell: Cell = { x: platform.x, y: platform.y, w: platform.w, h: platform.h, hue: pickHue(g), hitAt: -1 }
  carve(cells, platform).push(cell)
  return cell
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const white = (r: Rect): Cell => ({ ...r, hue: 'white', hitAt: -1 })

// MACRO: a few large columns, each cut into a few tall rows (or bands first, then columns),
// with asymmetric cuts so no two fields share proportions.
const macroFields = (g: Generator, y0: number): Cell[] => {
  const { rng, width } = g
  const columns = width <= 8 ? 1 + Math.round(rng()) : width <= 14 ? 2 + Math.round(rng()) : 3 + Math.floor(rng() * 3)
  const out: Cell[] = []
  if (rng() < 0.35) {
    for (const [by, bh] of segments(rng, y0, CHUNK_H, 2 + Math.round(rng()), 4)) {
      const cols = Math.max(1, columns - Math.round(rng()))
      for (const [cx, cw] of segments(rng, 0, width, cols, 2)) out.push(white({ x: cx, y: by, w: cw, h: bh }))
    }
    return out
  }
  for (const [cx, cw] of segments(rng, 0, width, columns, 2)) {
    for (const [ry, rh] of segments(rng, y0, CHUNK_H, 2 + Math.floor(rng() * 3), 3)) out.push(white({ x: cx, y: ry, w: cw, h: rh }))
  }
  return out
}

// MEDIUM + MICRO: subdivide some fields once or twice, and occasionally give a piece fine detail.
// Both get more frequent with difficulty: calm early, busier later.
const refine = (g: Generator, cells: Cell[], d: number) => {
  const mediumChance = 0.35 + 0.35 * d
  const microChance = 0.08 + 0.3 * d
  for (let i = cells.length - 1; i >= 0; i--) {
    const field = cells[i]
    if (field.w < 3 || field.h < 3 || g.rng() > mediumChance) continue
    const pieces = guillotine(g.rng, field, 1 + Math.round(g.rng()), 2)
    const refined = pieces.flatMap((piece) =>
      piece.w >= 2 && piece.h >= 2 && piece.w * piece.h <= 24 && g.rng() < microChance ? micro(g.rng, piece) : [piece],
    )
    cells.splice(i, 1, ...refined.map(white))
  }
}

const micro = (rng: () => number, r: Rect): Rect[] => {
  const mustSplit = r.w > 3 || r.h > 3
  if ((r.w < 2 && r.h < 2) || (!mustSplit && rng() < 0.5)) return [r]
  const vertical = r.h < 2 || (r.w >= 2 && (r.w > r.h || (r.w === r.h && rng() < 0.5)))
  return guillotine(rng, r, 1, 1, vertical).flatMap((piece) => micro(rng, piece))
}

// Decorative colour: at most one monumental block, some medium fields, a few small accents.
// (Coloured decor is landable too, which only ever adds options.)
const colourFields = (g: Generator, cells: Cell[], d: number) => {
  const total = g.width * CHUNK_H
  const large = cells.filter((c) => !isPlatform(c) && !c.rail && c.w * c.h >= 15 && c.w * c.h <= total * 0.22)
  if (large.length > 0 && g.rng() < 0.6) large[Math.floor(g.rng() * large.length)].hue = pickHue(g)
  for (const cell of cells) {
    if (isPlatform(cell) || cell.rail) continue
    const area = cell.w * cell.h
    const chance = area >= 15 ? 0 : area >= 4 ? 0.2 : 0.25 - 0.1 * d
    if (g.rng() < chance) cell.hue = pickHue(g)
  }
}

// Every coloured cell is landable, so every one must lead somewhere: uncolour any non-route cell
// with no coloured cell within physical reach above it. Repeats until stable (cascading dead ends).
// NOTE: judged within the chunk only, so a non-route cell topping out at the chunk edge is pruned.
const pruneDeadEnds = (cells: Cell[], route: Set<Cell>) => {
  for (;;) {
    const platforms = cells.filter(isPlatform)
    const deadEnds = platforms.filter((cell) => !route.has(cell) && !platforms.some((next) => continues(cell, next)))
    if (deadEnds.length === 0) return
    for (const cell of deadEnds) cell.hue = 'white'
  }
}

const continues = (from: Cell, to: Cell) => {
  const gap = top(to) - top(from)
  if (gap < 1 || gap > MAX_GAP) return false
  return travel(from, to) <= horizontalReach(gap) * 0.95
}

// Uncolour the largest decorative blocks until white dominates again.
const enforceBudget = (cells: Cell[], platforms: Set<Cell>) => {
  const total = cells.reduce((sum, c) => sum + c.w * c.h, 0)
  let coloured = cells.filter(isPlatform).reduce((sum, c) => sum + c.w * c.h, 0)
  const spare = cells.filter((c) => isPlatform(c) && !platforms.has(c)).sort((a, b) => b.w * b.h - a.w * a.h)
  for (const cell of spare) {
    if (coloured <= total * COLOUR_BUDGET) return
    cell.hue = 'white'
    coloured -= cell.w * cell.h
  }
}

// Split a length into `parts` segments of at least `min`, with off-centre cuts. Returns [start, size].
const segments = (rng: () => number, start: number, length: number, parts: number, min: number): [number, number][] => {
  const count = Math.max(1, Math.min(parts, Math.floor(length / min)))
  const cuts: number[] = []
  let at = start
  let remaining = count
  let left = length
  while (remaining > 1) {
    const room = left - min * remaining
    const size = min + Math.round(room * offCentre(rng))
    cuts.push(at)
    at += size
    left -= size
    remaining--
  }
  cuts.push(at)
  return cuts.map((c, i) => [c, (cuts[i + 1] ?? start + length) - c])
}

const guillotine = (rng: () => number, r: Rect, cuts: number, min: number, vertical = r.w / r.h > 1 + rng() * 0.8): Rect[] => {
  const along = vertical ? r.w : r.h
  const parts = segments(rng, vertical ? r.x : r.y, along, cuts + 1, min)
  const pieces = parts.map(([at, size]) => (vertical ? { x: at, y: r.y, w: size, h: r.h } : { x: r.x, y: at, w: r.w, h: size }))
  if (pieces.length === 1) return pieces
  return pieces.flatMap((piece) => (cuts > 1 && rng() < 0.5 ? guillotine(rng, piece, 1, min, !vertical) : [piece]))
}

const offCentre = (rng: () => number) => clamp((rng() < 0.5 ? 0.38 : 0.62) + (rng() - 0.5) * 0.35, 0.05, 0.95)

const HUE_WEIGHTS: [Hue, number][] = [
  ['red', 0.4],
  ['yellow', 0.35],
  ['blue', 0.25],
]

const pickHue = (g: Generator): Hue => {
  const options = HUE_WEIGHTS.filter(([hue]) => hue !== g.lastHue)
  const hue = weightedPick(g.rng, options, ([, w]) => w)[0]
  g.lastHue = hue
  return hue
}

const weightedPick = <T>(rng: () => number, items: T[], weight: (item: T) => number): T => {
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  let r = rng() * total
  for (const item of items) {
    r -= weight(item)
    if (r <= 0) return item
  }
  return items[items.length - 1]
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const mulberry32 = (box: { s: number }) => () => {
  box.s = (box.s + 0x6d2b79f5) | 0
  let t = Math.imul(box.s ^ (box.s >>> 15), 1 | box.s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
