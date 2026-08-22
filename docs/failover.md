# Redundant systems: driving BlackMatrix from a media server, and failing over without one

A redundant media server rig is two machines playing the same show, and a router
downstream deciding which one reaches the screens. The interesting question is
never the second machine. It is **who moves the router, and how fast**.

This document is what a survey of how the big media servers answer that turned
up, and what BlackMatrix does about it.

---

## How the media servers do it

### disguise

disguise Designer treats a matrix as a device it owns. Each machine's feed
outputs carry a **matrix input** and **matrix output** number, and on failover
the understudy — the machine taking over the failed one's role — **sends the
routing commands itself**, as soon as it has been given the new role. Restoring
a machine sends them back the other way.

Failure is detected by heartbeat and a per-machine timeout, and can also be
forced by hand from the Session widget, by a remote transport command, or
through disguise's failover API.

Its built-in matrix drivers are Blackmagic Smart Videohub, Lightware, Barco
MatrixPro and Encore, Analog Way OPS300, Gefen, PureLink, Riedel MediorNet, and
a generic **Telnet Matrix** whose command strings the operator writes: a route
header, a route body and a route footer, with `$1` for the input and `$2` for
the output, plus a **preset command** with `$1` for the preset — which is what a
machine's `DVI matrix preset` field fires on failover.

The Videohub driver wants an IP and a port, and the port defaults to **9990**.

### PIXERA

PIXERA's backup system is a mirrored Director and Clients. When the main system
is lost, its own documentation is blunt about the router: *"most of the time a
trigger must be sent to a matrix switcher to switch the output from main to
backup"*. That trigger is a control action — `BackupTrigger.MatrixSwitch` and
the like — fired from a `System Lost` trigger, sent over a `TcpClient`,
`TcpConnection` or `Udp` control module.

There is no fixed command set, because PIXERA is sending whatever string the
show file says to send.

### Everybody else

7thSense Delta, Watchout, Hippotizer and most show controllers emit ASCII over
TCP or UDP and expect something downstream to act on it. 7thSense also sells
hardware (Juggler) that does the switching in the signal path.

### So there are two shapes

1. **The server drives the router.** It needs the router to speak a protocol it
   already has a driver for.
2. **The server emits a trigger and something else decides.** It needs a
   listener, and something to hold the failover logic.

BlackMatrix answers both.

---

## 1. BlackMatrix as the router

Every switcher in the fleet already serves the **Videohub Ethernet Protocol** on
its own port, which is the protocol disguise's `BlackmagicVideoHubMatrix` driver
speaks and the one a PIXERA control module can be pointed at. A fleet of ATEMs
becomes the failover router, and — because an ATEM re-syncs its inputs — the
main and backup feeds do not have to be genlocked to each other to get a clean
cut, which an SDI router does require.

Four things exist purely so a third-party driver is happy:

```jsonc
{
  "videohub": {
    "enabled": true,
    "basePort": 9990,
    "host": "0.0.0.0",
    // Clients whose routes are not refused by a lock. See below.
    "failoverClients": ["10.0.0.30"],
    // Only if a driver checks the string before it will talk.
    "modelName": "Blackmagic Smart Videohub 12G",
    "protocolVersion": "2.3"
  }
}
```

- **`END PRELUDE:`** now closes the opening status dump. It is not in the
  published v2.3 document, but real Blackmagic firmware sends it — an ATEM's own
  Videohub server reports protocol 2.7 and sends it — so a client written
  against a real router may wait for it. Clients that do not know it ignore it.
  Set `endPrelude: false` in code if one ever chokes.
- **A section this app has none of** — monitoring outputs, serial ports,
  processing units, frame buffers — is answered with an empty block rather than
  a `NAK` when a client asks for it. A NAK reads as a broken router.
- **An output whose source cannot be named is left out of the routing block**
  rather than sent as `-1`, which is not a thing the protocol can say.
- **`modelName`** overrides the ATEM's own model string, for a driver that
  insists on seeing a Videohub.

### The lock trap, which is the one that loses a show

A refused route is answered with `ACK` and an unchanged status. That is what the
spec requires, and it means **a media server cannot see a refusal** — it fires
the crosspoints and moves on. So a destination an operator has locked is a
failover that silently does not happen.

`failoverClients` is the fix: routes from those addresses walk through locks and
say so in the log. Legality is never overridden — an illegal crosspoint on an
ATEM stays illegal, because the switcher would refuse it anyway.

It is empty by default. The address is the only identity either protocol offers,
so this is as strong as the protocol allows and no stronger.

---

## 2. The line protocol

For everything that cannot speak Videohub but can send a string. Off unless
turned on:

```jsonc
{ "ascii": { "enabled": true, "port": 9995, "host": "0.0.0.0", "failoverClients": [] } }
```

TCP and UDP on the same port. One line in, one line out. **Numbers are
one-based**, like every ASCII matrix worth imitating — the greeting says so, and
that is the single thing most worth checking before a show.

```
ROUTE <output> <input>            route on this connection's device
ROUTE <device> <output> <input>   route on a named device
DEVICE <id>                       point this connection at a device
SALVO <id or name>                fire a salvo
<n>.                              fire the nth salvo  (Extron preset recall)
<in>*<out>!                       route            (& % $ also accepted)
FAILOVER <watch id>               fire a watch's lost salvo
RESTORE <watch id>                fire its restored salvo
STATUS [device]                   what every output is taking
LIST                              devices, salvos and failover watches
PING                              answers PONG
HELP                              this list
```

An Extron-shaped request gets an Extron-shaped answer (`Out2 In1 All`, `Rpr3`),
because a driver that sends `1*2!` is usually waiting for one and will call the
router faulty otherwise.

### Setting it up in disguise

In a **Telnet Matrix** device:

| Field | Value |
|---|---|
| Route header | *(empty)* |
| Route | `ROUTE $2 $1` |
| Route footer | `\r\n` |
| Preset command | `SALVO $1\r\n` — or `$1.\r\n` for the Extron shape |

`$1` is the input and `$2` the output, which is why the route body reads
output-first. Set the machine's `DVI matrix preset` field to the salvo's
position in the list and the preset command fires it on failover.

### Setting it up in PIXERA

A `TcpClient` control module pointed at the port, and a `System Lost` trigger
whose action sends `SALVO backup\r\n` — or `FAILOVER main\r\n` to let
BlackMatrix's own watch decide what that means.

---

## 3. BlackMatrix deciding for itself

A **failover watch** watches something and fires a salvo when it goes away. For
a rig whose media server cannot drive a matrix, or where the thing that might
fail is not a media server at all.

```jsonc
{
  "failover": [
    {
      "id": "failover-main",
      "name": "Main media server",
      "probe": { "kind": "tcp", "host": "10.0.0.20", "port": 80 },
      "intervalMs": 2000,
      "failAfter": 3,
      "restoreAfter": 3,
      "onLostSalvo": "salvo-backup",
      "onRestoredSalvo": null,
      "armed": false,
      "overrideLocks": true,
      "requireHealthyFirst": true
    }
  ]
}
```

Three kinds of probe:

- **`tcp`** — a completed handshake, nothing more. Deliberately not a read:
  knowing whether the answer is *useful* means knowing the machine's protocol,
  which is a much larger promise. What this catches is the case that happens —
  the machine is off, crashed, or off the network.
- **`http`** — any answer counts unless `expectStatus` says otherwise. A 404
  from a web server still means the web server is there.
- **`heartbeat`** — nothing is polled; something must `POST
  /api/failover/<id>/heartbeat` at least as often as `intervalMs`, and its
  silence is the failure. For anything that can emit but cannot be asked.

### What the watch will not do

- **It will not fire before it has seen the main system working once**
  (`requireHealthyFirst`). At power-up a rack where nothing has booted looks
  exactly like a rack where the main system has died, and firing into that is
  how a show starts on the wrong machine.
- **It will not fire while disarmed** — it still probes and still reports, so
  the health of a rig can be watched on a day when nothing should switch.
- **It will not switch back on its own** unless `onRestoredSalvo` says what
  "back" means. The default is to latch: a machine that has failed once is not
  trusted back mid-act.
- **It will not fire twice.** Once fired, it is latched until restored.

### What it fires is an ordinary salvo

That is the whole safety story. **Rehearse the failover by pressing Take on the
salvo**, then arm the watch that presses it for you. A redundancy plan nobody
has fired once is a guess.

### Firing it from outside

| | |
|---|---|
| `POST /api/failover/<id>/trigger` | take over now |
| `POST /api/failover/<id>/restore` | go back, and clear the latch |
| `POST /api/failover/<id>/arm` | `{ "armed": true }` |
| `POST /api/failover/<id>/heartbeat` | for a heartbeat probe |
| `FAILOVER <id>` / `RESTORE <id>` | the same two, over the line protocol |

A manual trigger works on a disarmed watch, because disarming means "do not
decide for me", not "do not switch". Its crosspoints are attributed to the watch
rather than to whoever pressed it — a failover by hand has to behave exactly
like a failover by probe — and who asked is in the log.

---

## Status

**None of this has been driven by a real media server.** It is written from
disguise's and PIXERA's published documentation and from the Videohub protocol,
and it is tested against this repo's own clients: the protocol suites, a real
TCP client, and the mock fleet. What is proven is that the wire format is what
the documents describe and that the state machine does what it says.

What is not proven is that disguise's Videohub driver, or its Telnet Matrix, or
a PIXERA control module, is happy with it end to end. If you have one, the first
thing worth checking is the numbering: disguise's matrix input/output fields and
this app's line protocol are both one-based, and the Videohub protocol is
zero-based.
