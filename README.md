# ATEM Crosspoint

> **AI-assisted project.** This codebase was created with [Claude Code](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. It was developed and
> verified end-to-end against a built-in simulated switcher fleet (`--mock`) and
> against a real TCP client speaking the Videohub protocol. It has **never been
> run against a real ATEM switcher, or against a real Videohub control panel.**
> Prove it on your own kit before it goes anywhere near a show.

A **crosspoint router matrix for a fleet of Blackmagic ATEM switchers** — sources
across the top, destinations down the side, one click to route — that also
**pretends to be a Blackmagic Videohub** so hardware router panels, Companion and
Blackmagic's own software can drive the same crosspoints.

An ATEM has no single "router", so this treats every bus that takes one source at
a time as a destination, grouped into sections:

| Section | Destinations | Routed with |
|---|---|---|
| **Outputs** | Aux 1..n | `setAuxSource` |
| **Program / Preview** | Program and Preview per ME | `changeProgramInput` / `changePreviewInput` |
| **Keyer sources** | USK fill and key per ME, DSK fill and key | `setUpstreamKeyer*Source` / `setDownstreamKey*Source` |
| **SuperSource** | Box 1..n, art fill, art key | `setSuperSourceBoxSettings` / `setSuperSourceProperties` |
| **Multiview** | Every multiviewer window | `setMultiViewerWindowSource` |

Which sources are legal on which destination is **read from the switcher**, not
from a model table: every ATEM input reports a `sourceAvailability` mask (aux,
multiviewer, SuperSource art, SuperSource box, key source) and a `meAvailability`
mask. Illegal cells are drawn hatched and refused server-side — so an aux output
cannot be routed back onto an aux bus, and ME 1's output cannot be routed onto ME 1.

## Quick start

```bash
npm install
npm run dev:mock
```

That serves <http://localhost:8533> with three simulated switchers of deliberately
different shapes (1 M/E, 4 M/E, compact) and a Videohub server per switcher. No
hardware, no network switchers, nothing to break.

Against real switchers, write `atem-crosspoint.config.json` (see
`atem-crosspoint.config.example.json`) and:

```bash
npm run build && npm start
```

## Videohubs, not just switchers

A real Blackmagic Videohub can be a device in the same fleet:

```jsonc
{ "id": "hub", "name": "Machine room", "type": "videohub", "address": "192.168.1.60" }
```

Its inputs become sources and its outputs become destinations in the same grid,
so one screen covers the switchers and the router between them, and a salvo can
span both. Locks on a Videohub are the router's own and shared with every other
client on it. Details, and the **ties** that make an ATEM bus and a router
output follow each other: **[docs/videohub.md](docs/videohub.md)**.

## Capture a switcher before you lose it

```bash
npm run capture -- 192.168.10.240 --name "Stage"
```

The availability masks this whole project depends on exist only in the protocol
— not in an ATEM autosave, not in any file a switcher leaves behind. A capture
puts the real shape of a real switcher on disk, and `"capture": "<file>"` on a
device replays it with no hardware present. See
**[docs/capture.md](docs/capture.md)**, including the opt-in probe that tests
the masks against the hardware.

## Configuration

```jsonc
{
  "port": 8533,                                   // UI + REST
  "videohub": { "enabled": true, "basePort": 9990, "host": "0.0.0.0" },
  "devices": [
    { "id": "stage", "name": "Stage", "address": "192.168.10.240" },
    { "id": "studio", "name": "Studio", "address": "192.168.10.241", "videohubPort": 9995 }
  ],
  "labels": { "stage": { "aux.0": "FOH screens" } },  // your names for destinations
  "salvos": []
}
```

Each switcher gets its own Videohub server: the first on `basePort`, the next on
`basePort + 1`, unless you set `videohubPort`. **If something else on the host
already listens on 9990** — Bitfocus Companion's Videohub panel surface does —
the affected switcher logs the clash, starts without it, and everything else
keeps working. Give it another port.

## Controlling it from a router panel

Point any Videohub client at `<host>:<port for that switcher>`:

- **Bitfocus Companion** — the `blackmagic-videohub` module.
- **A Smart Videohub / Universal Videohub hardware panel**, or Blackmagic's
  Videohub Control software.
- **Anything else** that speaks [the Videohub Ethernet Protocol](docs/videohub.md).

Input numbers are the switcher's sources in ATEM source-id order; output numbers
are the destinations in the section order of the table above. Both orderings are
stable for a given switcher, so a panel's buttons keep meaning the same thing.

Full mapping, what is and is not implemented, and a worked telnet session:
**[docs/videohub.md](docs/videohub.md)**.

## Locks

A destination can be locked, from the browser or from a panel. Locks are held
**per IP address**, which is how a real Videohub does it — so a second panel on
the same machine shares the lock, and everyone else is refused. Shift-click the
padlock (or send `F` on the wire) to force one open.

Locking is enforced in one place, so a lock taken from a panel refuses a route
made from the browser, and the other way round.

## Salvos

A salvo is a named set of crosspoints **across the whole fleet** — one press sets
them all. Build one in the UI by capturing what destinations are currently taking
(`Build new`, then `+` on each row you want), or write them into the config file.

Every crosspoint in a salvo is attempted; the ones the switcher will not accept
come back named rather than silently dropped. Salvos are this app's own idea —
they are not part of the Videohub Ethernet Protocol — so they exist in the UI and
the REST API only.

## REST API

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/fleet` | — |
| `POST` | `/api/devices/:id/route` | `{ "destination": "aux.0", "source": 3 }` |
| `POST` | `/api/devices/:id/lock` | `{ "destination": "aux.0", "action": "lock\|unlock\|force" }` |
| `POST` | `/api/devices/:id/label` | `{ "destination": "aux.0", "label": "FOH" }` or `{ "source": 3, "label": "Wide" }` |
| `GET` `POST` | `/api/salvos` | a salvo |
| `DELETE` | `/api/salvos/:id` | — |
| `POST` | `/api/salvos/:id/take` | — |

The browser gets the same state pushed over `ws://<host>:8533/ws`.

Renaming a **source** renames the input on the switcher itself. Renaming a
**destination** is local to this app — the ATEM has no name for "Aux 2".

## Layout

```
packages/
  videohub   @av/videohub    Videohub Ethernet Protocol v2.3, server AND client. Knows nothing about ATEMs.
  matrix     @av/atem-matrix Turns an AtemState into destinations, legal sources, and routing calls.
  server     @atem-crosspoint/server  Fleet, locks, salvos, REST + websocket, one Videohub per switcher.
  web        @atem-crosspoint/web     The grid.
```

The two libraries are portable on purpose: `@av/videohub` will put a Videohub
front end on anything with crosspoints, and `@av/atem-matrix` has no I/O in it at all.

## Known limits

- **No ATEM hardware has ever been on the other end of this.** The routing calls
  and the availability gating come from `atem-connection`'s API and enum
  definitions.
- **No real Videohub panel has driven it either** — the protocol side is verified
  against the published specification and a TCP client, not against a panel.
- The first two **multiview windows** are program and preview on most switchers,
  which usually means the switcher ignores a route sent to them. Those rows are
  marked, not hidden.
- **Media player still/clip selection is deliberately not a destination.** It
  takes from the media pool, not from the video sources, so it does not belong in
  a matrix whose columns are sources.
- Aux-only availability bits (`Auxiliary1` / `Auxiliary2`) are read from the enum
  and unverified on hardware.
- Streaming and recording follow program and are not routable, so they are absent.

## License

MIT — see [LICENSE](LICENSE).
