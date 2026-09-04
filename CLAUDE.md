# blackmatrix

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
- `videohub` — `@av/videohub`, protocol server AND client, no ATEM knowledge
- `ascii` — `@av/ascii-matrix`, plain-text line protocol (TCP+UDP), no ATEM knowledge
- `matrix` — `@av/atem-matrix`, AtemState → destinations/legality/routing, no I/O
- `lang` — `@av/atem-lang`, five command languages over a generated ATEM catalogue, no I/O
- `server` — `@blackmatrix/server`
- `web` — `@blackmatrix/web`

## Notes
- `build:libs` runs before server/web (the scripts do it).
- Destination order = Videohub output numbers; source order = input numbers. Append, never insert.
- Legality comes from the switcher's `sourceAvailability`/`meAvailability`, not model tables.
- Locks are per IP, matching the Videohub spec. Refused route = ACK + unchanged status; NAK is for malformed.
- The UI calls a lock a **claim** and crosshatches the row. On the wire an owner routes through its own lock; over HTTP it may not (`ownLockHolds`), or a claim stops nobody.
- Verified against `--mock`, a raw TCP client, and one real ATEM Mini Extreme ISO (which corrected the rules) — no real panel, no real Videohub, no other switcher model.
- Devices are `RoutableDevice`: ATEM (real/mock/replayed capture) or Videohub. A Videohub owns its own locks.
- `npm run capture -- <address>` takes a capture off hardware; `"capture": "<file>"` replays it as a device.
- Ties make one destination follow another across boxes, one level deep.
- Failover watches fire an ordinary salvo. Disarmed by default, latching, and never before the watched thing has been seen working once. See `docs/failover.md`.
- A refused route is invisible to a media server (ACK + unchanged status), so a lock silently defeats a failover — `videohub.failoverClients` walks through locks.
- Line protocol is one-based; Videohub is zero-based. Mock ports override with `BLACKMATRIX_PORT` / `_VIDEOHUB_BASE_PORT` / `_ASCII_PORT` / `_MOCK_ROUTER_PORT`.
- **Command languages** (`docs/LANGUAGES.md`): grammar, state path, raw wire code, JSON, OSC — all five compile to the same op.
  - The catalogue is GENERATED from `atem-connection`'s types: `npm run generate --workspace @av/atem-lang`. Never hand-edit `catalogue.generated.json`; regenerate and read the diff.
  - **The grammar counts from 1; every other language counts from 0.** A value is never shifted, only an address.
  - 408 state paths are readable, 27 writable. The write map is hand-vouched and build-validated — deriving it mapped `audio.classic.input.balance` onto the master bus.
  - Masked raw commands with no properties are refused: the switcher would accept one and change nothing.
  - The language rides the ASCII port as a FALLBACK; routing verbs are parsed first and unchanged. `languageOverUdp` is off by default.
  - `--mock`/replay devices refuse everything but routing (`full` is null) rather than pretend.
