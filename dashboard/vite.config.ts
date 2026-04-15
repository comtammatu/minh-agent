import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rootDir = path.dirname(new URL(import.meta.url).pathname)

export default defineConfig({
  root: path.resolve(rootDir),
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3030',
      '/charting_library': 'http://127.0.0.1:3030',
      '/datafeeds': 'http://127.0.0.1:3030',
    },
  },
})
