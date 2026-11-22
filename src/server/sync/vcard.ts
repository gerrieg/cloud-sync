import crypto from 'node:crypto';
import type { ContactAddress, ContactData } from '../providers/contact-types.js';

/**
 * Apple vCard 3.0 handling. A card is kept as its original lines so that a merge rewrites only
 * the properties it changes: `X-APPLE-*`, `item1.*` groups, folded base64 `PHOTO` lines and
 * group membership references pass through byte for byte.
 */

interface Line {
  /** Exactly as in the source, including folding. */
  readonly raw: string;
  readonly group: string | null;
  readonly name: string;
  readonly params: string;
  /** Unfolded, still escaped. */
  readonly value: string;
}

/**
 * The photo of a card. iCloud serves it as a link (`VALUE=uri`) that needs the account's
 * credentials; a card can also embed it (`ENCODING=b`). Exactly one of `bytes` and `url` is set.
 */
export interface CardPhoto {
  /** Changes when the photo does: a hash of the bytes, or of the whole `PHOTO` line for a link. */
  readonly key: string;
  readonly bytes: Buffer | null;
  readonly url: string | null;
}

export interface ParsedVCard {
  readonly uid: string;
  readonly isGroup: boolean;
  /** `FN`, the display name. */
  readonly name: string;
  readonly memberUids: readonly string[];
  readonly data: ContactData;
  readonly photo: CardPhoto | null;
}

const LINE = /^(?:([A-Za-z0-9-]+)\.)?([A-Za-z0-9-]+)((?:;(?:[^:";]|"[^"]*")*)*):(.*)$/s;
const MEMBER_PREFIX = /^urn:uuid:/i;

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function tokenize(text: string): { lines: Line[]; eol: string } {
  const eol = eolOf(text);
  const lines: Line[] = [];
  let raw: string | null = null;
  let value = '';
  const flush = () => {
    if (raw === null) {
      return;
    }
    const match = LINE.exec(value);
    lines.push({
      raw,
      group: match?.[1] ?? null,
      name: (match?.[2] ?? '').toUpperCase(),
      params: match?.[3] ?? '',
      value: match?.[4] ?? '',
    });
    raw = null;
  };
  for (const physical of text.split(/\r?\n/)) {
    if (physical === '') {
      continue;
    }
    if (raw !== null && /^[ \t]/.test(physical)) {
      raw += eol + physical;
      value += physical.slice(1);
    } else {
      flush();
      raw = physical;
      value = physical;
    }
  }
  flush();
  return { lines, eol };
}

function unescape(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, char: string) => (char.toLowerCase() === 'n' ? '\n' : char));
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Splits a structured value (`N`, `ORG`, `ADR`) on unescaped semicolons. */
function components(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescape);
}

function normalizeBirthday(value: string): string | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function readAddress(value: string): ContactAddress {
  const [, , street = '', city = '', region = '', postalCode = '', country = ''] = components(value);
  return { street, city, region, postalCode, country };
}

function first(lines: readonly Line[], name: string): Line | undefined {
  return lines.find((line) => line.name === name);
}

function dataOf(lines: readonly Line[]): ContactData {
  const [familyName = '', givenName = '', middleName = '', prefix = '', suffix = ''] = components(
    first(lines, 'N')?.value ?? '',
  );
  return {
    givenName,
    familyName,
    middleName,
    prefix,
    suffix,
    organization: components(first(lines, 'ORG')?.value ?? '')[0] ?? '',
    title: unescape(first(lines, 'TITLE')?.value ?? ''),
    emails: lines.filter((l) => l.name === 'EMAIL').map((l) => unescape(l.value).trim()),
    phones: lines.filter((l) => l.name === 'TEL').map((l) => unescape(l.value).trim()),
    birthday: normalizeBirthday(first(lines, 'BDAY')?.value ?? ''),
    addresses: lines.filter((l) => l.name === 'ADR').map((l) => readAddress(l.value)),
    note: unescape(first(lines, 'NOTE')?.value ?? ''),
  };
}

const sha1 = (value: string | Buffer) => crypto.createHash('sha1').update(value).digest('hex');

function photoOf(lines: readonly Line[]): CardPhoto | null {
  const photo = first(lines, 'PHOTO');
  if (!photo) {
    return null;
  }
  if (/VALUE=uri/i.test(photo.params)) {
    const url = photo.value.trim();
    return /^https:\/\//i.test(url) ? { key: sha1(`${photo.params}:${photo.value}`), bytes: null, url } : null;
  }
  if (!/ENCODING=(b|base64)/i.test(photo.params)) {
    return null;
  }
  const bytes = Buffer.from(photo.value.replace(/\s/g, ''), 'base64');
  return bytes.length > 0 ? { key: sha1(bytes), bytes, url: null } : null;
}

/** Throws when the text is not a vCard with a UID. */
export function parseVCard(text: string): ParsedVCard {
  const { lines } = tokenize(text);
  if (first(lines, 'BEGIN')?.value.toUpperCase() !== 'VCARD') {
    throw new Error('Not a vCard');
  }
  const uid = first(lines, 'UID')?.value.trim();
  if (!uid) {
    throw new Error('vCard has no UID');
  }
  return {
    uid,
    isGroup: first(lines, 'X-ADDRESSBOOKSERVER-KIND')?.value.trim().toLowerCase() === 'group',
    name: unescape(first(lines, 'FN')?.value ?? ''),
    memberUids: lines
      .filter((line) => line.name === 'X-ADDRESSBOOKSERVER-MEMBER')
      .map((line) => line.value.trim().replace(MEMBER_PREFIX, '')),
    data: dataOf(lines),
    photo: photoOf(lines),
  };
}

// ---- merging --------------------------------------------------------------------------------

const FOLD_AT = 75;

function fold(line: string, eol: string): string {
  if (line.length <= FOLD_AT) {
    return line;
  }
  const parts = [line.slice(0, FOLD_AT)];
  for (let i = FOLD_AT; i < line.length; i += FOLD_AT - 1) {
    parts.push(` ${line.slice(i, i + FOLD_AT - 1)}`);
  }
  return parts.join(eol);
}

function makeLine(name: string, params: string, value: string, group: string | null, eol: string): Line {
  const prefix = group ? `${group}.` : '';
  return { raw: fold(`${prefix}${name}${params}:${value}`, eol), group, name, params, value };
}

const digits = (value: string) => value.replace(/[^\d+]/g, '');
const addressKey = (a: ContactAddress) =>
  [a.street, a.city, a.region, a.postalCode, a.country].map((p) => p.trim().toLowerCase()).join('|');
const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** The display name (`FN`) of a contact: its name parts, else organization, else first email. */
export function displayName(data: ContactData): string {
  return (
    [data.prefix, data.givenName, data.middleName, data.familyName, data.suffix].filter(Boolean).join(' ') ||
    data.organization ||
    data.emails[0] ||
    ''
  );
}

/**
 * Applies `data` to an existing card. Only properties whose value differs are rewritten (keeping
 * their group prefix and parameters); a removed property takes the other lines of its `itemN.`
 * group (typically the `X-ABLabel`) with it. Everything else is copied through unchanged.
 */
export function mergeIntoVCard(text: string, data: ContactData): string {
  const { lines, eol } = tokenize(text);
  const current = dataOf(lines);
  let out = [...lines];

  const insertBeforeEnd = (line: Line) => {
    const end = out.map((l) => l.name).lastIndexOf('END');
    out.splice(end < 0 ? out.length : end, 0, line);
  };
  const dropGroups = (groups: Set<string | null>) => {
    out = out.filter((line) => line.group === null || !groups.has(line.group));
  };
  const setSingle = (name: string, value: string | null, newParams = '') => {
    const index = out.findIndex((l) => l.name === name);
    if (value === null || value === '') {
      if (index >= 0) {
        const { group } = out[index];
        out.splice(index, 1);
        dropGroups(new Set([group]));
      }
    } else if (index < 0) {
      insertBeforeEnd(makeLine(name, newParams, value, null, eol));
    } else if (out[index].value !== value) {
      out[index] = makeLine(name, out[index].params, value, out[index].group, eol);
    }
  };
  const syncList = <T>(
    name: string,
    desired: readonly T[],
    keyOf: (value: T) => string,
    decode: (line: Line) => T,
    encode: (value: T) => { params: string; value: string },
  ) => {
    const missing = desired.map(keyOf);
    const stale: Line[] = [];
    for (const line of out) {
      if (line.name !== name) {
        continue;
      }
      const index = missing.indexOf(keyOf(decode(line)));
      if (index >= 0) {
        missing.splice(index, 1);
      } else {
        stale.push(line);
      }
    }
    const added = desired.filter((value) => {
      const index = missing.indexOf(keyOf(value));
      if (index >= 0) {
        missing.splice(index, 1);
      }
      return index >= 0;
    });

    // A value that was merely corrected keeps its line, group and label (e.g. `item1.X-ABLabel`)
    const paired = Math.min(stale.length, added.length);
    for (let i = 0; i < paired; i += 1) {
      const line = stale[i];
      out[out.indexOf(line)] = makeLine(name, line.params, encode(added[i]).value, line.group, eol);
    }
    const removedGroups = new Set<string | null>();
    for (const line of stale.slice(paired)) {
      out.splice(out.indexOf(line), 1);
      removedGroups.add(line.group);
    }
    removedGroups.delete(null);
    dropGroups(removedGroups);
    for (const value of added.slice(paired)) {
      const { params, value: encoded } = encode(value);
      insertBeforeEnd(makeLine(name, params, encoded, null, eol));
    }
  };

  const nameFields = ['givenName', 'familyName', 'middleName', 'prefix', 'suffix'] as const;
  const namesChanged = nameFields.some((field) => current[field] !== data[field]);
  if (namesChanged) {
    const n = [data.familyName, data.givenName, data.middleName, data.prefix, data.suffix].map(escape);
    setSingle('N', n.join(';'));
  }
  const display = displayName(data);
  if (display && (namesChanged || !out.some((l) => l.name === 'FN'))) {
    setSingle('FN', escape(display));
  }

  if (current.organization !== data.organization) {
    const existing = out.find((l) => l.name === 'ORG');
    const parts = existing ? existing.value.split(/(?<!\\);/) : [];
    parts[0] = escape(data.organization);
    setSingle('ORG', data.organization === '' && parts.length <= 1 ? null : parts.join(';'));
  }
  if (current.title !== data.title) {
    setSingle('TITLE', escape(data.title));
  }
  if (current.note !== data.note) {
    setSingle('NOTE', escape(data.note));
  }
  if (current.birthday !== data.birthday) {
    setSingle('BDAY', data.birthday, ';value=date');
  }
  if (!sameKeys(current.emails.map((e) => e.toLowerCase()), data.emails.map((e) => e.toLowerCase()))) {
    syncList(
      'EMAIL',
      data.emails,
      (email) => email.trim().toLowerCase(),
      (line) => unescape(line.value),
      (email) => ({ params: ';type=INTERNET', value: escape(email) }),
    );
  }
  if (!sameKeys(current.phones.map(digits), data.phones.map(digits))) {
    syncList(
      'TEL',
      data.phones,
      digits,
      (line) => unescape(line.value),
      (phone) => ({ params: ';type=VOICE', value: escape(phone) }),
    );
  }
  if (!sameKeys(current.addresses.map(addressKey), data.addresses.map(addressKey))) {
    syncList(
      'ADR',
      data.addresses,
      addressKey,
      (line) => readAddress(line.value),
      (a) => ({
        params: ';type=HOME',
        value: `;;${[a.street, a.city, a.region, a.postalCode, a.country].map(escape).join(';')}`,
      }),
    );
  }

  return out.map((line) => line.raw).join(eol) + (/\n$/.test(text) ? eol : '');
}

/** A new Apple vCard 3.0 for a contact that only exists in Google. */
export function buildVCard(uid: string, data: ContactData): string {
  const skeleton = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//cloud-sync//EN', 'N:;;;;', `UID:${uid}`, 'END:VCARD', ''];
  const merged = mergeIntoVCard(skeleton.join('\r\n'), data);
  // vCard 3.0 requires FN, even for a contact without any name
  return /^FN[:;]/m.test(merged) ? merged : merged.replace('N:;;;;', 'N:;;;;\r\nFN:Unnamed');
}

/** Adds a member reference to a group card (once), leaving the rest of the card untouched. */
export function addGroupMember(groupVCard: string, memberUid: string): string {
  const { lines, eol } = tokenize(groupVCard);
  if (lines.some((l) => l.name === 'X-ADDRESSBOOKSERVER-MEMBER' && l.value.replace(MEMBER_PREFIX, '') === memberUid)) {
    return groupVCard;
  }
  const out = [...lines];
  const lastMember = out.map((l) => l.name).lastIndexOf('X-ADDRESSBOOKSERVER-MEMBER');
  const end = out.map((l) => l.name).lastIndexOf('END');
  out.splice(
    lastMember >= 0 ? lastMember + 1 : end < 0 ? out.length : end,
    0,
    makeLine('X-ADDRESSBOOKSERVER-MEMBER', '', `urn:uuid:${memberUid}`, null, eol),
  );
  return out.map((line) => line.raw).join(eol) + (/\n$/.test(groupVCard) ? eol : '');
}
