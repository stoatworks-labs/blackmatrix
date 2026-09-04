import { Atem, Commands } from 'atem-connection';
import type { Op } from '@av/atem-lang';

/**
 * Run one compiled op against a real switcher.
 *
 * The two op kinds are two genuinely different ways in, and neither can stand
 * in for the other:
 *
 * - **`call`** invokes a method on `atem-connection`, which knows how to build
 *   and flag the right protocol command. This is what almost everything
 *   compiles to.
 * - **`raw`** constructs the protocol command itself, which is the whole point
 *   of the raw dialect: it is how you test what the switcher does with a
 *   particular message rather than what the library does with a particular
 *   method.
 *
 * ## Masked commands
 *
 * `updateProps` assigns the values *and* sets the mask bits that tell the
 * switcher which fields were meant. Doing it by hand — assigning `properties`
 * and forgetting `flag` — produces a command the switcher accepts and ignores,
 * which is the most expensive kind of nothing. The language refuses a masked
 * command with no properties before it ever gets here, and this is the other
 * half of that guarantee.
 */
export async function execute(op: Op, atem: Atem): Promise<void> {
  if (op.kind === 'call') {
    const method = (atem as unknown as Record<string, unknown>)[op.method];
    if (typeof method !== 'function') {
      throw new Error(`atem-connection has no ${op.method}() — the catalogue and the library disagree`);
    }
    await (method as (...args: unknown[]) => Promise<void>).apply(atem, [...op.args]);
    return;
  }

  const constructors = Commands as unknown as Record<string, unknown>;
  const Command = constructors[op.className];
  if (typeof Command !== 'function') {
    throw new Error(`atem-connection has no ${op.className} — the catalogue and the library disagree`);
  }

  const command = new (Command as new (...args: unknown[]) => unknown)(...op.ctor) as {
    updateProps?: (props: Record<string, unknown>) => boolean;
  };

  if (op.properties && Object.keys(op.properties).length) {
    if (typeof command.updateProps !== 'function') {
      throw new Error(`${op.rawName} takes no properties, only constructor arguments`);
    }
    command.updateProps({ ...op.properties });
  }

  await atem.sendCommand(command as Parameters<Atem['sendCommand']>[0]);
}
