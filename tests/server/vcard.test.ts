import { describe, expect, it } from 'vitest';
import { addGroupMember, buildVCard, mergeIntoVCard, parseVCard } from '../../src/server/sync/vcard.js';
import { vcfFixture } from '../helpers/fixtures.js';

describe('Apple vCard 3.0 parsing', () => {
  it('reads the standard fields of a contact, including grouped (item1.*) properties and its photo', () => {
    const card = parseVCard(vcfFixture('apple-contact.vcf'));

    expect(card.uid).toBe('3E7A1D52-1111-4B1E-9A11-AAAAAAAAAAAA');
    expect(card.isGroup).toBe(false);
    expect(card.name).toBe('Dr. Max Karl Muster jun.');
    expect(card.data).toEqual({
      givenName: 'Max',
      familyName: 'Muster',
      middleName: 'Karl',
      prefix: 'Dr.',
      suffix: 'jun.',
      organization: 'Muster GmbH',
      title: 'Leiter',
      emails: ['max@example.com', 'max.work@example.com'],
      phones: ['+49 170 1234567', '+49 30 555 0100'],
      birthday: '1985-03-12',
      addresses: [
        { street: 'Hauptstraße 1', city: 'Berlin', region: 'BE', postalCode: '10115', country: 'Deutschland' },
      ],
      note: 'Kunde seit 2020\nZahlt pünktlich',
    });
    // The folded base64 PHOTO decodes to the original PNG
    expect(card.photo?.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('reads a contact group with its member UIDs', () => {
    const group = parseVCard(vcfFixture('apple-group.vcf'));

    expect(group).toMatchObject({
      uid: '7B0C9E11-9999-4B1E-9A11-FFFFFFFFFFFF',
      isGroup: true,
      name: 'Familie',
      memberUids: ['3E7A1D52-1111-4B1E-9A11-AAAAAAAAAAAA', '3E7A1D52-2222-4B1E-9A11-BBBBBBBBBBBB'],
    });
  });

  it('rejects data that is not a vCard with a UID', () => {
    expect(() => parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ohne UID\r\nEND:VCARD\r\n')).toThrow();
    expect(() => parseVCard('kein vcard')).toThrow();
  });
});

describe('Lossless Apple vCard 3.0 merging', () => {
  const original = vcfFixture('apple-contact.vcf');

  it('returns the card byte for byte when the data did not change, for CRLF and LF alike', () => {
    expect(mergeIntoVCard(original, parseVCard(original).data)).toBe(original);
    const lf = original.replaceAll('\r\n', '\n');
    expect(mergeIntoVCard(lf, parseVCard(lf).data)).toBe(lf);
  });

  it('rewrites only what changed and keeps every Apple-specific property untouched', () => {
    const data = parseVCard(original).data;

    const merged = mergeIntoVCard(original, {
      ...data,
      givenName: 'Maximilian',
      title: '',
      emails: ['max@example.com', 'neu@example.com'],
      note: 'Neue Notiz',
    });

    const card = parseVCard(merged);
    expect(card.name).toBe('Dr. Maximilian Karl Muster jun.');
    expect(card.data).toMatchObject({
      givenName: 'Maximilian',
      familyName: 'Muster',
      title: '',
      emails: ['max@example.com', 'neu@example.com'],
      phones: ['+49 170 1234567', '+49 30 555 0100'],
      note: 'Neue Notiz',
      birthday: '1985-03-12',
    });
    // The removed email takes its label (same item group) with it
    expect(merged).not.toContain('max.work@example.com');
    expect(merged).not.toContain('item1.X-ABLabel');
    // Everything Apple-specific, grouped properties and the folded base64 photo stay verbatim
    for (const kept of [
      'PRODID:-//Apple Inc.//iOS 18.2//EN',
      'X-SOCIALPROFILE;type=twitter;x-user=maxmuster:http://twitter.com/maxmuster',
      'X-ABADR:de',
      'REV:2026-01-05T09:00:00Z',
      'item2.TEL:+49 30 555 0100\r\nitem2.X-ABLabel:_$!<Main>!$_',
      'EMAIL;type=INTERNET;type=HOME;type=pref:max@example.com',
      'X-ABUID:3E7A1D52-1111-4B1E-9A11-AAAAAAAAAAAA\\:ABPerson',
    ]) {
      expect(merged).toContain(kept);
    }
    const photoBlock = original.slice(original.indexOf('PHOTO;'), original.indexOf('X-ABUID'));
    expect(merged).toContain(photoBlock);
  });

  it('adds fields the card did not have and keeps the original line endings', () => {
    const lf = 'BEGIN:VCARD\nVERSION:3.0\nN:Muster;Max;;;\nFN:Max Muster\nUID:u1\nEND:VCARD\n';

    const merged = mergeIntoVCard(lf, {
      ...parseVCard(lf).data,
      organization: 'ACME',
      phones: ['+49 1'],
      addresses: [{ street: 'Weg 1', city: 'Ulm', region: '', postalCode: '89073', country: 'DE' }],
      birthday: '1990-05-17',
    });

    expect(merged).not.toContain('\r');
    expect(merged.endsWith('END:VCARD\n')).toBe(true);
    expect(parseVCard(merged).data).toMatchObject({
      organization: 'ACME',
      phones: ['+49 1'],
      birthday: '1990-05-17',
      addresses: [{ street: 'Weg 1', city: 'Ulm', postalCode: '89073', country: 'DE' }],
    });
  });
});

describe('Building cards and extending groups', () => {
  it('builds a valid vCard 3.0 for a contact that only exists in Google', () => {
    const data = {
      ...parseVCard(vcfFixture('apple-contact.vcf')).data,
      note: 'Zeile 1\nZeile 2; mit, Sonderzeichen',
    };

    const text = buildVCard('NEW-UID-1', data);

    expect(text.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCARD\r\n')).toBe(true);
    expect(parseVCard(text)).toMatchObject({ uid: 'NEW-UID-1', isGroup: false, name: 'Dr. Max Karl Muster jun.', data });
  });

  it('adds a member to a group without touching anything else, and only once', () => {
    const group = vcfFixture('apple-group.vcf');

    const extended = addGroupMember(group, 'NEW-UID-1');

    expect(parseVCard(extended).memberUids).toEqual([
      '3E7A1D52-1111-4B1E-9A11-AAAAAAAAAAAA',
      '3E7A1D52-2222-4B1E-9A11-BBBBBBBBBBBB',
      'NEW-UID-1',
    ]);
    expect(extended.replace('X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:NEW-UID-1\r\n', '')).toBe(group);
    expect(addGroupMember(extended, 'NEW-UID-1')).toBe(extended);
  });
});
