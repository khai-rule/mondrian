import { describe, expect, it } from 'vitest'
import { CHUNK_H, createGenerator, generateChunk, isPlatform, MAX_GAP, top } from './composition'

describe('generateChunk', () => {
  for (const width of [6, 8, 26]) {
    for (const seed of [1, 2, 3]) {
      it(`tiles the chunk and keeps a reachable route (width ${width}, seed ${seed})`, () => {
        const g = createGenerator(width, seed)
        const count = 40
        const chunks = Array.from({ length: count }, (_, i) => generateChunk(g, i / 20))
        const cells = chunks.flatMap((c) => c.cells)

        expect(cells.reduce((sum, c) => sum + c.w * c.h, 0)).toBe(width * CHUNK_H * count)
        expect(cells.every((c) => c.w >= 1 && c.h >= 1 && c.h <= MAX_GAP)).toBe(true)

        const tops = new Set(cells.filter(isPlatform).map(top))
        let y = 0
        while (y < (count - 1) * CHUNK_H) {
          const next = [1, 2, 3].map((gap) => y + gap).find((t) => tops.has(t))
          expect(next, `no platform reachable above ${y}`).toBeDefined()
          y = next ?? Number.POSITIVE_INFINITY
        }
      })
    }
  }
})
