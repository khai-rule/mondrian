import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const api = { '/api': 'http://localhost:8787' }

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { proxy: api },
  preview: { proxy: api },
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 60_000 }, // world generation is heavy by design
})
