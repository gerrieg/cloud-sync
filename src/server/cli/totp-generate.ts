import { generateTotpSetup } from './secrets.js';

async function main(): Promise<void> {
  const accountName = process.argv[2] ?? process.env.USER_NAME ?? 'admin';
  const setup = generateTotpSetup({ accountName });
  console.error('Scan this QR code with your authenticator app:\n');
  console.error(await setup.renderQr());
  console.error(`Or add it manually with this URI:\n${setup.uri}\n`);
  console.error('Add this line to your .env:\n');
  console.log(`TOTP_SECRET=${setup.secret}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
