/**
 * The catalogue is generated, so these do not test hand-written data — they
 * test that the generator's two judgement calls still hold after an
 * `atem-connection` upgrade.
 *
 * Those calls are: which parameters address a unit rather than carry a value,
 * and which methods are commands at all. Both are decided by name against a
 * short list in `tools/generate.ts`, and both fail silently and expensively —
 * a mis-classified address does not throw, it routes the wrong bus. So the
 * cases below are the ones that caught real mistakes while it was written.
 */

import { describe, expect, it } from 'vitest'
import { CATALOGUE, command, enumValues, statePath, verbsFor } from './index.js'

describe('catalogue', () => {
  it('was generated from a real library version', () => {
    expect(CATALOGUE.library).toMatch(/^\d+\.\d+\.\d+/)
    expect(CATALOGUE.commands.length).toBeGreaterThan(100)
    expect(CATALOGUE.raw.length).toBeGreaterThan(200)
  })

  it('addresses every command uniquely by id and verb', () => {
    const seen = new Set<string>()
    for (const c of CATALOGUE.commands) {
      const key = `${c.verb} ${c.id}`
      expect(seen.has(key), `duplicate address: ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('keeps the verb, so the three recording commands stay distinct', () => {
    expect(verbsFor('recording').sort()).toEqual(['set', 'start', 'stop'])
    expect(command('recording', 'start')?.method).toBe('startRecording')
    expect(command('recording', 'stop')?.method).toBe('stopRecording')
  })

  /*
   * `source` is an address in `setFairlightAudioMixerSourceProps(index,
   * source: string, …)` and a value in `setAuxSource(source: number, bus?)`.
   * Treating it as an address in both left the routing commands with nothing
   * to route.
   */
  it('treats a numeric source as a value and a string source as an address', () => {
    const aux = command('aux.source', 'set')
    expect(aux?.address.map((a) => a.name)).toEqual(['bus'])
    expect(aux?.fields.map((f) => f.name)).toEqual(['source'])

    const fairlight = command('audio.fairlight.source', 'set')
    expect(fairlight?.address.map((a) => a.name)).toEqual(['index', 'source'])
  })

  /*
   * Ask TypeScript for the members of a `number` and it answers with Number's
   * prototype. `runUpstreamKeyerFlyKeyTo` offered `toFixed` as a settable
   * value until the generator checked type flags instead of printed names.
   */
  it('never offers a primitive prototype as a settable value', () => {
    const junk = ['toFixed', 'toString', 'valueOf', 'toPrecision', 'toLocaleString']
    for (const c of CATALOGUE.commands) {
      for (const field of c.fields) {
        expect(junk, `${c.method} offers ${field.name}`).not.toContain(field.name)
      }
    }
  })

  it('excludes the EventEmitter surface it inherits', () => {
    const names = new Set(CATALOGUE.commands.map((c) => c.method))
    for (const method of ['on', 'once', 'off', 'listenerCount', 'removeAllListeners']) {
      expect(names.has(method), `${method} is not a switcher command`).toBe(false)
    }
  })

  it('resolves enums to their member names rather than to bare integers', () => {
    expect(enumValues('TransitionStyle')).toEqual(['MIX', 'DIP', 'WIPE', 'DVE', 'STING'])
    const style = command('transition.style', 'set')
    expect(style?.fields.find((f) => f.name === 'nextStyle')?.enum).toBe('TransitionStyle')
  })

  it('bounds the addresses the switcher reports a count for', () => {
    expect(command('cut', 'do')?.address[0]).toMatchObject({
      name: 'me',
      optional: true,
      countPath: 'video.mixEffects',
    })
  })

  it('reads a concrete state path against the generated shape', () => {
    expect(statePath('video.mixEffects[].programInput')).toBeDefined()
    expect(statePath('video.mixEffects.0.programInput')).toBeDefined()
    expect(statePath('video.mixEffects.nope')).toBeUndefined()
  })

  it('carries the raw wire codes the protocol dialect needs', () => {
    const raw = CATALOGUE.raw.find((r) => r.rawName === 'CPgI')
    expect(raw?.writable).toBe(true)
  })
})
