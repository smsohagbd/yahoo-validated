const MESSAGES = {
  ok_taken: 'Address already exists',
  ok_available: 'Address does not exist yet',
  unauthorized: 'Invalid or missing API token',
  rate_limited: 'Rate limit exceeded. Slow down and retry.',
  invalid_email: 'Email format is invalid',
  unsupported_provider: 'Only Yahoo and AOL addresses are supported',
  invalid_username: 'Username contains invalid characters',
  blocked: 'Yahoo/AOL blocked the check (captcha or bot detection)',
  timeout: 'Check timed out waiting for a free browser',
  queue_timeout: 'Check timed out in the worker queue',
  check_failed: 'Browser check failed',
  proxy_failed: 'Proxy connection failed',
  shutdown: 'Service is shutting down',
  not_found: 'Unknown endpoint',
  server_misconfigured: 'API token is not configured on the server',
};

const RETRYABLE = new Set([
  'rate_limited',
  'blocked',
  'timeout',
  'queue_timeout',
  'check_failed',
  'proxy_failed',
]);

export function failMessage(code, fallback) {
  return MESSAGES[code] || fallback || 'Request failed';
}

export function envelope(payload = {}) {
  const error = payload.error || null;
  const failed = payload.fail === true || payload.ok === false;
  const ok = !failed;
  const validate = ok ? Boolean(payload.validate) : false;
  let message = payload.message;
  if (!message) {
    if (ok && validate) message = MESSAGES.ok_taken;
    else if (ok && error === 'invalid_username') message = MESSAGES.invalid_username;
    else if (ok) message = MESSAGES.ok_available;
    else message = failMessage(error, 'Request failed');
  }
  return {
    ok,
    fail: failed,
    validate,
    error,
    message,
    retryable: failed && RETRYABLE.has(error),
    email: payload.email ?? null,
    username: payload.username ?? null,
    provider: payload.provider ?? null,
    proxy: payload.proxy ?? null,
    ms: payload.ms ?? 0,
  };
}

export function send(res, payload) {
  return res.status(200).json(envelope(payload));
}
