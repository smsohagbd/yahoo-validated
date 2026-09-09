const YAHOO_DOMAINS = new Set([
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'yahoo.co.jp',
  'yahoo.com.au',
  'yahoo.com.br',
  'yahoo.com.mx',
  'yahoo.com.ar',
  'yahoo.com.sg',
  'yahoo.ca',
  'yahoo.de',
  'yahoo.fr',
  'yahoo.es',
  'yahoo.it',
  'yahoo.in',
  'ymail.com',
  'rocketmail.com',
  'myyahoo.com',
]);

const AOL_DOMAINS = new Set([
  'aol.com',
  'aol.co.uk',
  'aol.de',
  'aol.fr',
  'aol.in',
  'aim.com',
  'wow.com',
  'netscape.net',
  'love.com',
  'games.com',
]);

export const PROVIDERS = {
  yahoo: {
    id: 'yahoo',
    createUrl: 'https://login.yahoo.com/account/create?specId=yidregsimplified&done=https%3A%2F%2Fwww.yahoo.com',
  },
  aol: {
    id: 'aol',
    createUrl: 'https://login.aol.com/account/create?specId=yidregsimplified&done=https%3A%2F%2Fwww.aol.com',
  },
};

export function resolveProvider(domain) {
  const d = String(domain || '').toLowerCase();
  if (YAHOO_DOMAINS.has(d) || /(^|\.)yahoo\./.test(d) || d.endsWith('.yahoo.com')) {
    return PROVIDERS.yahoo;
  }
  if (AOL_DOMAINS.has(d) || /(^|\.)aol\./.test(d) || d.endsWith('.aol.com')) {
    return PROVIDERS.aol;
  }
  return null;
}

export function parseEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const match = email.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) return { error: 'invalid_email' };

  const username = match[1];
  const domain = match[2];
  const provider = resolveProvider(domain);
  if (!provider) return { error: 'unsupported_provider', email, username, domain };

  if (!/^[a-z0-9._-]{1,64}$/i.test(username)) {
    return { error: 'invalid_username', email, username, domain, provider: provider.id };
  }

  return { email, username, domain, provider: provider.id };
}
