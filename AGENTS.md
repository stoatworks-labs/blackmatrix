# AGENTS.md — bringing an LLM up to speed on ATEM Crosspoint

Orientation for an AI assistant (or a new human) picking this up cold. `CLAUDE.md`
has the short command reference; this explains the model and the traps.

---

## 1. What this is

A **router crosspoint matrix over a fleet of Blackmagic ATEM switchers**, plus a
**Videohub protocol emulator** so hardware panels and Companion can drive the same
crosspoints. Node/TypeScript, npm-workspaces monorepo.

## 2. Where this sits among the ATEM projects

| Repo | Purpose |
|---|---|
| **atem-crosspoint** (this) | *Route* — every bus on every switcher as a router matrix, plus Videohub emulation |
| **atem-overseer** | *Monitor and control* a fleet from one dashboard |
| **atem-fleet-admin** | *Provision* many switchers at once (XML export or live apply) |
| **animATEM** | *Control one* switcher, with UVC multiview compositing |

Before adding a feature, check it belongs here rather than in a sibling. Anything
that is not "what source is this bus taking" probably belongs in overseer.

## 3. Layout

```
packages/
  videohub   @av/videohub     protocol + TCP server, zero ATEM knowledge
  matrix     @av/atem-matrix  AtemState -> destinations/sources/legality/routing calls, zero I/O
  server     @atem-crosspoint/server
  web        @atem-crosspoint/web
```

**`build:libs` runs before server or web.** The dev, build and test scripts do it
for you; phantom type errors usually mean it did not.

Keep the two libraries portable. `@av/videohub` should stay usable to put a
Videohub front end on anything with crosspoints; `@av/atem-matrix` should stay
free of sockets and files, which is what makes it testable with no hardware.

## 4. Commands

```bash
npm run dev:mock     # <- DEFAULT for development. Three simulated switchers.
npm run dev          # against real switchers from atem-crosspoint.config.json
npm run dev:web      # UI only, proxying to a server on :8533
npm test             # vitest: protocol codec, protocol server over real TCP, matrix model
npm run typecheck
npm run build && npm start
```

## 5. The model, in one paragraph

An ATEM has no router. `@av/atem-matrix` enumerates every bus that takes one
source at a time — auxes, ME program/preview, USK and DSK fill/key, SuperSource
boxes and art, multiview windows — as a `Destination` with a stable id
(`me.1.usk.0.fill`). **Whether a source is legal on a destination is read off the
switcher**, from each input's `sourceAvailability` and `meAvailability` bitmasks,
never from a per-model table. Add a destination kind in three places: `types.ts`
(the kind), `model.ts` (build + read), `validity.ts` (legality), `apply.ts` (the
call). The UI repeats the legality rules in `web/src/availability.ts` purely to
grey cells out — the server stays the authority and refuses illegal routes anyway.

## 6. Traps

- **Destination order is the Videohub output numbering, and source order is the
  input numbering.** Reordering either silently re-points every button on every
  panel out there. Append; do not insert.
- **Locks are per IP address**, not per connection, because that is what the
  Videohub spec does. Two panels on one machine share a lock. This surprises people.
- **A refused route is `ACK` + unchanged status, not `NAK`.** `NAK` is for
  malformed or out-of-range requests. The spec is explicit that a client must
  believe the status update, not its own request.
- **9990 may already be taken** — Bitfocus Companion's Videohub panel surface
  listens there. The server logs the clash, carries on without that one Videohub,
  and the UI shows the switcher with no port. Set `videohubPort`.
- **Multiview windows 1 and 2** are program and preview on most switchers, so
  routing them does nothing. The rows carry a caveat rather than being hidden,
  because "which windows are fixed" is a per-model question this app cannot answer
  from the state.
- **`--mock` never writes the config file.** A simulated fleet must not overwrite
  a real operator's device list.

## 7. Status — be precise about it

Verified against the **simulated fleet** and against a **real TCP client** driving
the protocol. Never against an ATEM, and never against a Videohub hardware panel.
Do not describe the routing calls or the availability gating as proven.
