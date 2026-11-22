import type { people_v1 } from 'googleapis';
import type { ContactData, GoogleContact } from './contact-types.js';

export function fromPerson(person: people_v1.Schema$Person): GoogleContact {
  const name = person.names?.[0];
  const organization = person.organizations?.[0];
  const birthday = person.birthdays?.[0]?.date;
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  const data: ContactData = {
    givenName: name?.givenName ?? '',
    familyName: name?.familyName ?? '',
    middleName: name?.middleName ?? '',
    prefix: name?.honorificPrefix ?? '',
    suffix: name?.honorificSuffix ?? '',
    organization: organization?.name ?? '',
    title: organization?.title ?? '',
    emails: (person.emailAddresses ?? []).flatMap((e) => (e.value ? [e.value] : [])),
    phones: (person.phoneNumbers ?? []).flatMap((p) => (p.value ? [p.value] : [])),
    // A birthday without a year has no vCard-neutral form here, so it is not synced
    birthday: birthday?.year && birthday.month && birthday.day ? `${pad(birthday.year, 4)}-${pad(birthday.month, 2)}-${pad(birthday.day, 2)}` : null,
    addresses: (person.addresses ?? []).map((a) => ({
      street: a.streetAddress ?? '',
      city: a.city ?? '',
      region: a.region ?? '',
      postalCode: a.postalCode ?? '',
      country: a.country ?? '',
    })),
    note: person.biographies?.[0]?.value ?? '',
  };
  return {
    resourceName: person.resourceName ?? '',
    data,
    groupResourceNames: (person.memberships ?? []).flatMap((m) =>
      m.contactGroupMembership?.contactGroupResourceName ? [m.contactGroupMembership.contactGroupResourceName] : [],
    ),
  };
}

export function toPerson(data: ContactData): people_v1.Schema$Person {
  const [year, month, day] = (data.birthday ?? '').split('-').map(Number);
  return {
    names: [
      {
        givenName: data.givenName,
        familyName: data.familyName,
        middleName: data.middleName,
        honorificPrefix: data.prefix,
        honorificSuffix: data.suffix,
      },
    ],
    organizations: data.organization || data.title ? [{ name: data.organization, title: data.title }] : [],
    emailAddresses: data.emails.map((value) => ({ value })),
    phoneNumbers: data.phones.map((value) => ({ value })),
    birthdays: data.birthday ? [{ date: { year, month, day } }] : [],
    addresses: data.addresses.map((a) => ({
      streetAddress: a.street,
      city: a.city,
      region: a.region,
      postalCode: a.postalCode,
      country: a.country,
    })),
    biographies: data.note ? [{ value: data.note, contentType: 'TEXT_PLAIN' }] : [],
  };
}

export const membership = (resourceName: string) => ({ contactGroupMembership: { contactGroupResourceName: resourceName } });
