/**
 * Read the ATEM's capability catalogue out of `atem-connection`'s own types.
 *
 * Run with `npm run generate --workspace @av/atem-lang`. The output is checked
 * in, so nobody needs the compiler API to build this package — but it is
 * regenerated (and the diff read) whenever the library is upgraded.
 *
 * Three sources, because no one of them has everything:
 *
 *  1. **`Atem`'s methods**, via the TypeScript compiler API — the callable
 *     surface, with every parameter and every props-object field resolved to a
 *     name and a type. This is what the grammar and OSC are built from.
 *  2. **`Commands.*` at run time** — 219 classes carrying the four-character
 *     codes that go on the wire. Types cannot give these; the classes can, and
 *     they are static, so a plain import is enough.
 *  3. **`AtemState`**, via the compiler API again — the read tree, for `Get`
 *     and for the state-path dialect.
 *
 * See `src/catalogue.ts` for the shape, and for why the address-versus-value
 * split is the one thing here that is not purely derived.
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Commands, Enums } from 'atem-connection'
import type {
  AddressParam,
  Catalogue,
  CommandSpec,
  FieldSpec,
  RawCommandSpec,
  ParamRef,
  StatePathSpec,
  ValueType,
  WritePathSpec,
} from '../src/catalogue.js'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(here, '../src/catalogue.generated.json')

/* ------------------------------------------------------------------------ *
 * The one hand-kept list: which parameter names address a unit.
 *
 * Needed only for REQUIRED parameters of methods that take no props object —
 * everywhere else position decides (see `classify`). `input` is deliberately
 * absent: in `changeProgramInput(input, me?)` it is the source being routed,
 * a value, and every method where `input` addresses an input has a props
 * object and is covered by the positional rule instead.
 * ------------------------------------------------------------------------ */
const ADDRESS_NAMES = new Set([
  'me',
  'mixEffect',
  'keyer',
  'upstreamKeyerId',
  'key',
  'index',
  'box',
  'ssrcId',
  'mv',
  'window',
  'player',
  'bus',
  'band',
  'keyframe',
  'clipId',
  'stillId',
  'inputId',
])

/**
 * Names that address a unit only when they are strings.
 *
 * `source` is the whole list. In `setFairlightAudioMixerSourceProps(index,
 * source: string, …)` it names an audio source within an input; in
 * `setAuxSource(source: number, bus?)` it is the thing being routed. Same
 * word, opposite roles, told apart by the only thing that differs.
 */
const ADDRESS_NAMES_STRING = new Set(['source'])

/**
 * Where a unit count is read from at run time.
 *
 * A dotted path into `AtemState` whose array length bounds the address. Absent
 * bounds are not invented: an unbounded address is passed to the switcher and
 * the switcher refuses it, which is the same rule crosspoint legality follows.
 */
const COUNT_PATHS: Record<string, string> = {
  me: 'video.mixEffects',
  mixEffect: 'video.mixEffects',
  key: 'video.downstreamKeyers',
  player: 'media.players',
  mv: 'settings.multiViewers',
  ssrcId: 'video.superSources',
}

/**
 * State paths that may be assigned to, and the command that does it.
 *
 * `[path, verb, id, field, ...indices]`. Validated against the generated
 * catalogue at the bottom of this file: a path that does not exist, a command
 * that does not exist, a field it does not have or an index name that is not
 * one of its address parameters all stop the build. So this list cannot rot
 * quietly when `atem-connection` moves something.
 *
 * See `WritePathSpec` in `src/catalogue.ts` for why it is hand-written.
 */
const WRITE_PATHS: ReadonlyArray<readonly [string, string, string, string, ...string[]]> = [
  // Crosspoints — the set this repo has verified against a real switcher.
  ['video.mixEffects[].programInput', 'set', 'program.input', 'input', 'me'],
  ['video.mixEffects[].previewInput', 'set', 'preview.input', 'input', 'me'],
  ['video.auxilliaries[]', 'set', 'aux.source', 'source', 'bus'],
  ['video.mixEffects[].upstreamKeyers[].fillSource', 'set', 'usk.fill.source', 'fillSource', 'me', 'keyer'],
  ['video.mixEffects[].upstreamKeyers[].cutSource', 'set', 'usk.cut.source', 'cutSource', 'me', 'keyer'],
  ['settings.multiViewers[].windows[].source', 'set', 'mv.window.source', 'source', 'mv', 'window'],
  // Note the reversal: the path is superSources[ssrcId].boxes[box], and the
  // method is setSuperSourceBoxSettings(props, box, ssrcId).
  ['video.superSources[].boxes[].source', 'set', 'ssrc.box', 'source', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].enabled', 'set', 'ssrc.box', 'enabled', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].x', 'set', 'ssrc.box', 'x', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].y', 'set', 'ssrc.box', 'y', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].size', 'set', 'ssrc.box', 'size', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].cropped', 'set', 'ssrc.box', 'cropped', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].cropTop', 'set', 'ssrc.box', 'cropTop', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].cropBottom', 'set', 'ssrc.box', 'cropBottom', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].cropLeft', 'set', 'ssrc.box', 'cropLeft', 'ssrcId', 'box'],
  ['video.superSources[].boxes[].cropRight', 'set', 'ssrc.box', 'cropRight', 'ssrcId', 'box'],

  // Keyers on air, and the downstream keyer's own controls.
  ['video.mixEffects[].upstreamKeyers[].onAir', 'set', 'usk.on.air', 'onAir', 'me', 'keyer'],
  ['video.downstreamKeyers[].onAir', 'set', 'dsk.on.air', 'onAir', 'key'],
  ['video.downstreamKeyers[].properties.tie', 'set', 'dsk.tie', 'tie', 'key'],
  ['video.downstreamKeyers[].properties.rate', 'set', 'dsk.rate', 'rate', 'key'],

  // Transitions.
  ['video.mixEffects[].transitionProperties.nextStyle', 'set', 'transition.style', 'nextStyle', 'me'],
  ['video.mixEffects[].transitionSettings.mix.rate', 'set', 'mix.transition', 'rate', 'me'],
  ['video.mixEffects[].transitionSettings.dip.rate', 'set', 'dip.transition', 'rate', 'me'],
  ['video.mixEffects[].transitionSettings.wipe.rate', 'set', 'wipe.transition', 'rate', 'me'],
  ['video.mixEffects[].fadeToBlack.rate', 'set', 'fade.to.black.rate', 'rate', 'me'],

  // Multiviewer window options. The state and the method disagree on names
  // here (`safeTitle` versus `safeAreaEnabled`), which is exactly the sort of
  // thing an explicit list gets right and a derived one does not.
  ['settings.multiViewers[].windows[].safeTitle', 'set', 'mv.window.safe.area.enabled', 'safeAreaEnabled', 'mv', 'window'],
  ['settings.multiViewers[].windows[].audioMeter', 'set', 'mv.window.vu.enabled', 'vuEnabled', 'mv', 'window'],
]

/** Methods a command line has no business offering. */
const SKIP = new Set([
  'connect',
  'disconnect',
  'destroy',
  'sendCommand',
  'sendCommands',
  'sendUnprioritizedCommands',
  'setMultiviewerFontFace',
  'setMultiviewerFontScale',
  /* Not commands: a query helper and a bitmap upload. */
  'listVisibleInputs',
  'writeMultiviewerLabel',
  /* A synchronous capability query. Belongs to availability, not the grammar. */
  'hasInternalMultiviewerLabelGeneration',
  /* EventEmitter's surface, which `Atem` inherits. */
  'addListener',
  'removeListener',
  'removeAllListeners',
  'listenerCount',
  'listeners',
  'rawListeners',
  'eventNames',
  'setMaxListeners',
  'getMaxListeners',
  'prependListener',
  'prependOnceListener',
  'once',
  'off',
])

/** Anything moving a file. Real features, but not one-line ones. */
const SKIP_PREFIX = ['download', 'upload']

const warnings: string[] = []

function main(): void {
  const entry = require.resolve('atem-connection/dist/atem.d.ts')
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
  })
  const checker = program.getTypeChecker()

  const enums = collectEnums(program)
  const commands = collectCommands(program, checker, enums)
  const raw = collectRaw(program, checker, enums)
  const state = collectState(program, checker, enums)
  const writes = collectWrites(commands, state)

  const pkg = JSON.parse(
    fs.readFileSync(require.resolve('atem-connection/package.json'), 'utf8'),
  ) as { version: string }

  const catalogue: Catalogue = {
    library: pkg.version,
    generated: new Date().toISOString().slice(0, 10),
    commands,
    raw,
    state,
    writes,
    enums,
  }

  fs.writeFileSync(OUT, JSON.stringify(catalogue, null, 2) + '\n')

  console.log(`atem-connection ${pkg.version}`)
  console.log(`  commands   ${commands.length}`)
  console.log(`  raw codes  ${raw.length}`)
  console.log(`  state      ${state.length} (${writes.length} writable)`)
  console.log(`  enums      ${Object.keys(enums).length}`)
  console.log(`  -> ${path.relative(process.cwd(), OUT)}`)
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of warnings) console.log(`  ! ${w}`)
  }
}

/* -- 1. enums ------------------------------------------------------------ */

/**
 * The switcher's enums, as name-to-value maps.
 *
 * Declaration order comes from the types and the values come from the runtime
 * export, because both halves are needed and neither source has both. A
 * command line takes `WIPE` and the wire takes `2`; storing only the names
 * would mean guessing the number from the position, which holds right up until
 * an enum is declared with explicit values.
 *
 * TypeScript's numeric enums carry a reverse mapping — `{ 0: 'MIX', MIX: 0 }` —
 * so the numeric keys are dropped on the way through.
 */
function collectEnums(program: ts.Program): Record<string, Record<string, number>> {
  const runtime = Enums as unknown as Record<string, Record<string, unknown>>
  const out: Record<string, Record<string, number>> = {}

  for (const file of program.getSourceFiles()) {
    if (!file.fileName.includes('atem-connection/dist/enums/')) continue
    for (const statement of file.statements) {
      if (!ts.isEnumDeclaration(statement)) continue
      const name = statement.name.text
      const values = runtime[name]
      const members: Record<string, number> = {}
      for (const member of statement.members) {
        const key = member.name.getText(file).replace(/^["']|["']$/g, '')
        const value = values?.[key]
        if (typeof value === 'number') members[key] = value
      }
      if (Object.keys(members).length) out[name] = members
    }
  }
  return out
}

/* -- 2. the callable surface --------------------------------------------- */

function collectCommands(
  program: ts.Program,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
): CommandSpec[] {
  const entry = require.resolve('atem-connection/dist/atem.d.ts')
  const file = program.getSourceFile(entry)
  if (!file) throw new Error('atem.d.ts did not load')
  const decl = file.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'Atem',
  )
  if (!decl?.name) throw new Error('class Atem not found')

  const symbol = checker.getSymbolAtLocation(decl.name)
  if (!symbol) throw new Error('class Atem has no symbol')
  const members = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))

  const out: CommandSpec[] = []
  for (const member of members) {
    const name = member.name
    if (SKIP.has(name)) continue
    if (SKIP_PREFIX.some((p) => name.startsWith(p))) continue
    if (name.startsWith('_') || name.startsWith('on') || name.startsWith('emit')) continue

    const declaration = member.declarations?.[0]
    if (!declaration) continue
    if (!ts.isMethodDeclaration(declaration) && !ts.isMethodSignature(declaration)) continue
    const signature = checker.getSignatureFromDeclaration(declaration)
    if (!signature) continue

    const spec = describe(name, signature, declaration, checker, enums)
    if (spec) out.push(spec)
  }
  out.sort((a, b) => a.id.localeCompare(b.id) || a.verb.localeCompare(b.verb))
  assertUniqueIds(out)
  return out
}

/**
 * `(id, verb)` is the address of a command, so a duplicate is not a cosmetic
 * problem: it means two different things answer to one OSC address and one
 * grammar phrase, and which one runs is down to array order. Stop rather than
 * emit a catalogue that cannot be addressed.
 */
function assertUniqueIds(commands: readonly CommandSpec[]): void {
  const seen = new Map<string, string>()
  const clashes: string[] = []
  for (const command of commands) {
    const key = `${command.verb} ${command.id}`
    const first = seen.get(key)
    if (first) clashes.push(`${key}: ${first} and ${command.method}`)
    else seen.set(key, command.method)
  }
  if (clashes.length) {
    throw new Error(`catalogue ids are not unique:\n  ${clashes.join('\n  ')}`)
  }
}

function describe(
  method: string,
  signature: ts.Signature,
  at: ts.Node,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
): CommandSpec | null {
  const params = signature.getParameters().map((p, index) => {
    const type = checker.getTypeOfSymbolAtLocation(p, at)
    const declaration = p.declarations?.[0] as ts.ParameterDeclaration | undefined
    return {
      index,
      name: p.name,
      type,
      text: checker.typeToString(type),
      optional: Boolean(declaration?.questionToken) || Boolean(declaration?.initializer),
    }
  })

  /* A props object is the parameter that is not a primitive and has members.
     Its presence is what makes every other parameter an address. */
  const propsIndex = params.findIndex((p) => isPropsObject(p.type, p.text, checker))

  const address: AddressParam[] = []
  const fields: FieldSpec[] = []
  const order: ParamRef[] = []

  for (const param of params) {
    if (param.index === propsIndex) {
      for (const field of membersOf(param.type, checker, enums, at)) fields.push(field)
      order.push({ name: param.name, kind: 'props' })
      continue
    }
    if (classify({ ...param, isString: param.text.startsWith('string') }, propsIndex >= 0, params, method)) {
      const countPath = COUNT_PATHS[param.name]
      address.push({
        name: param.name,
        type: param.text.startsWith('string') ? 'string' : 'number',
        optional: param.optional,
        ...(countPath ? { countPath } : {}),
      })
      order.push({ name: param.name, kind: 'address' })
    } else {
      fields.push(scalarField(param.name, param.type, param.text, param.optional, checker, enums))
      order.push({ name: param.name, kind: 'value' })
    }
  }

  /* A method with neither an address nor a value is still a command — `cut()`,
     `startRecording()`. Those are the triggers, and they matter most. */
  return {
    id: idOf(method),
    verb: verbOf(method).verb,
    method,
    address,
    fields,
    props: propsIndex >= 0,
    ...(propsIndex >= 0 ? { propsIndex } : {}),
    params: order,
  }
}

/**
 * Address or value.
 *
 * With a props object present, position settles it: everything outside the
 * object addresses a unit. Without one, a trailing optional parameter is an
 * address (`cut(me?)`, `changeProgramInput(input, me?)`) and so is a required
 * parameter whose name is in the vocabulary — the case
 * `runUpstreamKeyerFlyKeyTo(mixEffect, upstreamKeyerId, keyFrameId)` needs,
 * where nothing is optional and two of the three still address a unit.
 */
function classify(
  param: { name: string; index: number; optional: boolean; isString: boolean },
  hasProps: boolean,
  params: ReadonlyArray<{ optional: boolean }>,
  method: string,
): boolean {
  if (hasProps) return true
  if (param.optional && params.slice(param.index).every((p) => p.optional)) return true
  if (ADDRESS_NAMES.has(param.name)) return true
  if (ADDRESS_NAMES_STRING.has(param.name) && param.isString) return true
  /* Not an address, so it is a value. Worth saying out loud when the name
     looks like one, because a new address parameter silently becoming a value
     is exactly the drift this catalogue exists to prevent. */
  if (/^(id|num|number|idx)$/i.test(param.name)) {
    warnings.push(`${method}: parameter "${param.name}" reads like an address but is not in the vocabulary`)
  }
  return false
}

/**
 * Whether a parameter is a bag of settings rather than a single value.
 *
 * This has to be decided on type *flags*, not on the printed type. Ask a
 * `number` for its members and TypeScript answers with `Number`'s prototype —
 * `toFixed`, `toPrecision`, `toLocaleString` — and a parameter spelled
 * `Enums.FlyKeyKeyFrame.A | Enums.FlyKeyKeyFrame.B` is a union of numeric
 * literals that prints like a type name and behaves like a number. Both were
 * expanded as props objects until this checked the flags instead, which is how
 * `runUpstreamKeyerFlyKeyTo` came to offer `toFixed` as a settable value.
 */
const PRIMITIVE_FLAGS =
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.StringLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never

function isPrimitive(type: ts.Type): boolean {
  if (type.flags & PRIMITIVE_FLAGS) return true
  if (type.isUnion()) return type.types.every((t) => isPrimitive(t))
  return false
}

function isPropsObject(type: ts.Type, text: string, checker: ts.TypeChecker): boolean {
  if (isPrimitive(type)) return false
  if (isEnumLike(text)) return false
  return checker.getPropertiesOfType(type).length > 0
}

function membersOf(
  type: ts.Type,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
  at: ts.Node,
): FieldSpec[] {
  return checker.getPropertiesOfType(type).map((property) => {
    const declaration = property.declarations?.[0] ?? at
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration)
    const optional = Boolean(property.flags & ts.SymbolFlags.Optional)
    return scalarField(
      property.name,
      propertyType,
      checker.typeToString(propertyType),
      optional,
      checker,
      enums,
    )
  })
}

function scalarField(
  name: string,
  type: ts.Type,
  text: string,
  optional: boolean,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
): FieldSpec {
  const array = text.endsWith('[]')
  const bare = (array ? text.slice(0, -2) : text)
    .replace(/\s*\|\s*undefined$/, '')
    .replace(/^Enums\./, '')
    .trim()

  const members = enums[bare]
  if (members) {
    return {
      name,
      type: 'enum',
      optional,
      enum: bare,
      values: Object.keys(members),
      ...(array ? { array: true } : {}),
    }
  }
  return {
    name,
    type: primitive(bare, type, checker),
    optional,
    ...(array ? { array: true } : {}),
  }
}

function primitive(text: string, type: ts.Type, checker: ts.TypeChecker): ValueType {
  if (/^boolean/.test(text)) return 'boolean'
  if (/^string/.test(text)) return 'string'
  if (/^number/.test(text)) return 'number'
  /* A union of literals the enum table did not name is still a set of values,
     but this package will not invent a name for it — a number is honest. */
  if (type.isNumberLiteral() || (type.isUnion() && type.types.every((t) => t.isNumberLiteral()))) {
    return 'int'
  }
  return 'number'
}

function isEnumLike(text: string): boolean {
  return /^Enums\./.test(text) || /^[A-Z][A-Za-z]*$/.test(text.replace(/\[\]$/, ''))
}

/**
 * Split `setUpstreamKeyerLumaSettings` into the verb `set` and the noun
 * `usk.luma`.
 *
 * The verb has to be kept rather than discarded. Strip it and `startRecording`,
 * `stopRecording` and `setRecordingSettings` all become `recording` — three
 * different commands at one address, which is a silent collision in the OSC
 * dictionary and in the grammar alike. Seven pairs collided that way before
 * this was split out.
 *
 * A prefix only counts as a verb when something follows it, so `cut` stays the
 * noun `cut` and gets the neutral verb `do`. The noun is the id: structural,
 * stable, and what OSC and the grammar both hang off.
 */
const VERBS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^set(?=[A-Z])/, 'set'],
  [/^change(?=[A-Z])/, 'set'],
  [/^get(?=[A-Z])/, 'get'],
  [/^request(?=[A-Z])/, 'get'],
  [/^start(?=[A-Z])/, 'start'],
  [/^stop(?=[A-Z])/, 'stop'],
  [/^run(?=[A-Z])/, 'run'],
  [/^store(?=[A-Z])/, 'store'],
  [/^clear(?=[A-Z])/, 'clear'],
  [/^capture(?=[A-Z])/, 'capture'],
  [/^switch(?=[A-Z])/, 'switch'],
  [/^auto(?=[A-Z])/, 'auto'],
  [/^preview(?=[A-Z])/, 'preview'],
]

function verbOf(method: string): { verb: string; noun: string } {
  for (const [pattern, verb] of VERBS) {
    if (pattern.test(method)) return { verb, noun: method.replace(pattern, '') }
  }
  return { verb: 'do', noun: method }
}

function idOf(method: string): string {
  const { noun } = verbOf(method)
  const body = noun.replace(/^macro(?=[A-Z])/, 'macro.')
  const words = body
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  const joined = words.join('.')
  return joined
    .replace(/^classic\.audio\.(mixer\.)?/, 'audio.classic.')
    .replace(/^fairlight\.audio\.(mixer\.)?/, 'audio.fairlight.')
    .replace(/^fairlight\.mixer\./, 'audio.fairlight.')
    .replace(/^upstream\.keyer\./, 'usk.')
    .replace(/^downstream\.key(er)?\./, 'dsk.')
    .replace(/^super\.source\./, 'ssrc.')
    .replace(/^multi\.view(er)?\./, 'mv.')
    .replace(/^media\.player\./, 'media.')
    .replace(/\.settings$/, '')
    .replace(/\.properties$/, '')
    .replace(/\.props$/, '')
}

/* -- 3. the raw wire codes ----------------------------------------------- */

/**
 * The four-character codes, and how each command is constructed.
 *
 * Two passes, because neither source alone is enough. The classes are
 * enumerated at run time — that is where `rawName` and the prototype live, and
 * no amount of type reading substitutes for it. The constructor parameters and
 * the property bag are then read off the declarations and matched by class
 * name, because those exist only in the type system.
 */
function collectRaw(program: ts.Program, checker: ts.TypeChecker, enums: Record<string, Record<string, number>>): RawCommandSpec[] {
  const shapes = rawShapes(program, checker, enums)
  const out: RawCommandSpec[] = []

  for (const [className, value] of Object.entries(Commands)) {
    if (typeof value !== 'function') continue
    const cls = value as unknown as {
      rawName?: string
      minimumVersion?: number
      MaskFlags?: Record<string, number>
      prototype?: Record<string, unknown>
    }
    if (!cls.rawName) continue

    const writable = typeof cls.prototype?.serialize === 'function'
    const readable = typeof cls.prototype?.applyToState === 'function'
    /* MaskFlags is a static on the class itself, so run time answers this
       more reliably than the declarations do. */
    const maskFlags = cls.MaskFlags ? Object.keys(cls.MaskFlags) : undefined
    const shape = shapes.get(className)

    out.push({
      rawName: cls.rawName,
      className,
      kind: !writable ? 'readonly' : maskFlags ? 'masked' : 'basic',
      writable,
      readable,
      ctor: shape?.ctor ?? [],
      properties: shape?.properties ?? [],
      ...(maskFlags ? { maskFlags } : {}),
      ...(typeof cls.minimumVersion === 'number' ? { minimumVersion: cls.minimumVersion } : {}),
    })
  }
  out.sort((a, b) => a.rawName.localeCompare(b.rawName))

  /* A command with no constructor parameters and no properties is a trigger —
     `Capt`, `SRcl`, `RMDR` — and there are eight of them. Only a constructor
     that DECLARES parameters and resolved none is a failure worth hearing
     about. */
  const missing = out.filter(
    (r) => r.writable && !r.ctor.length && (shapes.get(r.className)?.declaredParams ?? 0) > 0,
  )
  if (missing.length) {
    warnings.push(
      `${missing.length} writable command(s) declare constructor parameters that did not resolve: ` +
        missing.map((r) => r.className).join(', '),
    )
  }
  return out
}

interface RawShape {
  ctor: FieldSpec[]
  properties: FieldSpec[]
  /** How many parameters the constructor declares, resolved or not. */
  declaredParams: number
}

function rawShapes(
  program: ts.Program,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
): Map<string, RawShape> {
  const out = new Map<string, RawShape>()

  for (const file of program.getSourceFiles()) {
    if (!file.fileName.includes('atem-connection/dist/commands/')) continue
    for (const statement of file.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const className = statement.name.text

      const ctor: FieldSpec[] = []
      let declaredParams = 0
      for (const member of statement.members) {
        if (!ts.isConstructorDeclaration(member)) continue
        const signature = checker.getSignatureFromDeclaration(member)
        if (!signature) continue
        declaredParams = signature.getParameters().length
        for (const parameter of signature.getParameters()) {
          const type = checker.getTypeOfSymbolAtLocation(parameter, member)
          /* A constructor taking the whole property bag contributes the bag's
             fields, not a parameter called "properties" — the raw dialect
             wants to be told field names either way. */
          if (isPropsObject(type, checker.typeToString(type), checker)) {
            for (const field of membersOf(type, checker, enums, member)) ctor.push(field)
          } else {
            ctor.push(
              scalarField(
                parameter.name,
                type,
                checker.typeToString(type),
                false,
                checker,
                enums,
              ),
            )
          }
        }
        break
      }

      out.set(className, { ctor, declaredParams, properties: propertyBag(statement, checker, enums) })
    }
  }
  return out
}

/**
 * The `T` in `BasicWritableCommand<T>` / `WritableCommand<T>`.
 *
 * Read off the heritage clause rather than off an instance, because
 * `properties` is a getter on the prototype and a getter tells you nothing
 * about its shape until something has been constructed.
 */
function propertyBag(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
): FieldSpec[] {
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    for (const base of clause.types) {
      const argument = base.typeArguments?.[0]
      if (!argument) continue
      const type = checker.getTypeAtLocation(argument)
      if (isPrimitive(type)) continue
      return membersOf(type, checker, enums, declaration)
    }
  }
  return []
}

/* -- 3b. the writable subset of the read tree ---------------------------- */

/**
 * Check the hand-written write list against everything that was generated.
 *
 * Every one of these five checks has a failure mode that is silent at run time
 * and expensive on a show, so none of them is a warning.
 */
function collectWrites(
  commands: readonly CommandSpec[],
  state: readonly StatePathSpec[],
): WritePathSpec[] {
  const paths = new Set(state.map((s) => s.path))
  const problems: string[] = []
  const out: WritePathSpec[] = []

  for (const [path, verb, id, field, ...indices] of WRITE_PATHS) {
    const where = `${path} -> ${verb} ${id}`
    if (!paths.has(path)) {
      problems.push(`${where}: no such state path`)
      continue
    }
    const command = commands.find((c) => c.id === id && c.verb === verb)
    if (!command) {
      problems.push(`${where}: no such command`)
      continue
    }
    if (!command.fields.some((f) => f.name === field)) {
      problems.push(`${where}: "${field}" is not one of its values (${command.fields.map((f) => f.name).join(', ')})`)
      continue
    }
    const slots = (path.match(/\[\]/g) ?? []).length
    if (slots !== indices.length) {
      problems.push(`${where}: path has ${slots} index slot(s) but ${indices.length} were named`)
      continue
    }
    const addresses = new Set(command.address.map((a) => a.name))
    const unknown = indices.filter((i) => !addresses.has(i))
    if (unknown.length) {
      problems.push(`${where}: ${unknown.join(', ')} not among its addresses (${[...addresses].join(', ')})`)
      continue
    }
    out.push({ path, id, verb, field, indices })
  }

  if (problems.length) {
    throw new Error(`the write-path list disagrees with the catalogue:\n  ${problems.join('\n  ')}`)
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

/* -- 4. the read tree ---------------------------------------------------- */

function collectState(
  program: ts.Program,
  checker: ts.TypeChecker,
  enums: Record<string, Record<string, number>>,
): StatePathSpec[] {
  const file = program
    .getSourceFiles()
    .find((s) => s.fileName.includes('atem-connection/dist/state/index.d.ts'))
  const decl = file?.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'AtemState',
  )
  if (!decl) throw new Error('interface AtemState not found')
  const symbol = checker.getSymbolAtLocation(decl.name)
  if (!symbol) throw new Error('AtemState has no symbol')

  const out: StatePathSpec[] = []
  const seen = new Set<string>()

  const walk = (type: ts.Type, prefix: string, depth: number): void => {
    if (depth > 6) return
    for (const property of checker.getPropertiesOfType(type)) {
      /* `__@iterator@1104` and friends: well-known symbols, not state. */
      if (property.name.startsWith('__@')) continue
      const declaration = property.declarations?.[0]
      if (!declaration) continue
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration)
      const text = checker.typeToString(propertyType)
      const path = prefix + property.name

      /* Stop at primitives BEFORE asking for members, or every `number` in the
         tree contributes `toFixed`, `toPrecision` and the rest of its
         prototype. That is what a naive walk produces, and it buries the
         real paths in about four hundred of them. */
      const leaf = leafType(text, propertyType, enums)
      if (leaf) {
        if (!seen.has(path)) {
          seen.add(path)
          out.push({ path, ...leaf })
        }
        continue
      }

      const element = elementOf(propertyType, checker)
      if (element) {
        const elementLeaf = leafType(checker.typeToString(element), element, enums)
        if (elementLeaf) {
          /* An array of primitives is one addressable path, not a subtree:
             `video.auxilliaries[]` is a source number per aux bus. */
          const arrayPath = `${path}[]`
          if (!seen.has(arrayPath)) {
            seen.add(arrayPath)
            out.push({ path: arrayPath, ...elementLeaf })
          }
        } else {
          walk(element, `${path}[].`, depth + 1)
        }
        continue
      }
      if (checker.getPropertiesOfType(propertyType).length) walk(propertyType, `${path}.`, depth + 1)
    }
  }

  walk(checker.getDeclaredTypeOfSymbol(symbol), '', 0)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

function leafType(
  text: string,
  type: ts.Type,
  enums: Record<string, Record<string, number>>,
): Omit<StatePathSpec, 'path'> | null {
  const bare = text.replace(/\s*\|\s*undefined$/, '').replace(/^Enums\./, '').trim()
  const members = enums[bare]
  if (members) return { type: 'enum', enum: bare, values: Object.keys(members) }
  if (/^boolean$/.test(bare)) return { type: 'boolean' }
  if (/^string$/.test(bare)) return { type: 'string' }
  if (/^number$/.test(bare)) return { type: 'number' }
  if (type.isNumberLiteral() || type.isStringLiteral()) return { type: 'int' }
  if (type.isUnion() && type.types.every((t) => t.isNumberLiteral())) return { type: 'int' }
  return null
}

/**
 * The element type of anything array-shaped.
 *
 * `checker.isArrayType` answers only for a plain mutable `T[]`. Most of
 * `AtemState` is `readonly T[]`, which it declines — and the walk then treated
 * the array as an ordinary object and enumerated `Array.prototype`, so the
 * catalogue grew paths like `video.superSources[].boxes.concat` and lost
 * `video.auxilliaries` entirely. The numeric index signature is the check that
 * holds for every spelling.
 */
function elementOf(type: ts.Type, checker: ts.TypeChecker): ts.Type | null {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference)
    if (args[0]) return args[0]
  }
  const name = type.getSymbol()?.getName()
  if (name === 'Array' || name === 'ReadonlyArray') {
    const args = checker.getTypeArguments(type as ts.TypeReference)
    if (args[0]) return args[0]
  }
  return checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? null
}

main()
