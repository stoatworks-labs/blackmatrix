/** One place for output, so a future move to a file logger is a one-file change. */
const start = Date.now();

function stamp(): string {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1).padStart(7, ' ');
  return `[${elapsed}s]`;
}

export const log = {
  info: (message: string): void => console.log(`${stamp()} ${message}`),
  warn: (message: string): void => console.warn(`${stamp()} WARN ${message}`),
  error: (message: string): void => console.error(`${stamp()} ERROR ${message}`),
};
