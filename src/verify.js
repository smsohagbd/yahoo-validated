import { parseEmail } from './providers.js';
import { envelope } from './respond.js';

function failCode(err) {
  const code = err.code || 'check_failed';
  if (code === 'blocked') return 'blocked';
  if (code === 'queue_timeout') return 'queue_timeout';
  if (code === 'timeout') return 'timeout';
  if (code === 'proxy_failed') return 'proxy_failed';
  return 'check_failed';
}

export async function runVerify(pool, rawEmail) {
  const started = Date.now();
  const parsed = parseEmail(rawEmail);

  if (parsed.error === 'invalid_email') {
    return envelope({ ok: false, fail: true, error: 'invalid_email', ms: Date.now() - started });
  }
  if (parsed.error === 'unsupported_provider') {
    return envelope({
      ok: false,
      fail: true,
      error: 'unsupported_provider',
      email: parsed.email,
      username: parsed.username,
      ms: Date.now() - started,
    });
  }
  if (parsed.error === 'invalid_username') {
    return envelope({
      ok: true,
      validate: false,
      error: 'invalid_username',
      email: parsed.email,
      username: parsed.username,
      provider: parsed.provider,
      ms: Date.now() - started,
    });
  }

  try {
    const result = await pool.verify({ username: parsed.username, provider: parsed.provider });
    return envelope({
      ok: true,
      validate: Boolean(result.taken),
      error: result.invalid ? 'invalid_username' : null,
      email: parsed.email,
      username: parsed.username,
      provider: parsed.provider,
      proxy: result.proxy || null,
      ms: Date.now() - started,
    });
  } catch (err) {
    const error = failCode(err);
    return envelope({
      ok: false,
      fail: true,
      error,
      message: error === 'check_failed' && err.message ? `Browser check failed: ${err.message}` : undefined,
      email: parsed.email,
      username: parsed.username,
      provider: parsed.provider,
      ms: Date.now() - started,
    });
  }
}

export function splitEmails(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
