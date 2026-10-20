/**
 * Interactive, no-echo passphrase prompt for signing (09 PLM TR-PLM-16). A signing passphrase is NEVER read from the environment, a flag or stdin: an agent
 * that shares the user's shell would find it there. It is read only from a real terminal, a keystroke at a time; with no TTY it refuses (null).
 */

/** The passphrase typed at the controlling terminal, or null when stdin / stderr is not a TTY or the user cancelled (Ctrl-C / Ctrl-D, empty). */
export function ttyPassphrase(prompt: string): Promise<string | null> {
  const { stdin, stderr } = process;
  if (stdin.isTTY !== true || stderr.isTTY !== true) return Promise.resolve(null);
  return new Promise((resolve) => {
    let typed = '';
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (value: string | null): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(typed === '' ? null : typed);
        if (char === '\u0003' || char === '\u0004') return finish(null);
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on('data', onData);
  });
}
