# Capturing a switcher

```bash
npm run capture -- 192.168.10.240 --name "Stage"
```

Writes `captures/stage-<timestamp>.json`: the switcher's full state, the matrix
derived from it, and what model said it.

## Why bother

Every rule about which source is legal on which bus is read from the switcher's
own `sourceAvailability` and `meAvailability` bitmasks. **Those live only in the
protocol.** They are not in an ATEM Software Control autosave — an autosave has
inputs, names, keyer sources, aux assignments and multiview windows, and no
availability masks at all. Nothing a switcher leaves behind on disk contains
them.

So ten seconds with the hardware puts the real shape of a real switcher on disk
permanently, and without it that shape cannot be recovered once the unit goes
back in its case.

## Replaying one

Put the file on a device in the config and it is routed like any other, with no
hardware involved:

```jsonc
{ "id": "stage", "name": "Stage (replay)", "address": "", "capture": "captures/stage-2026-08-21.json" }
```

Routing works and the state moves; nothing leaves the process. This is the way
to keep developing against a real switcher's exact shape — its real input list,
its real availability masks, its real multiviewer — long after it has gone.

## Probing (this one writes to the switcher)

```bash
npm run capture -- 192.168.10.240 --probe --yes
```

A capture is read-only. A **probe** is not: it routes a destination, reads back
what happened, and puts the original source back.

It settles the one thing a capture cannot — whether the masks mean what this
project reads them to mean, and whether the first two multiview windows really
are fixed to program and preview. Each test is recorded with what the mask said
and what the switcher did, and any disagreement is printed.

- Program, preview, keyers and SuperSource are **never** touched.
- `--probe` covers multiview windows. `--probe-aux` adds the aux buses, which
  may be feeding a screen someone is looking at — do that off-air.
- Both need `--yes`. Without it the tool explains itself and exits.
