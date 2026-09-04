/**
 * Turning a resolved command into the call the host makes.
 *
 * Every language ends here, which is the point: the grammar, a state path, a
 * JSON frame and an OSC address that all mean "program input 3 on ME 1"
 * produce the identical op, and there is one place where an argument list is
 * built rather than four.
 */

import type { CommandSpec, FieldSpec } from './catalogue.js'
import { showValue } from './resolve.js'
import type { CallOp } from './ops.js'

/**
 * Assemble the argument list from the method's own signature order.
 *
 * An omitted optional address becomes `undefined`, which is what the library
 * defaults — almost always to unit 0. Trailing `undefined`s are trimmed rather
 * than passed, so a call reads in the log the way it would be written by hand.
 */
export function buildCall(
  command: CommandSpec,
  device: string,
  address: Readonly<Record<string, number | string>>,
  values: Readonly<Record<string, unknown>>,
  describe: string,
): CallOp {
  const args: unknown[] = []
  for (const parameter of command.params) {
    switch (parameter.kind) {
      case 'props':
        args.push({ ...values })
        break
      case 'address':
        args.push(address[parameter.name])
        break
      case 'value':
        args.push(values[parameter.name])
        break
    }
  }
  while (args.length && args[args.length - 1] === undefined) args.pop()

  return { kind: 'call', device, method: command.method, args, describe }
}

/**
 * One line of plain English for a command.
 *
 * Worth the trouble because it is what a confirmation and a log line show, and
 * an operator checking "is this the thing I meant" reads that rather than the
 * method name.
 */
export function describeCall(
  command: CommandSpec,
  device: string,
  address: Readonly<Record<string, number | string>>,
  values: Readonly<Record<string, unknown>>,
  fields: readonly FieldSpec[],
): string {
  const where = command.address
    .filter((a) => address[a.name] !== undefined)
    .map((a) => `${a.name} ${address[a.name]}`)
    .join(' ')

  const what = Object.keys(values)
    .map((key) => {
      const field = fields.find((f) => f.name === key)
      return field ? `${key} ${showValue(values[key], field)}` : `${key} ${String(values[key])}`
    })
    .join(', ')

  const parts = [`${command.verb} ${command.id}`, where, what].filter(Boolean)
  return `${parts.join(' ')} on ${device}`
}
