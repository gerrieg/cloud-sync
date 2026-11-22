/** Reads a password without echoing it on a terminal, or from stdin when input is piped. */
export async function readPassword(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }

  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (settle: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      settle();
    };
    const onData = (input: string) => {
      for (const char of input) {
        if (char === '\r' || char === '\n') {
          finish(() => resolve(value));
          return;
        }
        if (char === '\u0003') {
          finish(() => reject(new Error('Aborted')));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}
