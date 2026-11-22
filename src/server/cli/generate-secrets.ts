import { generateAppSecrets } from './secrets.js';

const { sessionSecret, encryptionKey } = generateAppSecrets();
console.error('Add these lines to your .env. Keep ENCRYPTION_KEY safe: losing it makes stored credentials unreadable.\n');
console.log(`SESSION_SECRET=${sessionSecret}`);
console.log(`ENCRYPTION_KEY=${encryptionKey}`);
