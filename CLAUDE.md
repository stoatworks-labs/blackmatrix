# atem-crosspoint

Crosspoint router matrix over a fleet of Blackmagic ATEM switchers, plus Videohub
Ethernet Protocol emulation so panels/Companion can drive the same crosspoints.
Node/TS npm-workspaces monorepo (videohub lib + matrix lib + server + web).

## Commands (npm, from repo root)
- Dev (mock fleet): `npm run dev:mock`  ← default for development
- Dev (real switchers): `npm run dev`
- Dev web only: `npm run dev:web`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Build then run: `npm run build && npm start`

## Layout (packages/)
- `videohub` — `@av/videohub`, protocol + TCP server, no ATEM knowledge
- `matrix` — `@av/atem-matrix`, AtemState → destinations/legality/routing, no I/O
- `server` — `@atem-crosspoint/server`
- `web` — `@atem-crosspoint/web`

## Notes
- `build:libs` runs before server/web (the scripts do it).
- Destination order = Videohub output numbers; source order = input numbers. Append, never insert.
- Legality comes from the switcher's `sourceAvailability`/`meAvailability`, not model tables.
- Locks are per IP, matching the Videohub spec. Refused route = ACK + unchanged status; NAK is for malformed.
- Verified against `--mock` and a raw TCP client only — no ATEM hardware, no real panel.
