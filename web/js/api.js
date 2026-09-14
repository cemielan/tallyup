/**
 * Tallyup API client.
 *
 * The one place that knows how to talk to the API: base URL, auth headers,
 * the error envelope, and access-token refresh. Views call these functions
 * and never touch `fetch` themselves.
 */

const BASE = '/v1';
const STORAGE_KEY = 'tallyup.session';

/**
 * Tokens live in sessionStorage: they survive a page reload but die with the
 * tab, and they are never written to a cookie the browser would attach to
 * cross-site requests.
 *
 * This is the honest limit of a pure-JS client against a bearer-token API --
 * any script running on this page can read them. A deployment holding real
 * money data would want the refresh token in an httpOnly cookie instead,
 * which needs a server-side session endpoint the API deliberately does not
 * have (see README).
 */

/** @typedef {{id: string, email: string, displayName: string}} User */
/** @typedef {{accessToken: string, refreshToken: string, user: User}} Session */

/** @type {Session | null} */
let session = null;

/** @type {Promise<void> | null} Guards against a refresh stampede. */
let refreshing = null;

/** Fires when the session ends, so the router can send the user to sign-in. */
export const authEvents = new EventTarget();

function load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    // A private-mode browser can throw on access rather than return null.
    session = null;
  }
}

function persist() {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage being unavailable is survivable -- the session simply will not
    // outlive a reload.
  }
}

load();

export const getSession = () => session;
export const currentUser = () => session?.user ?? null;

export function setSession(next) {
  session = next;
  persist();
}

export function signOut({ silent = false } = {}) {
  session = null;
  persist();
  if (!silent) authEvents.dispatchEvent(new Event('signout'));
}

/** An error carrying the API's machine-readable code (docs/04-API-SPEC.md §5). */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages, for forms that can point at the offending input. */
  get fieldIssues() {
    const issues = /** @type {any} */ (this.details)?.issues;
    return Array.isArray(issues) ? issues : [];
  }
}

async function toError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = body?.error;
  return new ApiError(
    response.status,
    error?.code ?? 'INTERNAL_ERROR',
    error?.message ?? `Request failed with status ${response.status}`,
    error?.details,
  );
}

/**
 * @typedef {{method?: string, body?: unknown, auth?: boolean}} RequestOptions
 */

/** @param {string} path @param {RequestOptions} [options] */
async function send(path, { method = 'GET', body, auth = true } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && session) headers.Authorization = `Bearer ${session.accessToken}`;

  return fetch(BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Exchange the stored refresh token for a new session. The API rotates the
 * refresh token on every use, so the replacement must be stored or the next
 * refresh will look like a replay and revoke every session.
 */
async function refreshSession() {
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'No session');

  const response = await send('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: session.refreshToken },
    auth: false,
  });

  if (!response.ok) throw await toError(response);

  const data = await response.json();
  setSession({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: data.user,
  });
}

/**
 * Perform a request, transparently refreshing an expired access token once.
 * Access tokens last 15 minutes, so a user who leaves a tab open will hit
 * this constantly; it must be invisible when it works and sign them out
 * cleanly when it does not.
 *
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<any>}
 */
async function request(path, options = {}) {
  let response = await send(path, options);

  if (response.status === 401 && options.auth !== false && session) {
    try {
      // Concurrent calls share one refresh rather than racing to rotate the
      // token -- two rotations in flight would make the loser look stolen.
      refreshing ??= refreshSession().finally(() => {
        refreshing = null;
      });
      await refreshing;
    } catch {
      signOut();
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Sign in again.');
    }
    response = await send(path, options);
  }

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return null;
  return response.json();
}

const get = (path) => request(path);
const post = (path, body) => request(path, { method: 'POST', body });
const patch = (path, body) => request(path, { method: 'PATCH', body });
const del = (path) => request(path, { method: 'DELETE' });

/* ---------- Auth ---------- */

export async function register({ email, password, displayName }) {
  await request('/auth/register', {
    method: 'POST',
    body: { email, password, displayName },
    auth: false,
  });
  // Registration returns the user but no tokens, so sign in straight away
  // rather than making someone type their password twice.
  return login({ email, password });
}

export async function login({ email, password }) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  });
  setSession({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: data.user,
  });
  return data.user;
}

export async function logout() {
  const token = session?.refreshToken;
  try {
    if (token) await post('/auth/logout', { refreshToken: token });
  } catch {
    // The local session is going away regardless; a failed revoke is not
    // worth blocking sign-out over.
  }
  signOut({ silent: true });
}

export const getMe = () => get('/users/me');
export const updateMe = (displayName) => patch('/users/me', { displayName });

/* ---------- Groups ---------- */

export const listGroups = (page = 1, pageSize = 50) =>
  get(`/groups?page=${page}&pageSize=${pageSize}`);
export const createGroup = (name) => post('/groups', { name });
export const getGroup = (groupId) => get(`/groups/${groupId}`);
export const joinGroup = (inviteCode) => post('/groups/join', { inviteCode });
export const rotateInvite = (groupId) => post(`/groups/${groupId}/invite/rotate`);
export const removeMember = (groupId, userId) => del(`/groups/${groupId}/members/${userId}`);

/* ---------- Expenses ---------- */

export const listExpenses = (groupId, page = 1, pageSize = 20) =>
  get(`/groups/${groupId}/expenses?page=${page}&pageSize=${pageSize}`);
export const createExpense = (groupId, expense) => post(`/groups/${groupId}/expenses`, expense);
export const getExpense = (expenseId) => get(`/expenses/${expenseId}`);
export const updateExpense = (expenseId, changes) => patch(`/expenses/${expenseId}`, changes);
export const deleteExpense = (expenseId) => del(`/expenses/${expenseId}`);

/* ---------- Balances and settlements ---------- */

export const getBalances = (groupId) => get(`/groups/${groupId}/balances`);
export const getSuggested = (groupId) => get(`/groups/${groupId}/settlements/suggested`);
export const listSettlements = (groupId, page = 1, pageSize = 50) =>
  get(`/groups/${groupId}/settlements?page=${page}&pageSize=${pageSize}`);
export const proposeSettlement = (groupId, settlement) =>
  post(`/groups/${groupId}/settlements`, settlement);
export const confirmSettlement = (settlementId) => post(`/settlements/${settlementId}/confirm`);
export const declineSettlement = (settlementId) => post(`/settlements/${settlementId}/decline`);
