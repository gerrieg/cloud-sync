import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

function timingSafeEqualStrings(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export async function verifyAdminCredentials(params: {
  username: string;
  password: string;
  expectedUsername: string;
  expectedPasswordHash: string;
}): Promise<boolean> {
  // Always execute bcrypt comparison before checking username to avoid timing leaks on unknown usernames
  const passwordValid = await bcrypt.compare(params.password, params.expectedPasswordHash);
  const usernameValid = timingSafeEqualStrings(params.username, params.expectedUsername);
  return passwordValid && usernameValid;
}
