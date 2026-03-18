const dev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
export const API_BASE = dev ? 'http://localhost:3000' : '';

const LOG_PREFIX = '[API]';

function log(level, message, meta = {}) {
  const fn = level === 'error' ? console.error : console.log;
  fn(LOG_PREFIX, message, Object.keys(meta).length ? meta : '');
}

/** Sanitize body for logging (redact password fields) */
function sanitizeBody(body) {
  if (body == null) return undefined;
  try {
    const o = typeof body === 'string' ? JSON.parse(body) : body;
    const sanitized = { ...o };
    if ('password' in sanitized) sanitized.password = '***';
    return sanitized;
  } catch {
    return body;
  }
}

/**
 * Logged fetch: logs method, url, status, duration and optional error.
 * Use this for all API calls so they appear in the console.
 */
async function apiFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const start = performance.now();
  log('info', `${method} ${url}`, { body: options.body ? sanitizeBody(options.body) : undefined });

  // Send cookies cross-origin (e.g. Vite dev 5173 → API 3000) so session auth works
  const { expected404, ...rest } = options;
  const fetchOptions = { ...rest, credentials: 'include' };

  try {
    const res = await fetch(url, fetchOptions);
    const duration = Math.round(performance.now() - start);
    const meta = { status: res.status, duration: `${duration}ms` };
    if (!res.ok) {
      if (res.status === 404 && expected404) {
        log('info', `${method} ${url} → 404 (already gone)`, meta);
      } else {
        log('error', `${method} ${url} → ${res.status}`, meta);
      }
    } else {
      log('info', `${method} ${url} → ${res.status}`, meta);
    }
    return res;
  } catch (err) {
    const duration = Math.round(performance.now() - start);
    log('error', `${method} ${url} failed`, { duration: `${duration}ms`, error: err.message });
    throw err;
  }
}

export function getWsUrl() {
  if (dev) return 'ws://localhost:3000';
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${typeof location !== 'undefined' ? location.host : ''}`;
}

export async function checkAuth() {
  const res = await apiFetch(`${API_BASE}/api/check-auth`);
  const data = await res.json();
  return { authenticated: data.authenticated, user: data.user || null };
}

export async function getMe() {
  const res = await apiFetch(`${API_BASE}/api/me`);
  if (!res.ok) return null;
  return res.json();
}

export async function login(username, password) {
  const res = await apiFetch(`${API_BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) return { ok: false };
  const data = await res.json();
  return { ok: true, user: data.user };
}

export async function logout() {
  await apiFetch(`${API_BASE}/api/logout`, { method: 'POST' });
}

export async function getInstances() {
  const res = await apiFetch(`${API_BASE}/api/instances`);
  if (!res.ok) throw new Error('Failed to load instances');
  return res.json();
}

export async function createInstance(instanceId) {
  const res = await apiFetch(`${API_BASE}/api/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create instance');
  }
}

export async function deleteInstance(instanceId) {
  const res = await apiFetch(`${API_BASE}/api/instances/${instanceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete instance');
}

export async function getUsers() {
  const res = await apiFetch(`${API_BASE}/api/users`);
  if (!res.ok) throw new Error('Failed to load users');
  return res.json();
}

export async function createUser(username, password, role) {
  const res = await apiFetch(`${API_BASE}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create user');
  }
  return res.json();
}

export async function assignInstanceToUser(userId, instanceId) {
  const res = await apiFetch(`${API_BASE}/api/users/${userId}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId })
  });
  if (!res.ok) throw new Error('Failed to assign instance');
}

export async function removeInstanceFromUser(userId, instanceId) {
  const res = await apiFetch(`${API_BASE}/api/users/${userId}/instances/${instanceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to remove assignment');
}

export async function getInstanceUsers(instanceId) {
  const res = await apiFetch(`${API_BASE}/api/instances/${instanceId}/users`);
  if (!res.ok) throw new Error('Failed to load users');
  return res.json();
}

export async function getUserInstances(userId) {
  const res = await apiFetch(`${API_BASE}/api/users/${userId}/instances`);
  if (!res.ok) throw new Error('Failed to load assignments');
  return res.json();
}

export async function changeUserPassword(userId, password) {
  const res = await apiFetch(`${API_BASE}/api/users/${userId}/password`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to change password');
  }
}

export async function deleteUser(userId) {
  const res = await apiFetch(`${API_BASE}/api/users/${userId}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to delete user');
  }
  return { deleted: data.deleted !== false };
}

export async function getInstanceApiKey(instanceId) {
  const res = await apiFetch(`${API_BASE}/api/instances/${instanceId}/api-key`);
  if (!res.ok) throw new Error('Failed to load API key');
  const data = await res.json();
  return data.apiKey;
}

export async function regenerateInstanceApiKey(instanceId) {
  const res = await apiFetch(`${API_BASE}/api/instances/${instanceId}/api-key/regenerate`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error('Failed to regenerate API key');
  const data = await res.json();
  return data.apiKey;
}

export async function sendInstanceMessage(instanceId, to, message) {
  const res = await apiFetch(`${API_BASE}/api/instances/${instanceId}/send-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, message })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to send message');
  return data;
}

export async function getInstanceMessages(instanceId, limit = 500) {
  const url = `${API_BASE}/api/instances/${instanceId}/messages${limit ? `?limit=${limit}` : ''}`;
  const res = await apiFetch(url);
  const text = await res.text();
  if (!res.ok) {
    let errMsg = 'Failed to load message log';
    try {
      const data = JSON.parse(text);
      if (data && typeof data.error === 'string') errMsg = data.error;
    } catch {
      if (text.trimStart().startsWith('<')) errMsg = 'Session may have expired. Try logging in again.';
    }
    throw new Error(errMsg);
  }
  try {
    return JSON.parse(text);
  } catch {
    if (text.trimStart().startsWith('<')) {
      throw new Error('Server returned a page instead of data. Session may have expired — try logging in again.');
    }
    throw new Error('Invalid response from server');
  }
}

export async function clearInstanceMessages(instanceId) {
  const res = await apiFetch(`${API_BASE}/api/instances/${instanceId}/messages`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to clear message log');
  }
  return data;
}
