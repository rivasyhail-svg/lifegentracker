/**
 * Thin fetch wrapper for the LifegenTracker API.
 * All requests are same-origin; the session cookie is sent automatically.
 */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = 'lifegen_token';
// The token is kept in memory first (works even when a browser blocks storage in
// embedded/iframe contexts) and mirrored to localStorage/sessionStorage when allowed.
let memoryToken = null;
const stores = () => { const out = []; try { out.push(window.localStorage); } catch {} try { out.push(window.sessionStorage); } catch {} return out; };
export const session = {
  get: () => {
    if (memoryToken) return memoryToken;
    for (const st of stores()) { try { const t = st.getItem(TOKEN_KEY); if (t) { memoryToken = t; return t; } } catch {} }
    return null;
  },
  set: (t) => {
    memoryToken = t || null;
    for (const st of stores()) { try { t ? st.setItem(TOKEN_KEY, t) : st.removeItem(TOKEN_KEY); } catch {} }
  },
};

const REQUEST_TIMEOUT_MS = 20000;

async function request(method, url, body) {
  // X-Requested-With is required by the server for every non-GET call (CSRF defence).
  const opts = { method, headers: { 'X-Requested-With': 'LifegenTracker' }, credentials: 'same-origin' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (ctrl) opts.signal = ctrl.signal;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
  // Cookies can be blocked when the app is embedded (third-party context), so the
  // session token is also sent as a Bearer header.
  const token = session.get();
  if (token) { opts.headers.Authorization = `Bearer ${token}`; opts.headers['X-Session-Token'] = token; }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError(0, 'The server is taking too long to respond. Please try again.');
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  let data;
  try {
    data = ct.includes('application/json') ? await res.json() : await res.text();
  } catch (e) {
    throw new ApiError(res.status, 'The server sent an unreadable response. Please try again.');
  }
  if (!res.ok) {
    if (res.status === 401) { session.set(null); window.dispatchEvent(new CustomEvent('auth:expired')); }
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`, data && data.details);
  }
  return data;
}

const qs = (params = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),
  qs,

  // Auth
  status: () => request('GET', '/api/auth/status'),
  login: async (username, password) => { const r = await request('POST', '/api/auth/login', { username, password }); session.set(r.token); return r; },
  setup: async (data) => { const r = await request('POST', '/api/auth/setup', data); session.set(r.token); return r; },
  logout: async () => { try { await request('POST', '/api/auth/logout', {}); } finally { session.set(null); } },
  changePassword: (current_password, new_password) => request('POST', '/api/auth/change-password', { current_password, new_password }),

  // People
  people: (params) => request('GET', '/api/people' + qs(params)),
  person: (id) => request('GET', `/api/people/${id}`),
  createPerson: (data) => request('POST', '/api/people', data),
  updatePerson: (id, data) => request('PUT', `/api/people/${id}`, data),
  setPersonStatus: (id, status) => request('PATCH', `/api/people/${id}/status`, { status }),
  duplicates: (params) => request('GET', '/api/people/duplicates' + qs(params)),
  archivePerson: (id) => request('POST', `/api/people/${id}/archive`, {}),
  restorePerson: (id) => request('POST', `/api/people/${id}/restore`, {}),
  activity: (params) => request('GET', '/api/activity' + qs(params)),
  backup: () => request('GET', '/api/backup'),
  backupSnapshots: () => request('GET', '/api/backup/snapshots'),
  backupSnapshot: () => request('POST', '/api/backup/snapshot', {}),
  restoreBackup: (backup) => request('POST', '/api/restore', { confirm: 'RESTORE', backup }),
  updatePreferences: (id, prefs) => request('PUT', `/api/people/${id}/preferences`, prefs),
  lifegroups: (params) => request('GET', '/api/lifegroups' + qs(params)),
  lifegroup: (id) => request('GET', `/api/lifegroups/${id}`),
  lifegroupOptions: () => request('GET', '/api/lifegroups/options'),
  lifegroupNeeds: (params) => request('GET', '/api/lifegroups/needs' + qs(params)),
  lifegroupRecommend: (params) => request('GET', '/api/lifegroups/recommend' + qs(params)),
  createLifegroup: (data) => request('POST', '/api/lifegroups', data),
  updateLifegroup: (id, data) => request('PUT', `/api/lifegroups/${id}`, data),
  deleteLifegroup: (id) => request('DELETE', `/api/lifegroups/${id}`),
  assignLifegroup: (groupId, personId, extra = {}) => request('POST', `/api/lifegroups/${groupId}/members`, { person_id: personId, ...extra }),
  networks: (params) => request('GET', '/api/networks' + qs(params)),
  network: (id) => request('GET', `/api/networks/${id}`),
  createNetwork: (data) => request('POST', '/api/networks', data),
  updateNetwork: (id, data) => request('PUT', `/api/networks/${id}`, data),
  deleteNetwork: (id) => request('DELETE', `/api/networks/${id}`),
  leaveLifegroup: (groupId, personId, leftAt) => request('DELETE', `/api/lifegroups/${groupId}/members/${personId}` + qs({ left_at: leftAt })),
  deletePerson: (id) => request('DELETE', `/api/people/${id}`),

  // Services / attendance
  services: (params) => request('GET', '/api/services' + qs(params)),
  serviceByDate: (date) => request('GET', `/api/services/by-date/${date}`),
  service: (id) => request('GET', `/api/services/${id}`),
  serviceAudit: (id) => request('GET', `/api/services/${id}/audit`),
  openService: (service_date) => request('POST', '/api/services', { service_date }),
  updateService: (id, data) => request('PUT', `/api/services/${id}`, data),
  mark: (serviceId, personId, status, classification) =>
    request('PUT', `/api/services/${serviceId}/records/${personId}`, { status, classification }),
  undoMark: (serviceId, personId) => request('DELETE', `/api/services/${serviceId}/records/${personId}`),

  // Dashboard / reports / search
  dashboard: () => request('GET', '/api/dashboard'),
  reportSummary: (params) => request('GET', '/api/reports/summary' + qs(params)),
  reportYears: () => request('GET', '/api/reports/years'),
  reportLifegroups: (params) => request('GET', '/api/reports/lifegroups' + qs(params)),
  search: (q, extra = {}) => request('GET', '/api/search' + qs({ q, ...extra })),

  // Admin
  users: () => request('GET', '/api/users'),
  roles: () => request('GET', '/api/roles'),
  createUser: (data) => request('POST', '/api/users', data),
  updateUser: (id, data) => request('PUT', `/api/users/${id}`, data),
  saveSettings: (data) => request('PUT', '/api/settings', data),
  demoStatus: () => request('GET', '/api/demo'),
  demoLoad: () => request('POST', '/api/demo/load', {}),
  demoRemove: () => request('POST', '/api/demo/remove', {}),
  system: () => request('GET', '/api/system'),

  // QR self-registration (admin inbox + QR code). Server deployment only.
  registrations: (params) => request('GET', '/api/registrations' + qs(params)),
  registrationCounts: () => request('GET', '/api/registrations/counts'),
  registration: (id) => request('GET', `/api/registrations/${id}`),
  updateRegistration: (id, data) => request('PUT', `/api/registrations/${id}`, data),
  approveRegistration: (id, data = {}) => request('POST', `/api/registrations/${id}/approve`, data),
  rejectRegistration: (id, note) => request('POST', `/api/registrations/${id}/reject`, { note }),
  deleteRegistration: (id) => request('DELETE', `/api/registrations/${id}`),
  qrRegistration: () => request('GET', '/api/qr/registration'),
  /** Fetch a binary (PNG) with the session headers — cookies may be blocked when embedded. */
  blob: async (url) => {
    const headers = { 'X-Requested-With': 'LifegenTracker' };
    const token = session.get();
    if (token) { headers.Authorization = `Bearer ${token}`; headers['X-Session-Token'] = token; }
    const res = await fetch(url, { headers, credentials: 'same-origin' });
    if (!res.ok) { let msg = `Request failed (${res.status}).`; try { msg = (await res.json()).error || msg; } catch {} throw new ApiError(res.status, msg); }
    return res.blob();
  },
};
