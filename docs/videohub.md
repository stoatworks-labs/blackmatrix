# Speaking Videohub

`@av/videohub` implements the **Blackmagic Videohub Ethernet Protocol**, as
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
chassis is port 0 on the wire).

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

## Not implemented

- Monitoring outputs, serial ports, processing units, frame buffers — an ATEM has
  no equivalent, so the blocks are omitted rather than faked
- `VIDEO INPUT STATUS` / `VIDEO OUTPUT STATUS` — those describe Universal Videohub
  pluggable cards
- The RS-422 ("Leitch") protocol
- Salvos — they are not part of the Ethernet protocol; this app has its own

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
