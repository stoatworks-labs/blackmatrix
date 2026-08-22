# Speaking Videohub

`@av/videohub` implements **both halves** of the **Blackmagic Videohub Ethernet
Protocol**: a server, so an ATEM can be driven by router panels, and a client,
so a real Videohub can be driven by this app. They are tested against each
other — written from the same specification, one from each end, so anywhere
they disagree one of them has it wrong.

The server implements, as
published in *Videohub Developer Information* (Blackmagic Design, May 2018),
protocol version **2.3**. It is a text protocol on TCP **9990**: blocks with an
ALL-CAPS header ending in a colon, one item per line, terminated by a blank line.

This app runs **one Videohub server per switcher**, because a Videohub has a
single input list shared by all of its outputs, and a route from one ATEM's
source to another ATEM's bus is not a thing that can happen.

## What an ATEM looks like as a Videohub

| Videohub | ATEM |
|---|---|
| Video inputs | Every source the switcher reports, in ATEM source-id order |
| Video outputs | Every routable destination, in section order: aux → program/preview → keyers → SuperSource → multiview |
| Input labels | The switcher's own input names. Renaming one **renames the input on the switcher** |
| Output labels | This app's destination names. Renaming one is local — an ATEM has no name for "Aux 2" |
| Output locks | Held per IP address, enforced for browser clients too |
| Monitoring outputs, serial ports, processing units | None. Those blocks are not sent, as the spec requires for a device without them |

Input and output numbering start at **zero**, matching the protocol (port 1 on a
chassis is port 0 on the wire). This app's own line protocol is one-based, which
is the usual convention there — see [failover.md](failover.md).

An output whose current source this app cannot name is **left out of the routing
block** rather than reported as `-1`. The protocol has no way to say "not
routed": every line is an input index, and a real Videohub always has one. A
missing line is something every client already copes with, because a status
update carries only what changed.

## Refusals

A route the switcher would not accept — an aux output onto an aux bus, ME 1's
output onto ME 1, a key-only source onto a program bus — is **acknowledged and
then not performed**:

```
VIDEO OUTPUT ROUTING:
0 36

ACK

VIDEO OUTPUT ROUTING:
0 5
```

That is the spec's own model: the client must never assume its request happened,
and must take its state from the status update that follows. A *malformed* or
out-of-range request gets `NAK` instead.

## Implemented

- `PROTOCOL PREAMBLE`, `VIDEOHUB DEVICE` (with the later `Friendly name` and
  `Unique ID` lines, which older clients ignore)
- `INPUT LABELS`, `OUTPUT LABELS` — dump and set
- `VIDEO OUTPUT ROUTING` — dump and set
- `VIDEO OUTPUT LOCKS` — dump and set, including `F` to force
- Status-dump requests (send a bare header), `PING:`, `ACK` / `NAK`
- Pushed status updates when anyone changes anything, including from the browser
- `END PRELUDE` closing the opening dump. Not in the published v2.3 document,
  but real firmware sends it — an ATEM's own Videohub server, at protocol 2.7,
  does — and a client written against a real router may wait for it. Clients
  that do not know it ignore it, so sending it costs nothing.
- A **bare request for a section this device has none of** (monitoring outputs,
  serial ports, processing units, frame buffers, the status blocks) is answered
  with `ACK` and an empty block. A `NAK` there reads as a broken router to a
  control system that probes for what it can find. *Setting* one of those is
  still a `NAK`.

## Not implemented

- Monitoring outputs, serial ports, processing units, frame buffers — an ATEM has
  no equivalent, so the blocks are omitted rather than faked (a bare request for
  one is answered empty rather than refused, as above)
- `VIDEO INPUT STATUS` / `VIDEO OUTPUT STATUS` — those describe Universal Videohub
  pluggable cards
- The RS-422 ("Leitch") protocol
- Salvos — they are not part of the Ethernet protocol; this app has its own

## An ATEM already serves this protocol — so why this app?

Blackmagic's firmware runs its own Videohub server on the switcher, on TCP 9990.
Verified on an ATEM Mini Extreme ISO (2026-08-21): protocol **2.7**, presenting
the switcher as **23 inputs by 5 outputs** — Output 1, Output 2, Webcam Out,
Program and Preview. It sends blocks this implementation does not
(`VIDEO INPUT STATUS`, `CONFIGURATION`, `END PRELUDE`), which is fine in both
directions: the spec tells clients to ignore what they do not recognise.

Read back to back against this app on the same switcher, the two agreed on all
five destinations, every time.

The difference is what is on offer. Blackmagic exposes the five outputs it
considers routing; this app exposes **29 sources by 39 destinations** on the same
switcher — every aux, both ME buses, four upstream keyers and two downstream
keyers as fill and key, four SuperSource boxes plus art fill and key, and all
sixteen multiviewer windows. A router panel pointed at the switcher gets the
five. Pointed at this app, it gets all of them.

So: use the switcher's own server if five outputs is what you need. This one is
for when it is not.

## Making a third-party driver happy

A media server driving this for redundancy is a client written against a real
router, not against the 2018 document, so three settings exist for it:
`videohub.modelName` (some drivers check the model string before they will
talk), `videohub.protocolVersion`, and `videohub.failoverClients` — addresses
whose routes are not refused by a lock, because a refusal is answered with `ACK`
and an unchanged status, which a media server never reads. All of it is in
[failover.md](failover.md).

## Driving a real Videohub

A Videohub in the config is a device in the fleet like any switcher:

```jsonc
{ "id": "hub", "name": "Machine room", "type": "videohub", "address": "192.168.1.60" }
```

The address may carry a port (`192.168.1.60:9990` is the default). Its inputs
become sources, its outputs and monitoring outputs become destinations in their
own sections, and every crosspoint is legal — a router has no availability
rules, and applying the switcher's would hatch out the whole grid.

Two things work differently to an ATEM, both because the router owns them:

- **Locks are the router's**, shared with every other client connected to it, so
  this app reports and sets them rather than keeping its own. A lock this app
  holds shows as "this app"; one held elsewhere shows as "another client".
- **Renaming a source renames the input on the router**, exactly as renaming an
  ATEM source renames the switcher's input.

A Videohub gets **no protocol emulation** of its own by default — it already is
one. Name a `videohubPort` on the device if you want this app's aggregated view
served in front of it anyway.

## Ties: making one destination follow another

```jsonc
"ties": [
  {
    "id": "house",
    "name": "House screen follows Stage aux 1",
    "leader": "stage:aux.0",
    "follower": "hub:out.1",
    "sourceMap": { "1": 4, "2": 5, "3": 6 }
  }
]
```

Route the leader and the follower goes to the matching source. The mapping is
explicit because nothing else could be: "camera 1" is input 1 on a switcher and
whatever it happens to be patched to on a router.

Ties fire on the **change**, not on the request, so a route made from a panel or
from the switcher's own front panel drags its follower too. A source with no
mapping leaves the follower alone and logs it. Ties are one level deep — a
follower's own move never fires another tie, which is the feature rather than a
limitation: chained ties are a loop waiting to happen.

## Trying it by hand

```bash
nc localhost 9991
```

You will get the full dump immediately. Then, to route output 0 to input 5, type
the block and a blank line:

```
VIDEO OUTPUT ROUTING:
0 5

```

Other things worth typing: `PING:` then a blank line, `OUTPUT LABELS:` then a
blank line to re-dump them, and `VIDEO OUTPUT LOCKS:` / `0 O` / blank line to
take a lock — then watch the browser refuse to route that destination.
