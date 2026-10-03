// The documents of the app as published in the stores: Apple (5.1.1(i)) and Google Play want the
// privacy policy linked inside the app, and it is the publisher's policy whichever server the app
// talks to, so these are fixed rather than read from the server.
export const LEGAL_LINKS = [
  { label: 'Termos de uso', url: 'https://termhub.dev/termos/' },
  { label: 'Política de privacidade', url: 'https://termhub.dev/privacidade/' },
] as const;
