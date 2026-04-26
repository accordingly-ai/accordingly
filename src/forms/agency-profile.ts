export const AGENCY_PROFILE = {
  name: 'alex',
  streetAddress: '1234 main st',
  city: 'sunnyvale',
  state: 'ca',
  zip: '94085',
  phone: '1234567890',
  fax: '',
  email: '',
  code: '12345678',
} as const;

export const AGENCY_FIELD_MAP: Record<
  string,
  Partial<Record<keyof typeof AGENCY_PROFILE, string[]>>
> = {
  'acord-125': {
    name: ['agency-name', 'agency-name-2', 'agency-name-3'],
    streetAddress: [
      'agency-street-address',
      'agency-street-address-2',
      'agency-street-address-3',
    ],
    city: ['agency-city', 'agency-city-2', 'agency-city-3'],
    state: ['agency-state', 'agency-state-2', 'agency-state-3'],
    zip: ['agency-zip', 'agency-zip-2', 'agency-zip-3'],
    phone: ['agency-phone', 'agency-phone-2', 'agency-phone-3'],
    fax: ['agency-fax', 'agency-fax-2', 'agency-fax-3'],
    email: ['agency-email'],
    code: ['agency-code'],
  },
};
