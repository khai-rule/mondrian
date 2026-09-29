// Production/dev API server: `bun server/index.ts`. Serves /api and, when dist/ exists, the built app.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const dbPath = process.env.DB_PATH ?? join(import.meta.dir, '..', 'data', 'mondrian.db')
const dist = join(import.meta.dir, '..', 'dist')

mkdirSync(dirname(dbPath), { recursive: true })
const handleApi = createApp(new Database(dbPath))

Bun.serve({
  port,
  maxRequestBodySize: 4_000_000,
  async fetch(req) {
    const api = await handleApi(req)
    if (api) return api
    const { pathname } = new URL(req.url)
    const asset = Bun.file(join(dist, pathname))
    if (pathname.includes('.') && (await asset.exists())) return new Response(asset)
    const index = Bun.file(join(dist, 'index.html'))
    return (await index.exists()) ? new Response(index) : new Response('run `bun run build` first', { status: 404 })
  },
})

console.log(`MONDRIAN api on http://localhost:${port}`)
