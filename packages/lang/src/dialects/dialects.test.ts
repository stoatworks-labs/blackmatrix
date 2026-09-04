/**
 * The three machine languages, end to end.
 *
 * Each case is either a rule the documentation states or a mistake that was
 * made while writing them. The device fixture deliberately reports small
 * counts, because the interesting failures are at the edges of what a
 * particular switcher has rather than in the middle.
 */

import { describe, expect, it } from 'vitest'
import { run } from '../run.js'
import type { CallOp, RawOp, RunContext } from '../types.js'

/** A two-switcher fleet. The Mini has one ME; the Constellation has four. */
const fleet: RunContext = {
  devices: [
    {
      id: 'mini',
      name: 'Mini Extreme',
      counts: { 'video.mixEffects': 1, 'video.downstreamKeyers': 1, 'settings.multiViewers': 1 },
    },
    { id: 'con', name: 'Constellation', counts: { 'video.mixEffects': 4 } },
  ],
  device: 'mini',
}

const call = (result: ReturnType<typeof run>): CallOp => {
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '))
  return result.ops[0] as CallOp
}
const errorOf = (result: ReturnType<typeof run>): string => {
  if (result.ok) throw new Error('expected a failure')
  return result.errors.map((e) => e.message).join('; ')
}

describe('detection', () => {
  it('reads each shape as its own language', () => {
    expect(run('/bm/me/1/cut', fleet).language).toBe('osc')
    expect(run('{"id":"cut"}', fleet).language).toBe('json')
    expect(run('video.mixEffects.0.programInput = 3', fleet).language).toBe('state')
    expect(run('DCut mixEffect=0', fleet).language).toBe('raw')
    expect(run('Cut ME 1', fleet).language).toBe('bm')
  })

  it('honours a declared prefix even when a language is pinned', () => {
    const pinned: RunContext = { ...fleet, language: 'json' }
    const result = run('RAW DCut mixEffect=0', pinned)
    expect(result.language).toBe('raw')
    expect(result.declared).toBe(true)
  })

  it('turns guessing off when a language is pinned', () => {
    /* A payload that happens to start with a slash is a JSON error here, not
       silently an OSC command. That is the whole point of pinning. */
    const result = run('/bm/me/1/cut', { ...fleet, language: 'json' })
    expect(result.language).toBe('json')
    expect(result.ok).toBe(false)
  })

  it('falls back to the grammar, so a mistyped command gets the grammar', () => {
    expect(run('Cutt ME 1', fleet).language).toBe('bm')
  })

  /* `DCut` is a wire code and `dcut` is not. The grammar is case-insensitive,
     so the exact spelling is what keeps the two apart. */
  it('matches wire codes case-sensitively', () => {
    expect(run('DCut mixEffect=0', fleet).language).toBe('raw')
    expect(run('dcut mixEffect=0', fleet).language).toBe('bm')
  })
})

describe('state paths', () => {
  it('writes a vouched-for path', () => {
    const op = call(run('video.mixEffects.0.programInput = 3', fleet))
    expect(op).toMatchObject({ method: 'changeProgramInput', args: [3, 0], device: 'mini' })
  })

  it('accepts both index spellings', () => {
    expect(call(run('video.mixEffects[0].programInput = 3', fleet)).args).toEqual([3, 0])
    expect(call(run('video.mixEffects.0.programInput = 3', fleet)).args).toEqual([3, 0])
  })

  /*
   * The path says superSources[ssrcId].boxes[box]; the method is
   * setSuperSourceBoxSettings(props, box, ssrcId). The two orders are
   * reversed, and a derived mapping got this wrong.
   */
  it('puts reversed index orders back the way the method wants them', () => {
    const op = call(run('video.superSources.0.boxes.2.source = 5', fleet))
    expect(op.method).toBe('setSuperSourceBoxSettings')
    expect(op.args).toEqual([{ source: 5 }, 2, 0])
  })

  it('reads any leaf, including ones it cannot write', () => {
    const result = run('get recording.status.state', fleet)
    expect(result.ok && result.reads).toHaveLength(1)
    expect(result.ok && result.reads[0]?.path).toBe('recording.status.state')
  })

  it('refuses a write to a readable path by name, rather than doing nothing', () => {
    const message = errorOf(run('recording.status.state = 1', fleet))
    expect(message).toMatch(/can be read but not written/)
  })

  it('names real neighbours when a path does not exist', () => {
    expect(errorOf(run('get video.nonsense', fleet))).toMatch(/did you mean/)
  })

  it('bounds an index against what the switcher reports', () => {
    expect(errorOf(run('video.mixEffects.3.programInput = 3', fleet))).toMatch(
      /out of range on mini — it has 1/,
    )
    /* The same command is fine on the switcher that has four. */
    expect(call(run('video.mixEffects.3.programInput = 3 on con', fleet)).device).toBe('con')
  })
})

describe('raw wire codes', () => {
  it('constructs a basic command from its constructor arguments', () => {
    const op = call(run('CPgI mixEffect=0 source=3', fleet)) as unknown as RawOp
    expect(op).toMatchObject({ kind: 'raw', rawName: 'CPgI', ctor: [0, 3] })
  })

  it('takes an enum by name, and refuses one with its spellings', () => {
    const op = call(run('CTTp mixEffect=0 nextStyle=WIPE', fleet)) as unknown as RawOp
    expect(op.properties).toEqual({ nextStyle: 2 })
    expect(errorOf(run('CTTp mixEffect=0 nextStyle=SQUIGGLE', fleet))).toMatch(/MIX, DIP, WIPE/)
  })

  /*
   * A masked command with nothing assigned is sent, acknowledged and changes
   * nothing. Refusing it is the only way the operator finds out.
   */
  it('refuses a masked command with no values rather than send a silent no-op', () => {
    expect(errorOf(run('CTTp mixEffect=0', fleet))).toMatch(/would do nothing/)
  })

  it('refuses a command the switcher only sends', () => {
    expect(errorOf(run('PrgI mixEffect=0', fleet))).toMatch(/not one it accepts/)
  })

  it('names the values a code takes when given a wrong one', () => {
    expect(errorOf(run('CPgI mixEffect=0 nope=1', fleet))).toMatch(/it takes mixEffect, source/)
  })
})

describe('JSON', () => {
  it('runs the catalogue address space', () => {
    const op = call(run('{"verb":"set","id":"program.input","address":{"me":0},"values":{"input":3}}', fleet))
    expect(op).toMatchObject({ method: 'changeProgramInput', args: [3, 0] })
  })

  it('accepts the state spelling and the raw spelling too', () => {
    expect(call(run('{"path":"video.mixEffects.0.programInput","value":3}', fleet)).args).toEqual([3, 0])
    const rawOp = call(run('{"raw":"DCut","values":{"mixEffect":0}}', fleet)) as unknown as RawOp
    expect(rawOp.rawName).toBe('DCut')
  })

  it('runs an array in order', () => {
    const result = run('[{"id":"cut","verb":"do","address":{"me":0}},{"path":"video.mixEffects.0.programInput","value":2}]', fleet)
    expect(result.ok && result.ops.map((o) => (o as CallOp).method)).toEqual([
      'cut',
      'changeProgramInput',
    ])
  })

  /* Half a salvo is worse than none: the operator cannot tell which half. */
  it('fails a whole array rather than half-applying it', () => {
    const result = run('[{"id":"cut","verb":"do"},{"id":"nonsense"}]', fleet)
    expect(result.ok).toBe(false)
    expect(errorOf(result)).toMatch(/item 2/)
  })

  it('lists the verbs an id does have', () => {
    expect(errorOf(run('{"id":"recording","verb":"fly"}', fleet))).toMatch(/it takes set, start, stop/)
  })
})

describe('addressing the fleet', () => {
  it('uses the connection\'s device when none is named', () => {
    expect(call(run('DCut mixEffect=0', fleet)).device).toBe('mini')
  })

  it('routes every switcher when asked for all', () => {
    const result = run('DCut mixEffect=0 on all', fleet)
    expect(result.ok && result.ops.map((o) => o.device)).toEqual(['mini', 'con'])
  })

  /*
   * The rule that matters: an unqualified line with several switchers is
   * refused, not broadcast. Routing every switcher in the building because a
   * word was missing is not a reasonable reading of a half-typed command.
   */
  it('refuses an unqualified line when the fleet has more than one switcher', () => {
    const unpointed: RunContext = { devices: fleet.devices }
    expect(errorOf(run('DCut mixEffect=0', unpointed))).toMatch(/say which switcher/)
  })

  it('names the fleet when a switcher is not in it', () => {
    expect(errorOf(run('DCut mixEffect=0 on nowhere', fleet))).toMatch(/the fleet is mini, con/)
  })
})
