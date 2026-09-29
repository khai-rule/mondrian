import type { Direction } from './engine'

// The only movement input the game knows: LEFT and RIGHT, held or not. Keyboard keys and touch
// zones both feed this one state, so a phone player has exactly the controls a keyboard player has:
// no positioning, no dragging, and the same acceleration and speed limits in the engine.
export type Side = 'left' | 'right'

export interface Input {
  readonly dir: Direction
  setKey(side: Side, isDown: boolean): void
  touchDown(id: number, side: Side): void
  touchUp(id: number): void
  clear(): void
}

export const createInput = (): Input => {
  const keys = { left: false, right: false }
  const touches = new Map<number, Side>() // each finger tracked on its own, keyed by pointer id
  const isHeld = (side: Side) => keys[side] || [...touches.values()].includes(side)
  return {
    // Both held cancel out, exactly as when two arrow keys are pressed together.
    get dir(): Direction {
      const left = isHeld('left')
      const right = isHeld('right')
      return left === right ? 0 : right ? 1 : -1
    },
    setKey: (side, isDown) => {
      keys[side] = isDown
    },
    touchDown: (id, side) => {
      touches.set(id, side)
    },
    touchUp: (id) => {
      touches.delete(id)
    },
    clear: () => {
      keys.left = false
      keys.right = false
      touches.clear()
    },
  }
}
