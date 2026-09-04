/**
 * What a compiled line asks the host to do.
 *
 * Kept in its own module because both the languages and the host depend on it
 * and neither should depend on the other.
 */

/** Call a method on `atem-connection`'s `Atem`. */
export interface CallOp {
  readonly kind: 'call'
  /** Which switcher in the fleet. */
  readonly device: string
  /** The method name, exactly as the library spells it. */
  readonly method: string
  /** Its arguments, in order, ready to spread. */
  readonly args: readonly unknown[]
  /** One line of plain English, for the log and the confirmation. */
  readonly describe: string
}

/**
 * Construct and send a protocol command.
 *
 * The raw dialect's output. `ctor` is spread into the constructor and
 * `properties` assigned afterwards — which is only meaningful for a `masked`
 * command, where the switcher is told which fields were meant. Send a masked
 * command with nothing assigned and it changes nothing at all, quietly, so the
 * host must set the mask flags for exactly the keys present here.
 */
export interface RawOp {
  readonly kind: 'raw'
  readonly device: string
  readonly rawName: string
  readonly className: string
  readonly ctor: readonly unknown[]
  readonly properties?: Readonly<Record<string, unknown>>
  readonly describe: string
}

export type Op = CallOp | RawOp
