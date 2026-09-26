import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The marketing-agent API has no CORS middleware, and adding one would mean
// changing a backend that Tasks #977–#986 deliberately froze. A dev proxy keeps
// this frontend on the same origin as the API, so the backend needs no change
// at all — and in production both sit behind one host anyway.
//
//   /api/v1/*  →  marketing-agent   (:4100)  the twelve engines
//   /nxt/*     →  NXT Sales         (:4000)  identity only, for login
//
// NXT Sales is the identity provider: it issues the JWT, and the marketing
// agent verifies it with the same secret. One login, two services, no second
// user directory.

const MARKETING_API = process.env.MARKETING_API_URL ?? 'http://localhost:4100'
const NXT_SALES_API = process.env.NXT_SALES_API_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api/v1': { target: MARKETING_API, changeOrigin: true },
      // Only a workbench SHARE LINK, which always carries a token segment.
      //
      // The bare key '/workbench' matched the app's own /workbench route as
      // well, so opening or reloading the AI Workbench went to the API instead
      // of the app and rendered {"error":{"code":"not_found","message":"No such
      // endpoint."}} as the whole page. Clicking through from the nav worked —
      // that is client-side routing and never asks the server — which is why it
      // survived until a browser actually loaded the URL directly.
      '^/workbench/[^/]+': { target: MARKETING_API, changeOrigin: true },
      '/nxt': {
        target: NXT_SALES_API,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nxt/, ''),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
