# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*BlackMatrix (was atem-crosspoint) — router crosspoint matrix over a fleet of ATEMs, Videohub + line-protocol emulation, and automatic failover for redundant media servers*

**BlackMatrix** at `~/projects/video/blackmatrix` — **renamed from atem-crosspoint 2026-08-21**, repo and dirs both — a **router crosspoint
matrix over a fleet of Blackmagic ATEMs**, plus a **Videohub Ethernet Protocol
v2.3 server per switcher** so hardware panels/Companion drive the same
crosspoints as the browser. Built 2026-08-21. npm-workspaces monorepo:
`@av/videohub` (protocol, no ATEM knowledge), `@av/atem-matrix` (AtemState →
destinations/legality/routing calls, no I/O), server, web. UI on **:8533**,
UI **:8533**, videohub from **9990 upward, one port per switcher**. **`stoatworks-labs/blackmatrix`, PUBLIC since 2026-08-22** (MIT; on the site at
`/software/blackmatrix/` and in the Blackmagic Tools section of `/software/video/` —
see [analog way page](https://github.com/stoatworks-labs/stoatworks-website/blob/main/docs/NOTES.md) (`stoatworks-website`)), pushed 2026-08-21, CI green (private-repo Actions minutes work again — see
**ci actions quota restored** (working-practice note, kept in Claude memory)). 41 vitest tests. Companion module:
[companion modules](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/project_companion_modules.md) has `companion-module-blackmatrix`, also PRIVATE.

Distinct from [atem overseer](https://github.com/stoatworks-labs/atem-overseer/blob/main/docs/NOTES.md) (`atem-overseer`) (monitor/control), [atem fleet admin](https://github.com/stoatworks-labs/atem-fleet-admin/blob/main/docs/NOTES.md) (`atem-fleet-admin`)
(provision) and [animatem](https://github.com/stoatworks-labs/animATEM/blob/main/docs/NOTES.md) (`animATEM`) (one switcher + UVC compositing): this one is
*routing* only.

**HARDWARE-VERIFIED against an ATEM Mini Extreme ISO on 2026-08-21** (it was at
`192.168.1.14`, MAC OUI `7c:2e:0d`) — connected, captured, probed, and its matrix
served over the Videohub emulation as a 29x39 router. Still **never driven by a
real Videohub panel**, and no real Videohub has ever been a device.

**Hardware findings, which corrected the code:**

- **Multiview windows 1 and 2 are NOT fixed to program/preview.** Both accepted
  every source their masks allowed — 80 probe tests over all 16 windows, zero
  disagreements. The old caveat and the mock's refusal were both wrong and are gone.
- **`Auxiliary1`/`Auxiliary2`/`WebcamOut` (bits 32/64/128) say WHICH aux bus, not
  "an aux".** Ordinary sources carry Aux|Aux1|Aux2|Webcam; `Camera 1 Direct` carries
  Aux|Aux1 and `Camera 2 Direct` Aux|Aux2 — HDMI passthroughs, each reaching only
  its own output. The general bit alone is NOT sufficient.
- **Aux outputs are named by the switcher**: Output 1, Output 2, Webcam Out — read
  from the aux-kind *sources* (8001, 8002, **8200** for webcam), which is where the
  destination labels now come from.
- **An ATEM SERVES THE VIDEOHUB PROTOCOL ITSELF on TCP 9990** — Blackmagic firmware,
  protocol **2.7**, presenting the Mini Extreme ISO as **23 inputs x 5 outputs**
  (Output 1/2, Webcam Out, Program, Preview), with blocks this project does not
  send (`VIDEO INPUT STATUS`, `CONFIGURATION`, `END PRELUDE`). Read back to back it
  agreed with this app on all five shared destinations. **This app's value is the
  other 34 destinations** (keyers, SuperSource, all 16 MV windows), not the
  protocol. Anyone asking "why not just use the ATEM's own?" gets that answer.
- Everything else the masks claimed held up exactly. `Color 1/2` are NOT key
  sources; clean feed has `meAvailability: NONE`.
- The Mini Extreme ISO reports `multiviewer.windowCount: 1` while actually having
  **16** windows — trust `settings.multiViewers[].windows.length`, not that field.
- **Only the Extreme models route their multiview windows** (tester, 2026-08-24). The
  base **ATEM Mini has no multiview output at all**; the **Mini Pro and Mini Pro ISO**
  have a **fixed ten-window layout** — four inputs, preview, program, stream/record
  status — that takes no source. The simulator's model list offered all ten as
  crosspoints; it now declares zero routable windows for those (`mvWindows: 0`, or
  `multiviewers: 0` for the base Mini) and the Multiview section simply does not
  appear. The SDI twins are assumed to match their Mini counterparts. **Untested
  against real Mini Pro hardware** — if one ever turns up, `npm run capture` it and
  see whether the switcher reports its windows at all, because the app's per-device
  rule is still "trust the state", and a real Mini Pro connected today would still
  offer whatever windows it reports.

Facts that cost time to establish:

- **9990 was already taken on this machine by Bitfocus Companion** (its Videohub
  panel surface). The app logs the clash, starts that switcher without a Videohub
  and carries on — so "videohub off" in the UI usually means a port clash, not a bug.
- **Legality is read off the switcher**, from each input's `sourceAvailability`
  (aux/multiviewer/SSrc art/SSrc box/key) and `meAvailability` bitmasks — never a
  per-model table. That is what stops an aux output being routed onto an aux bus,
  or ME 1's output onto ME 1.
- **Destination order IS the Videohub output numbering and source order IS the
  input numbering.** Reordering either silently re-points every button on every
  panel. Append, never insert.
- **Videohub locks are per IP address, not per connection** (the spec says so), so
  two panels on one machine share a lock, and the browser at the same address does too.
  **That is why the padlock in the UI looked dead** (tester, 2026-08-24): the browser
  that took the lock *was* its owner, and an owner routes through its own lock — the
  one client the lock did not stop was the one that set it. Fixed 2026-08-24 by
  splitting the rule by surface: the HTTP API (browser, phone app) passes
  `ownLockHolds`, so it holds against its own owner; the Videohub and ASCII bridges
  pass nothing and keep the spec's per-IP ownership.
- **The UI calls it a CLAIM, not a lock** (Allan, 2026-08-24). A padlock reads as
  "nothing can change this row", which is a promise about the hardware that nothing
  here can make; what the button actually does is *take* the row — claim ownership,
  then soft-lock it in the app so the line crosshatches and nobody edits it, the
  claimant included. So the browser says claim/release and shows a flag; the API,
  the snapshot field and the protocol still say `lock`/`unlock`/`force`, because on
  the wire that is what it is. Do not rename the wire side to match the UI.
- **A refused route is `ACK` + unchanged status, not `NAK`** — NAK is only for
  malformed/out-of-range. The spec's own model: the client must believe the status
  update, not its own request.
- **Both loopbacks must be ONE lock owner.** Ownership is per IP, but a dual-stack client
  picks a family per connection — Node's own `fetch` does, request to request — so a process
  could take a lock as `::1` and be refused its own unlock as `127.0.0.1`. `normalizeAddress`
  now folds `::1` into `127.0.0.1`. Found only by driving the Companion module against a live
  server; neither unit suite could see it.
- **A capture is the switcher's WHOLE state, including `streaming.service.key`** —
  a live stream credential — and the recording filename, which is often a client's
  job name. The key is redacted by default now and `captures/` is gitignored; do
  not publish one carelessly.
- **`npm run capture` needs INIT_CWD**: an npm workspace script runs with the
  workspace as cwd, so output landed in `packages/server/captures` until fixed.
- **Discovery must exclude the host's own IPv4 addresses**: Companion's Videohub panel
  surface listens on 9990 on EVERY interface, so a scan otherwise offers to add the
  machine it is running on, once per local address. And a switcher answers BOTH
  probes, so merge by address.
- **Videohub emulation ports are assigned and written back to config, never derived
  from list index** — an index-derived port moves when another device is removed and
  every panel button silently changes meaning. Device ids are immutable (salvos,
  ties and labels are keyed on them).
- Finding an ATEM: a **raw UDP handshake sweep works and is fast** (20-byte hello
  to :9910, any reply = a switcher) — `atemsweep.mjs` pattern. A ping sweep alone
  misses one; `atem-connection` per host is authoritative but slow.
- Protocol spec: *Videohub Developer Information*, BMD May 2018, at
  `documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf`
  — a PDF, so `pdftotext -layout` it; WebFetch alone returns binary.

## Pushing a tag is NOT enough — create the release too (2026-08-24)

`release-desktop.yml` never creates the GitHub release. Every job builds its
installers, then polls `gh release view "$TAG"` for **30 tries at 10s** and runs
`gh release upload`. With no release there to find, each job fails at *Attach
installers to the release* five minutes later, with `release not found` buried in
the log and a green-looking "build" phase above it.

v0.2.2 lost macOS x86_64, macOS aarch64 and Windows that way — the three that
finished before I created the release by hand. Linux was still building, found the
release when it got there, and passed. `gh run rerun <id> --failed` is refused
while any job is still in flight (`This workflow is already running`), so the
recovery is: create the release, wait for the stragglers, then rerun the failures.

So the order is **create the release, then push the tag** — or create it within
five minutes. Worth fixing in the workflow with a `gh release create
--generate-notes --verify-tag` step, or a `create-release` job the matrix depends
on; until that exists this is a step, not an optional nicety.

## Renamed to BlackMatrix (2026-08-21)

Repos, dirs, packages (`@blackmatrix/server`, `@blackmatrix/web`; `@av/videohub` and
`@av/atem-matrix` keep the fleet-portable `@av/` scope), config file
`blackmatrix.config.json`, env `BLACKMATRIX_CONFIG`, Worker name, Companion module id
`blackmatrix` (old id in `legacyIds`).

**Both old names are still READ**: an existing `atem-crosspoint.config.json` is found and
used with a warning, and captures carrying `"format": "atem-crosspoint-capture"` still
load. Do not remove either fallback without checking what is on disk.

The name is deliberately Blackmagic-adjacent; ATTRIBUTIONS.md carries the
non-affiliation disclaimer.


## Released v0.1.1, packaged three ways (2026-08-21)

Container (`ghcr.io/stoatworks-labs/blackmatrix`, registered in stoatworks-unraid's
fleet.json and generated from it), av-launcher desktop app (7 installers across
macOS/Windows/Linux from `release-desktop.yml`), and the hosted simulator at
**https://blackmatrix.allan-sargeant.workers.dev**.

- **v0.1.0 is superseded and marked as such**: its desktop app is missing
  [macos local network permission](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_macos_local_network_permission.md) and cannot see the network when
  launched from the Finder.
- **`gen-downloads.py` does not manage this repo** — public repos only. Its
  markers are deliberately absent from the README so a future run cannot claim
  the hand-written Download block. Running it with `--repo blackmatrix` still
  rewrites the *website's* downloads.json (date stamp only; a private repo's
  assets correctly never appear there).
- **A failed `bundle_dmg.sh` leaves `/Volumes/dmg.XXXXXX` mounted, and the next
  DMG build then fails too.** `hdiutil detach` it. Extends the known
  "do not run two concurrently" trap. Also: `--bundles dmg` alone *cleans away*
  the `.app`; build `app,dmg` together.
- Adding a device needs only an address: the id and name are derived, and the
  model auto-detects from what the device reports.


## Phone support (2026-08-21)

**Responsive X-Y view** below 800px — destination list, then the sources that
destination accepts. The grid is replaced, not shrunk (a 4 M/E is 56x104).
**Preset is the default at that width**, set once: a mis-tap in live mode is a
crosspoint on air.

**Native shell in `mobile/`** — Tauri v2. **iOS and Android both build and run
here**, verified in simulator/emulator against the live switcher. It only finds a server and shows that server's UI in an
iframe; it does NOT speak the protocols. `/api/health` gained `id` + `name`
because a sweep finds one server once per address it answers on.

Traps found building it, all of which look like "the app is broken":

- **`display: flex` beats the `hidden` attribute.** Hiding a pane that has a
  display rule silently does nothing. Add `[hidden] { display: none !important }`.
- **iOS zooms when a focused input is under 16px and never zooms back** — the
  field inherited 12px from its label. Pin the viewport with `maximum-scale=1`
  too (WKWebView honours it; mobile Safari does not).
- **A failed `tauri ios build` leaves its xcarchive** and the next build dies
  with "failed to rename app: Directory not empty". `rm -rf gen/apple/build`.
- iOS needs **both** `NSLocalNetworkUsageDescription` (or the sweep is denied
  silently — see [macos local network permission](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_macos_local_network_permission.md)) **and** ATS
  `NSAllowsLocalNetworking` (or plain http to a private address is blocked).
- `gen/apple/{build,Externals}` are ~400 MB; Tauri's own .gitignore covers them.
  The committed generated project is ~316 KB.

**A duplicated rule bit, exactly as predicted.** The web package kept its own
copy of `isLegal` from before the hardware corrected the aux-bit reading, so the
UI offered "Camera 1 Direct" on all three outputs while the server refused it.
The web now imports `isLegal` and the model types from `@av/atem-matrix`; there
is one definition. If a "make X browser-safe so it can be shared" change is made,
finish it by deleting the copy — otherwise it is just a third implementation.


## Android (2026-08-21)

**The Android SDK was already installed** at `/opt/homebrew/share/android-commandlinetools`
(cask `android-commandlinetools`: cmdline-tools, build-tools 35, NDK 28.2, platform
35/36, an arm64 emulator image). `ANDROID_HOME` is simply **unset** in the shell —
an earlier "no Android SDK" conclusion from that was wrong. Export:

    ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
    NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358
    JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home

- **Gradle cannot use JDK 25** (the default here). It fails with a bare `> 25.0.4`
  and no explanation. openjdk@21 is installed; point JAVA_HOME at it.
- **`usesCleartextTraffic` is false for RELEASE builds** in Tauri's generated
  `gen/android/app/build.gradle.kts` — a release APK silently reaches no http
  server while debug works. Set true (gen/android is committed and editable;
  `tauri android init` overwrites it).
- **Grid + `<input>` = overflow**: a grid item's automatic minimum is its content
  and an input's is its default `size`, so a field hangs off a narrow screen.
  `min-width: 0` on the item and the field.
- The **emulator is NAT'd alone on 10.0.2.x**, so the LAN sweep finds nothing
  there; the host is reachable as `10.0.2.2`. Not a fault — on iOS the simulator
  shares the host network and the sweep works.
- Another emulator (`pocketrig`, emulator-5554) may already be running — target
  yours by serial.


## Publishing it, 2026-08-22

Two things had to be fixed first, and both are the kind that only show up when
somebody reads the repo as an outsider would:

- **The README's AI disclaimer was flatly false.** It still said this had "never
  been run against a real ATEM switcher" — untrue since `f90f52e`, whose whole
  subject is correcting the routing rules from a real Mini Extreme ISO. AGENTS.md
  and `docs/videohub.md` both recorded the verification; only the first thing a
  reader sees did not. **A disclaimer is a factual claim and rots like any other**
  — same failure `weblinked`'s had.
- **`blackmatrix.config.json` was tracked**, holding a working config pointing at
  one particular switcher, because `.gitignore` was never updated past the rename
  and still ignored `atem-crosspoint.config.json` only. Untracked; both names now
  ignored. The file is optional (`DEFAULTS` has no devices).

The hand-written Download table also claimed "this repo is private, so these links
are not managed by gen-downloads.py". Replaced with `<!-- downloads:start -->`
markers, so `gen-downloads.py` owns it now.

**`companion-module-blackmatrix` is still PRIVATE**, and its GitHub description
still says "ATEM Crosspoint" — stale since the rename. Every other app's Companion
module is public and on the site, so this is an odd half-state; not published
because it was not asked for.

**No screenshot exists.** The site page falls back to the branded thumbnail. The
mock server's port is **hard-coded to 8533** via `MOCK_CONFIG` spreading `DEFAULTS`
with no env or CLI override, so it cannot be started alongside a copy already
running there — which is what blocked capturing one. A `--port` flag would fix it.


## v0.2.0 — failover for redundant media servers (2026-08-22)

**PUBLIC v0.2.0, released, signed, filmed and posted.** The research behind it is
[media server failover integration](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_media_server_failover_integration.md); `docs/failover.md` in the repo is the
long form.

Three things shipped:

- **The Videohub emulation was made safe for a third-party driver.** It now sends
  `END PRELUDE` (real firmware does; the published v2.3 spec does not mention it, and
  a client written against a real router may wait for it), answers a bare request for
  a section it has none of with an **empty block instead of `NAK`**, and **never puts
  `-1` in a routing line** — the protocol cannot say "not routed", so the line is
  omitted. `videohub.modelName` and `videohub.protocolVersion` are overridable for a
  driver that checks them.
- ⚠️ **`videohub.failoverClients` / `ascii.failoverClients`** name addresses whose
  routes are **not refused by a lock**. This is the one that matters: a refused route
  is `ACK` + unchanged status, which a media server never reads, so a locked
  destination was a failover that silently did not happen. Legality is never
  overridden.
- **New `@av/ascii-matrix`** (5th workspace package): a line protocol on TCP **and
  UDP**, port 9995, off by default. `ROUTE <out> <in>`, `DEVICE`, `SALVO`, `FAILOVER`,
  `RESTORE`, `STATUS`, `LIST`, `PING`, plus the Extron shapes `<in>*<out>!` and `<n>.`
  (preset recall = salvo by position, which is what disguise's `DVI matrix preset`
  fires). **One-based on the wire while Videohub is zero-based** — the greeting says
  which. Deliberately does NOT reuse `RouterBackend`: that is the shape of one
  Videohub, this protocol is fleet-wide.
- **Failover watches** (`failover.ts`): probe `tcp` / `http` / `heartbeat`, fire an
  **ordinary salvo**. Disarmed by default, latching (no automatic switch back without
  `onRestoredSalvo`), fires once, and **never before the watched thing has been seen
  working once** — at power-up an unbooted rack is indistinguishable from a dead one.
  A manual trigger works while disarmed and its crosspoints are attributed to the
  watch, not the operator, because the route client is what lock ownership compares.

**Mock ports are now overridable** — `BLACKMATRIX_PORT`, `BLACKMATRIX_VIDEOHUB_BASE_PORT`,
`BLACKMATRIX_ASCII_PORT`, `BLACKMATRIX_MOCK_ROUTER_PORT` — which is what finally made
it possible to run a second copy for a screenshot or a take. Before that a second mock
silently lost every port to the first.

**Still true: no media server has ever driven any of this.** Written from disguise's
and PIXERA's published docs and tested against the repo's own clients. README,
`docs/failover.md` and the video description all say so.

Release homes all done: tag + 7 installers, macOS **signed and notarised** (the
autosign agent ran *before* CI finished uploading and marked it done with "no macOS
assets" — `posthoc-sign.sh stoatworks-labs/blackmatrix v0.2.0` fixed it by hand;
watch for that whenever a release-desktop run is re-triggered), `gen-downloads.py`,
website blurb + version + `youtube` + `videoDate` deployed, hosted simulator
redeployed, YouTube **A0YzfXbPcG0**, Instagram Reel, README embed.

**AGENTS.md §7 was still the stale "never against an ATEM" claim during this release.**
The correction sits on branch `claude/lucid-northcutt-8c2048` (commit `48a80aa`),
unmerged.

**BlackMatrix has no About window** — it is not in `scripts/sync-about.py`'s repo list,
though it does carry the support footer. See [about window](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_about_window.md).
