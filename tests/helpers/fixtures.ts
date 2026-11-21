import fs from 'node:fs';
import path from 'node:path';

/** Reads an Apple-style `.ics` fixture from tests/fixtures/ics. */
export function icsFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../fixtures/ics', name), 'utf8');
}
