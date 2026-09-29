import { describe, expect, it } from 'vitest'
import { createInput } from './input'

describe('input', () => {
  it('holds a direction while a finger is down and releases it when the finger lifts', () => {
    const input = createInput()
    expect(input.dir).toBe(0)
    input.touchDown(1, 'left')
    expect(input.dir).toBe(-1)
    input.touchUp(1)
    expect(input.dir).toBe(0)
  })

  it('tracks fingers independently: lifting one never releases the other', () => {
    const input = createInput()
    input.touchDown(1, 'left')
    input.touchDown(2, 'right')
    expect(input.dir).toBe(0) // both held cancel, the same as two arrow keys together
    input.touchUp(1)
    expect(input.dir).toBe(1)
    input.touchDown(3, 'right')
    input.touchUp(2)
    expect(input.dir).toBe(1) // a second finger on the same side keeps it held
    input.touchUp(3)
    expect(input.dir).toBe(0)
  })

  it('merges keyboard and touch into the same state', () => {
    const input = createInput()
    input.setKey('left', true)
    input.touchDown(7, 'left')
    input.setKey('left', false)
    expect(input.dir).toBe(-1) // the finger still holds LEFT
    input.touchUp(7)
    expect(input.dir).toBe(0)
    input.setKey('right', true)
    expect(input.dir).toBe(1)
  })

  it('ignores a touchend for an unknown finger and clears everything on cancel', () => {
    const input = createInput()
    input.touchUp(99)
    input.touchDown(1, 'right')
    input.setKey('left', true)
    input.clear()
    expect(input.dir).toBe(0)
    input.touchUp(1) // late event after clear: harmless
    expect(input.dir).toBe(0)
  })
})
