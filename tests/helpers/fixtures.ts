import fs from 'node:fs';
import path from 'node:path';

/** Reads an Apple-style `.ics` fixture from tests/fixtures/ics. */
export function icsFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../fixtures/ics', name), 'utf8');
}

/** A minimal timed Apple event with its own UID, for tests that need many events. */
export function simpleIcs(uid: string, summary: string, day = 10): string {
  const date = `202603${String(day).padStart(2, '0')}`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apple Inc.//iOS 18.2//EN',
    'BEGIN:VEVENT',
    'DTSTAMP:20260105T090500Z',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${date}T090000Z`,
    `DTEND:${date}T100000Z`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Reads an Apple-style `.vcf` fixture from tests/fixtures/vcf. */
export function vcfFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../fixtures/vcf', name), 'utf8');
}
