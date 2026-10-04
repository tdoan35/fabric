# Fabric web

Vite + React Router (data router) single-page app. No server rendering — the backend is a separate service (see `docs/ARCHITECTURE.md`), reached only through `src/lib/api`. Keep it that way so the same build can ship to the web and inside Electron.

- Routes: `src/router.tsx`; route components live in `src/routes/`.
- Navigation: `Link` / `useLocation` / `useSearchParams` / `useParams` from `react-router`.
- Styles: Tailwind v4 via `@tailwindcss/vite`; theme tokens in `src/styles/globals.css`.
- UI primitives: shadcn (`components.json`), in `src/components/ui/`.
- Desktop: `electron/main.mjs` wraps the same build. `npm run electron:dev` (Vite + HMR inside Electron), `npm run electron:start` (built `dist/` over the `app://` protocol), `npm run electron:dist` (installer into `release/` via electron-builder). Renderer code must not assume Electron; desktop-only APIs go through `electron/preload.cjs`, read via `desktop` from `src/lib/desktop.ts` (undefined on the web). The window is frameless (macOS keeps traffic lights); `src/components/shell/title-bar.tsx` draws the bar, and layout offsets by `--titlebar-height` (0 on the web).
