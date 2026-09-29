// The run is one continuous climb; new mechanics arrive with height, each with a stretch of its own
// before it is combined with the others. Altitude is used (like scroll speed) because the generator
// knows exactly what will be at every height it builds.
export type Stage = 'still' | 'shift' | 'flow' | 'obstacle' | 'composition'

export const STAGE_STARTS: readonly { stage: Stage; from: number }[] = [
  { stage: 'still', from: 0 }, // static platforms only: learn to move, jump and build a combo
  { stage: 'shift', from: 40 }, // some coloured platforms slide
  { stage: 'flow', from: 70 }, // sliding gets varied: speeds, ranges, opposite directions
  { stage: 'obstacle', from: 100 }, // black geometric forms fly across, in chunks with no sliding platforms
  { stage: 'composition', from: 190 }, // everything together
]

export const stageAt = (altitude: number): Stage => {
  let current: Stage = 'still'
  for (const { stage, from } of STAGE_STARTS) if (altitude >= from) current = stage
  return current
}

export interface StageRules {
  moverShare: number // chance a route platform slides (never all of them)
  maxMoverRun: number // most consecutive sliding route platforms
  speed: [number, number] // peak platform speed, units per second
  amp: [number, number] // half range of a slide, units
  opposing: boolean // neighbouring sliders swing in opposite directions
  obstacleChance: number // chance a chunk carries an obstacle
  obstacleSpeed: [number, number] // units per second
  obstacleChunksStatic: boolean // an obstacle chunk has no sliding platforms (safe introduction)
}

const NONE: StageRules = {
  moverShare: 0,
  maxMoverRun: 0,
  speed: [0, 0],
  amp: [0, 0],
  opposing: false,
  obstacleChance: 0,
  obstacleSpeed: [0, 0],
  obstacleChunksStatic: false,
}

export const RULES: Record<Stage, StageRules> = {
  still: NONE,
  shift: { ...NONE, moverShare: 0.35, maxMoverRun: 1, speed: [0.7, 0.9], amp: [1, 1.5] },
  flow: { ...NONE, moverShare: 0.5, maxMoverRun: 2, speed: [0.5, 1.6], amp: [1, 2.6], opposing: true },
  obstacle: {
    ...NONE,
    moverShare: 0.3,
    maxMoverRun: 1,
    speed: [0.6, 1.2],
    amp: [1, 2],
    opposing: true,
    obstacleChance: 0.9,
    obstacleSpeed: [2.6, 3.6],
    obstacleChunksStatic: true,
  },
  composition: {
    moverShare: 0.55,
    maxMoverRun: 2,
    speed: [0.6, 2.2],
    amp: [1, 3],
    opposing: true,
    obstacleChance: 1,
    obstacleSpeed: [3, 4.4],
    obstacleChunksStatic: false,
  },
}
