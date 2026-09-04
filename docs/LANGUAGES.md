# The five command languages

BlackMatrix's command line accepts five languages. One of them is the grammar,
meant for a show day. The other four are ways of saying "do this to that" that
someone already has in front of them.

| Language | Looks like | For |
|---|---|---|
| **Grammar** | `Cut ME 1` | driving a show |
| **State path** | `video.mixEffects.0.programInput = 3` | poking the object model you are looking at |
| **Raw** | `CPgI mixEffect=0 source=3` | a packet capture, or Blackmagic's own docs |
| **JSON** | `{"id":"cut","verb":"do","address":{"me":0}}` | a show controller with an HTTP or socket client |
| **OSC** | `/bm/mini/cut/0` | QLab, TouchOSC, Companion, anything show-control |

All five reach the same place. A line in any of them compiles to the same op
and goes out over the same code path, so the languages cannot disagree about
what a command means.

> **Everything below is generated from `atem-connection`'s own TypeScript
> declarations.** 114 commands, 215 wire codes, 408 state paths and 38 enums,
> read out of the library by `packages/lang/tools/generate.ts` and checked in as
> `catalogue.generated.json`. A field name in this document is the library's
> field name because it was never retyped. Regenerate with
> `npm run generate --workspace @av/atem-lang` and read the diff.

---

## 1. Choosing a language

Every line is read as whichever language it looks like. The verdict is reported
in the result, so a console can show it as you type — a line read as the wrong
language produces an error about a character rather than about a command, and
that reads like your own typo.

### Saying it on the line

Any line may name its own language with a leading word:

```
BM     Cut ME 1
STATE  video.mixEffects.0.programInput = 3
RAW    CPgI mixEffect=0 source=3
JSON   {"id":"cut","verb":"do","address":{"me":0}}
OSC    /bm/mini/cut/0
```

A declared prefix always wins, including when a single language has been pinned
— naming a language is unambiguous, and refusing it would be pedantry. Pinning
still switches off *guessing*, which is the part that can surprise: someone
pasting generated JSON wants a payload that happens to start with a slash to be
a JSON error, not silently an OSC command.

**The five prefix words are not, and must never become, keywords in the
grammar.** There is a test asserting it against the live keyword table. Mynah
learned this the expensive way — `STORE` was briefly an alias for its JSON
prefix, which quietly turned every `Store Master 12` into a JSON parse error.

### How a line is sniffed

| Starts with | Read as | Why the grammar cannot produce it |
|---|---|---|
| `/` | OSC | commands start with a letter |
| `{` or `[` | JSON | same |
| a dotted word | state path | no keyword contains a dot |
| a known four-character code, **exact case** | raw | asserted disjoint from the keywords |
| anything else | the grammar | it is the fallback, deliberately |

The grammar being the fallback is the point: a mistyped command gets the
grammar's complaint about the word that is wrong, rather than JSON's complaint
about a missing brace. Case does real work in the raw rule — `DCut` is a wire
code and `dcut` is a keyword.

---

## 2. The grammar

Verb first, then what it acts on.

```
<Phrase> [<its own number>] ( <Noun> <number> | [<marker>] <value> )* [Device <id> | All]
```

```
Cut ME 1
Program 5 ME 1
Aux 3 Input 5
KeyOn On ME 1 Key 2
Macro 4
Style WIPE ME 1
Cut ME 1 Thru 4
RecordStart All
Cut ME 1 Device wing-b
```

`BM Help` lists the whole vocabulary, generated.

### ⚠️ The grammar counts from 1. Everything else counts from 0.

`Cut ME 1` is `me: 0` on the wire. This is not an inconsistency to tidy away —
it is the same split this repo already lives with, where the line protocol is
one-based and Videohub is zero-based, and for the same reason. An operator says
"ME 1"; a protocol says `me: 0`. A grammar that made an operator type `ME 0`
would be wrong in the only place it matters, and the machine languages address
the protocol directly and must not lie about it.

A **value** is not an index and is never shifted: `Program 5` is source 5.

The compiled summary always shows the resolved call, so what actually went out
is visible rather than inferred.

### Abbreviation

Keywords are case-insensitive, and every one may be shortened to any prefix
that is unambiguous **across the whole vocabulary**. These are the same command:

```
Cut ME 1
cut me 1
C ME 1
```

Because ambiguity is resolved against every word at once, a word's short form
is a property of the table rather than of the word. `Aux` has no abbreviation
at all, because `Au` is shared with `Auto`. Short forms are therefore computed
and shown by `BM Help`, never written down — adding a keyword can lengthen its
neighbours, and a hand-kept list would go quietly wrong.

An ambiguous prefix is refused **with its candidates**, so the command line
tells you which letter to add rather than calling the word unknown:

```
> Ke ME 1
ERR "Ke" could be KeyFill, KeyCut, KeyOn, Key — add a letter
```

An exact word beats the longer words it starts, or `Key` would be refused for
being the beginning of `KeyFill`.

### Ranges

`Thru` expands a number into a run, and a command addressing several units
produces one op per unit. `Cut ME 1 Thru 4` is four cuts. Two ranges cross:
`KeyOn On ME 1 Thru 2 Key 1 Thru 2` is four.

### Why the vocabulary is smaller than the catalogue

The machine languages reach all 114 commands. The grammar reaches the ones
worth a word. That asymmetry is deliberate: an unspeakable command is still
reachable through the other four, and a badly-chosen word is forever. The table
lives in `packages/lang/src/grammar/vocabulary.ts` and every entry is checked
against the catalogue when the package loads — a phrase naming a command that
does not exist, an address it does not have, or a field it does not take is a
thrown error, not a silent miss.

---

## 3. State paths

```
video.mixEffects.0.programInput = 3
set video.mixEffects.0.programInput 3
get video.downstreamKeyers.0.onAir
video.mixEffects.0.programInput = 3 on wing-b
```

Both index spellings work — `mixEffects.0` and `mixEffects[0]` — because the
first is how this app's websocket frames read and the second is how most
debuggers print an array.

### Reads and writes are not the same space

**All 408 leaves can be read. 27 can be written.** Writing is not what a state
tree does: you send a command and the state catches up.

Which command corresponds to which leaf is vouched for one at a time, never
derived. Deriving it was tried: matching field names against the tree produced
224 "matches", among which `set audio.classic.input.balance` resolved to
`audio.master.balance` — an input control that writes the master bus. A read
path that is wrong shows you the wrong number; a write path that is wrong
changes the wrong thing on a live switcher, silently.

The list is validated against the generated catalogue at build time — a path
that does not exist, a command that does not exist, a field it does not have or
a mis-named index all stop the build.

A write to a readable-but-unmapped path is refused **by name**:

```
> recording.status.state = 1
ERR recording.status.state can be read but not written — this package only
    writes paths it has a command vouched for.
```

### Index order is not decoration

`video.superSources[a].boxes[b].source` is written by
`setSuperSourceBoxSettings(props, box, ssrcId)` — the path names the SuperSource
first and the method takes the box first. The two orders are **reversed**, and
nothing in either spelling says so. The write list names which address each `[]`
fills, so they go back in the order the method wants.

---

## 4. Raw wire codes

The switcher's own four-character codes, for working from a capture.

```
CPgI mixEffect=0 source=3
DCut mixEffect=0
CTTp mixEffect=0 nextStyle=WIPE
```

Codes are **case-sensitive**. Enums are accepted by name and refused with their
spellings. A command the switcher only *sends* is refused as such.

### The masked commands are the trap

`atem-connection` has two writable shapes:

- **basic** — every value is carried in the constructor.
- **masked** — the constructor takes only the address, then each property is
  assigned *and its mask bit set*, which is how the switcher is told which
  fields were meant.

Send a masked command with no bits set and the switcher accepts it and changes
nothing, which is the most expensive kind of nothing. The catalogue records
which shape each code is, and a masked command with no properties is refused
rather than sent:

```
> CTTp mixEffect=0
ERR CTTp is a masked command: it changes only the values you name, so with
    none named it would do nothing. It takes nextStyle, nextSelection.
```

---

## 5. JSON

Three shapes, all accepted, because all three exist in the wild:

```json
{"verb":"set","id":"program.input","address":{"me":0},"values":{"input":3}}
{"path":"video.mixEffects.0.programInput","value":3}
{"raw":"CPgI","values":{"mixEffect":0,"source":3}}
```

An array runs in order, and **one bad member fails the whole line** rather than
half-applying it. A partly-applied salvo is worse than a refused one: it leaves
the operator with no idea which half landed.

The state and raw spellings are handed to the dialects that own them, so there
is one implementation of each rather than a second copy behind a different
syntax.

---

## 6. OSC

```
/bm/mini/cut/0
/bm/mini/program/input/0        3
/bm/mini/recording/start
/bm/_/aux/source/2              5
/bm/*/cut/0
```

Every address is a projection of the catalogue, by one rule:

```
/bm / <device> / <command id, dots as slashes> / <addresses…> [/ <verb>] [/ <field>]
```

The two optional segments are required exactly when they are needed to
disambiguate — the verb when the id offers more than one (`recording` can be
started, stopped or configured), the field when the command sets more than one
value. **370 addresses**, and `oscDictionary()` enumerates them, which is what
published integration documentation should be generated from.

### The rules that are not derivable

**1. The address is the target; the argument is only the value.** Everything
about *what* is addressed is in the path, so a button with a fixed address and
no argument still means something specific. That is the difference between a
TouchOSC layout you draw once and one that needs logic behind every control.

**2. A trigger fires on a non-zero argument, and on no argument at all.**
Surfaces send `1` on press and `0` on release. A cut that fired on both would
fire twice per press, and the second one is the one nobody meant.

**3. `_` is the switcher this connection points at; `*` is all of them.** The
device segment is always required — an address that silently means "whichever
switcher happens to be selected" is not one you can put on a printed layout.

**4. There is no `/norm`.** Mynah publishes normalised addresses that scale a
fader's 0..1 into device units, and it can because its device states its own
ranges. `atem-connection`'s types carry no minimum or maximum for anything, so
scaling here would mean inventing a range and quietly putting a rate or a gain
somewhere nobody asked for. Values are the switcher's own units until the
switcher says otherwise.

---

## 7. Addressing the fleet

Mynah drives one switcher. This drives a fleet, so every line has to say which.

- The grammar: `Device <id>` or `All`.
- State, raw: a trailing `on <id>` or `on all`.
- JSON: a `"device"` key.
- OSC: the device segment, with `_` and `*`.

**An unqualified line with several switchers in the fleet is refused, not
broadcast.** Routing every switcher in the building because a word was missing
is not a reasonable reading of a half-typed command. A connection that has
pointed itself at a device with `DEVICE <id>` supplies that; a fleet of exactly
one needs nothing.

## 8. Bounds come from the switcher

`video.mixEffects` is four long on a Constellation and one on a Mini, and the
switcher says so in its own state. So `Cut ME 3` is refused on the Mini before
anything is sent, and refused with the number it actually has:

```
> Cut ME 3
ERR me 2 is out of range on mini — it has 1 (0 to 0)
```

A device that cannot say gets nothing bounds-checked and the switcher does the
refusing. That is the same rule crosspoint legality already follows here, and
the reason it survived contact with real hardware: never a per-model table.

---

## 9. On the wire

The language is offered on the existing line-protocol port as a **fallback**.
The routing verbs are parsed first and are untouched, so every existing
disguise, PIXERA or 7thSense configuration behaves exactly as before. Only a
line whose first word means nothing to them reaches the language — precisely
the set that used to be answered `ERR unknown command`.

```
> ROUTE 2 5
OK ROUTE 2 5
> Cut ME 1
OK Cut me 0 on stage
```

### ⚠️ Not over UDP by default

The line protocol listens on TCP **and** UDP. The routing verbs are safe to
accept from an unauthenticated datagram — the worst a forged one does is move a
crosspoint, which is what the port is for. A full command language is a
different risk class: it can cut a programme, stop a recording or end a stream,
and UDP has no handshake, no connection and no return path worth trusting.

So `ascii.languageOverUdp` is **off** by default. A show controller that needs
it can turn it on; nobody gets it by accident.

```
{ "ascii": { "enabled": true, "port": 9995, "language": true, "languageOverUdp": false } }
```

### What a simulated switcher will not pretend to do

`--mock` and replayed captures simulate the *crosspoints*, because this app
knows what routing means. They cannot simulate running a macro or starting a
recording, and they say so rather than accepting the command and doing nothing:

```
> Cut ME 1
ERR stage is a simulated switcher — only its crosspoints are simulated
```

The mock's whole value is that it does not lie.
