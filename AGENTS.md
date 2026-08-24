# AGENTS.md — bringing an LLM up to speed on BlackMatrix

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
| **blackmatrix** (this) | *Route* — every bus on every switcher as a router matrix, plus Videohub emulation |
| **atem-overseer** | *Monitor and control* a fleet from one dashboard |
| **atem-fleet-admin** | *Provision* many switchers at once (XML export or live apply) |
| **animATEM** | *Control one* switcher, with UVC multiview compositing |

Before adding a feature, check it belongs here rather than in a sibling. Anything
that is not "what source is this bus taking" probably belongs in overseer.

## 3. Layout

```
packages/
  videohub   @av/videohub      protocol + TCP server AND client, zero ATEM knowledge
  ascii      @av/ascii-matrix  plain-text line protocol over TCP/UDP, zero ATEM knowledge
  matrix     @av/atem-matrix   AtemState -> destinations/sources/legality/routing calls, zero I/O
  server     @blackmatrix/server
  web        @blackmatrix/web
```

**`build:libs` runs before server or web.** The dev, build and test scripts do it
for you; phantom type errors usually mean it did not.

Keep the three libraries portable. `@av/videohub` should stay usable to put a
Videohub front end on anything with crosspoints, `@av/ascii-matrix` a line
protocol on the same; `@av/atem-matrix` should stay free of sockets and files,
which is what makes it testable with no hardware.

`@av/ascii-matrix` deliberately does **not** reuse `RouterBackend` from
`@av/videohub`. That interface is the shape of one Videohub; this protocol is
fleet-wide — it names devices, fires salvos and triggers failover watches, none
of which a Videohub has any idea about.

## 3a. Three device kinds, one interface

`RoutableDevice` (in `atem/device.ts`) is what the fleet works with: it builds its own
matrix and applies its own crosspoints. Three implementations:

- **`AtemRoutable`** wraps an ATEM runner — real (`RealDevice`), synthetic (`MockDevice`) or
  replayed from a capture (`ReplayDevice`). All three share `StateDevice`, which is an
  AtemState plus the commands that mutate it.
- **`VideohubDevice`** is a real Blackmagic router over `@av/videohub`'s client. Every
  crosspoint is legal (`accepts: 'any'`) and **the router owns its locks**, so the fleet
  delegates rather than keeping a second, disagreeing opinion.

The model types (`MatrixModel`, `Destination`, `Source`, `Section`) live in
`@av/atem-matrix` but are router-generic — `SectionId` is a plain string and each device
declares its own sections. Only the *builders* in that package are ATEM-specific.

## 3b. Redundancy is routing, so it lives here

`failover.ts` watches something (a TCP port, a URL, or a heartbeat it must be
sent) and **fires an ordinary salvo** when it stops answering. That salvos are
the mechanism is the point: an operator can rehearse the failover by pressing
Take, which is the only way anybody finds out it does what they meant.

The rules that are not obvious and should not be softened:

- **Nothing fires until the main system has been seen working once**
  (`requireHealthyFirst`). At power-up an unbooted rack is indistinguishable
  from a dead one.
- **Watches start disarmed**, and a disarmed watch still probes and reports.
- **It latches**: no automatic switch back unless `onRestoredSalvo` says what
  back means.
- **A manual trigger works while disarmed**, and its crosspoints are attributed
  to the watch, not to whoever pressed it — a failover by hand has to behave
  exactly like a failover by probe, because the route client is what lock
  ownership is compared against.

`docs/failover.md` has the survey of how disguise and PIXERA actually do this,
and what to type into their fields. Read it before changing the wire formats.

## 4. Commands

```bash
npm run dev:mock     # <- DEFAULT. Three simulated switchers AND a simulated Videohub.
npm run capture -- <address> --name "Stage"   # take a capture off real hardware
npm run dev          # against real switchers from blackmatrix.config.json
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

## 5a. Captures are the irreplaceable artefact

The availability masks everything depends on exist **only in the protocol**. An ATEM
autosave XML has inputs, names, keyer sources, aux assignments and multiview windows — and
no masks. So if hardware is available, `npm run capture` first and ask questions later; a
capture replays as a device (`"capture": "<file>"`) forever after. `--probe` is the opt-in,
writes-to-the-switcher mode that tests the masks against reality; it never touches program,
preview, keyers or SuperSource.

## 5b. An ATEM is also a Videohub

Blackmagic's firmware serves the Videohub protocol on TCP 9990 — verified on a Mini Extreme
ISO: protocol 2.7, 23 inputs by 5 outputs (Output 1/2, Webcam Out, Program, Preview), and it
agrees with this app exactly on all five. This app's value is the other 34 destinations, not
the protocol itself. Discovery therefore finds a switcher on *both* probes and merges them
into one entry that steers toward adding it as a switcher.

## 6. Traps

- **Destination order is the Videohub output numbering, and source order is the
  input numbering.** Reordering either silently re-points every button on every
  panel out there. Append; do not insert.
- **Locks are per IP address**, not per connection, because that is what the
  Videohub spec does. Two panels on one machine share a lock. This surprises people.
- **The UI word is "claim"; the wire word is "lock".** Same state, same
  `locks` map, same `lock|unlock|force` actions on the API — only the browser
  and the guide say claim, because a padlock reads as "nothing can change this"
  while what it really is is somebody taking the row. Do not rename the API or
  the protocol side to match.
- **An owner routes through its own lock on the wire, and not over HTTP.** The
  browser and the phone app are always the owner of what they just claimed —
  same address — so the per-IP rule alone made the button refuse everyone but
  the operator who pressed it, and it looked broken because it was.
  `RouteOptions.ownLockHolds` is the split: `api.ts` passes it on every route,
  take and salvo, the Videohub and ASCII bridges never do. Do not push that
  check down into `fleet.route` unconditionally — that would break the spec for
  panels.
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
- **`--mock` also starts a simulated Videohub** and points a `videohub` device at it over
  real TCP. That is what tests the client half of the protocol without hardware — the
  server and client in `@av/videohub` are written from the same spec from opposite ends,
  and testing them against each other is how a disagreement surfaces.
- **Ties are one level deep, on purpose.** A follower's move never fires another tie.
- **A Videohub device gets no emulation by default.** It already speaks the protocol;
  putting an emulation in front of one only happens if a `videohubPort` says so.
- **Discovery must exclude this machine's own addresses.** Companion's Videohub panel
  surface listens on 9990 on every interface, so without the filter a scan offers to add the
  host it is running on, once per local address.
- **Videohub emulation ports are assigned and written back to the config**, never derived
  from a device's index — an index-derived port silently moves when another device is
  removed, and every panel button then means something else.
- **A device id is immutable.** Salvos, ties and labels are keyed on it.
- **A refused route is invisible to a media server.** ACK plus an unchanged
  status is what the spec requires and what a driver that fires and forgets
  cannot see, so a locked destination is a failover that silently does not
  happen. `videohub.failoverClients` / `ascii.failoverClients` name the addresses
  allowed through a lock — by address, because that is the only identity either
  protocol has. Legality is never overridden.
- **The routing block never carries `-1`.** A backend says -1 for "not routed";
  the protocol has no way to say it, so the line is omitted. Do not "fix" this
  by sending 0.
- **`END PRELUDE` is sent even though the published v2.3 spec has no such
  block** — real firmware does, and a client written against a real router may
  wait for it.
- **The line protocol is one-based and the Videohub protocol is zero-based.**
  Both are right for their conventions. The conversion happens in one place,
  `ascii/protocol.ts`, and the server says which base it uses in its greeting.
- **The mock's ports are overridable** (`BLACKMATRIX_PORT`,
  `BLACKMATRIX_VIDEOHUB_BASE_PORT`, `BLACKMATRIX_ASCII_PORT`,
  `BLACKMATRIX_MOCK_ROUTER_PORT`) so a second copy can be started beside a
  running one. Before that, a second mock silently lost every port to the first.

## 7. Status — be precise about it

Verified against the **simulated fleet**, against a **real TCP client** driving the
protocol, and — since 2026-08-21 — against a **real ATEM Mini Extreme ISO**, which
*corrected* the availability gating rather than confirming it (see `docs/NOTES.md`).
That is the only switcher this has ever met.

Still unproven, and not to be described otherwise: a **real Videohub control panel**
driving it, a **real Videohub as a device**, either mobile app on a physical phone,
and every model in the simulator's list except the Mini Extreme ISO — those are
declared shapes, corrected by documentation and by testers, never by hardware.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
