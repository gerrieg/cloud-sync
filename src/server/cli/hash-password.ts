import { generatePasswordHash } from './secrets.js';
import { readPassword } from './read-password.js';

async function main(): Promise<void> {
  const password = await readPassword('Password: ');
  if (process.stdin.isTTY && (await readPassword('Repeat password: ')) !== password) {
    throw new Error('The passwords do not match');
  }
  const hash = await generatePasswordHash(password);
  console.error('Add this line to your .env (the single quotes keep Docker Compose from expanding the "$"):\n');
  console.log(`USER_PASSWORD_HASH='${hash}'`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
