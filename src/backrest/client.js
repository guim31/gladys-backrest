// -----------------------------------------------------------------------------
// Backrest client: the Connect RPC API its web interface uses (JSON over
// HTTP POST), checked against a real Backrest 1.14.1.
//
//   POST /v1.Backrest/GetConfig       instance name, repositories, plans (with
//                                     their schedule). Also holds the repository
//                                     passwords: only the fields needed are kept.
//   POST /v1.Backrest/GetOperations   the operation log, by plan or repository:
//                                     backups (status, summary, progress,
//                                     errors), snapshots indexed, stats…
//   POST /v1.Backrest/Backup          run a plan now. Answers only once the
//                                     backup has ended (see backup()).
//
// Authentication: HTTP Basic on every request when Backrest has users (its
// middleware accepts it next to its own JWT). No credentials when Backrest
// runs with authentication disabled.
//
// The 64-bit numbers come as strings (protobuf JSON): parsed here. Redirects
// are not followed: the password would be sent to wherever the address points.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify
  AUTH: 'auth', // credentials missing or refused
  NOT_BACKREST: 'not_backrest', // something answers, not the Backrest API
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  NOT_FOUND: 'not_found', // the plan no longer exists
  HTTP: 'http', // any other error, its message in `detail`
});

export class BackrestError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status, detail }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'BackrestError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export const MAX_BODY_BYTES = 16 * 1024 * 1024;

// Operations read per plan at every cycle: the last backups and their
// pending next run, behind the forget, index and hook operations of each run.
export const PLAN_OPERATIONS = 60;

/**
 * The one function that talks to the network (fetch). The client takes it as
 * a parameter: the tests replace it with an in-memory Backrest
 * (test/helpers/fakeBackrest.js).
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function httpRequest(url, { method = 'POST', headers = {}, body, timeoutMs } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs ?? 15_000),
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  return { status: response.status, body: await response.text() };
}

// --- Parsing ---------------------------------------------------------------------

/** An int64 of protobuf JSON (a string) or a number; null when absent or invalid. */
export function int64(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

const text = (value) => (typeof value === 'string' ? value : '');

/** A message for a person: one line, 200 characters at most. */
export function cleanMessage(value) {
  const line = text(value)
    .replace(/\s*\n\s*/g, ': ')
    .trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const HOUR_MS = 3_600_000;

/**
 * A plan schedule: a fixed period (maxFrequencyHours / maxFrequencyDays), a
 * cron expression, or nothing (disabled, or absent).
 * @returns {{ periodMs: number }|{ cron: string }|null}
 */
export function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || schedule.disabled === true) {
    return null;
  }
  const hours = int64(schedule.maxFrequencyHours);
  if (hours) {
    return { periodMs: hours * HOUR_MS };
  }
  const days = int64(schedule.maxFrequencyDays);
  if (days) {
    return { periodMs: days * 24 * HOUR_MS };
  }
  if (typeof schedule.cron === 'string' && schedule.cron.trim()) {
    return { cron: schedule.cron.trim() };
  }
  return null;
}

// Plan and repository ids of Backrest: letters, digits, "_", "-", ".".
export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** /GetConfig, reduced to what the integration uses (no password, no URI). */
export function normalizeConfig(data) {
  if (!data || typeof data !== 'object' || !('instance' in data || 'plans' in data)) {
    return null;
  }
  const repos = (Array.isArray(data.repos) ? data.repos : [])
    .filter((repo) => ID_PATTERN.test(text(repo?.id)))
    .map((repo) => ({ id: repo.id, guid: text(repo.guid) }));
  const repoIds = new Set(repos.map((repo) => repo.id));
  const plans = (Array.isArray(data.plans) ? data.plans : [])
    .filter((plan) => ID_PATTERN.test(text(plan?.id)) && repoIds.has(plan.repo))
    .map((plan) => ({
      id: plan.id,
      repo: plan.repo,
      paths: (Array.isArray(plan.paths) ? plan.paths : []).filter((p) => typeof p === 'string'),
      schedule: normalizeSchedule(plan.schedule),
    }));
  return { instance: text(data.instance), repos, plans };
}

const STATUSES = {
  STATUS_PENDING: 'pending',
  STATUS_INPROGRESS: 'running',
  STATUS_SUCCESS: 'success',
  STATUS_WARNING: 'warning',
  STATUS_ERROR: 'error',
  STATUS_SYSTEM_CANCELLED: 'cancelled',
  STATUS_USER_CANCELLED: 'cancelled',
};

const KINDS = {
  operationBackup: 'backup',
  operationIndexSnapshot: 'snapshot',
  operationForget: 'forget',
  operationPrune: 'prune',
  operationRestore: 'restore',
  operationStats: 'stats',
  operationRunHook: 'hook',
  operationCheck: 'check',
  operationRunCommand: 'command',
};

/** One operation of /GetOperations, normalized; null when unusable. */
export function normalizeOperation(op) {
  if (!op || typeof op !== 'object') {
    return null;
  }
  const id = int64(op.id);
  const begin = int64(op.unixTimeStartMs);
  const kindKey = Object.keys(KINDS).find((key) => key in op);
  if (id === null || begin === null || !kindKey) {
    return null;
  }
  const end = int64(op.unixTimeEndMs);
  const operation = {
    id,
    flowId: int64(op.flowId),
    kind: KINDS[kindKey],
    planId: text(op.planId),
    repoId: text(op.repoId),
    instanceId: text(op.instanceId),
    status: STATUSES[op.status] ?? 'unknown',
    begin,
    end: end || null,
    message: cleanMessage(op.displayMessage),
  };
  const detail = op[kindKey] && typeof op[kindKey] === 'object' ? op[kindKey] : {};
  if (operation.kind === 'backup') {
    const summary = detail.lastStatus?.summary;
    const status = detail.lastStatus?.status;
    const errors = Array.isArray(detail.errors) ? detail.errors : [];
    const percent = Number(status?.percentDone);
    operation.backup = {
      dryRun: detail.dryRun === true,
      bytesAdded: summary ? (int64(summary.dataAdded) ?? 0) : null,
      bytesProcessed: summary ? (int64(summary.totalBytesProcessed) ?? 0) : null,
      files: summary ? (int64(summary.totalFilesProcessed) ?? 0) : null,
      fileErrors: errors.length,
      firstError: errors[0]
        ? cleanMessage(`${text(errors[0].item)}: ${text(errors[0].message)}`.replace(/^: /, ''))
        : '',
      progress: Number.isFinite(percent)
        ? Math.min(100, Math.max(0, Math.floor(percent * 100)))
        : null,
    };
  } else if (operation.kind === 'snapshot') {
    operation.forgot = detail.forgot === true;
  } else if (operation.kind === 'stats') {
    operation.stats = {
      totalSize: int64(detail.stats?.totalSize),
      snapshots: int64(detail.stats?.snapshotCount),
    };
  }
  return operation;
}

/** A Connect error body, `{ code, message }`, as a short text; '' otherwise. */
function connectMessage(body) {
  try {
    return cleanMessage(JSON.parse(body)?.message);
  } catch {
    return '';
  }
}

// --- Client ------------------------------------------------------------------------

export class BackrestClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, `http(s)://host[:port][/path]`
   * @param {string} [options.username] empty when authentication is disabled
   * @param {string} [options.password]
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, username = '', password = '', request = httpRequest, timeoutMs = 20_000 }) {
    this.url = url;
    this.authorization = username
      ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      : null;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  async send(method, payload, timeoutMs) {
    try {
      return await this.request(`${this.url}/v1.Backrest/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify(payload),
        timeoutMs: timeoutMs ?? this.timeoutMs,
      });
    } catch (err) {
      const code = err.cause?.code ?? err.code;
      if (TLS_CODES.has(code)) {
        throw new BackrestError(ERROR_KINDS.TLS, `Certificate refused (${code})`);
      }
      throw new BackrestError(ERROR_KINDS.UNREACHABLE, code ?? err.name ?? err.message);
    }
  }

  /** One RPC; the JSON answer, or a BackrestError. */
  async call(method, payload = {}, { timeoutMs } = {}) {
    const response = await this.send(method, payload, timeoutMs);
    const { status } = response;
    if (status >= 300 && status < 400) {
      throw new BackrestError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if (status === 401 || status === 403) {
      throw new BackrestError(ERROR_KINDS.AUTH, `Refused (HTTP ${status})`, { status });
    }
    const detail = connectMessage(response.body);
    if (status === 404 || status === 405) {
      // A plan unknown answers a Connect error; a page unknown, a plain 404
      // (or a 405 from the web interface of Backrest under another path).
      const kind = detail && status === 404 ? ERROR_KINDS.NOT_FOUND : ERROR_KINDS.NOT_BACKREST;
      throw new BackrestError(kind, `Not found (HTTP ${status})`, { status, detail });
    }
    if (status < 200 || status >= 300) {
      throw new BackrestError(ERROR_KINDS.HTTP, `Unexpected answer (HTTP ${status})`, {
        status,
        detail,
      });
    }
    try {
      return JSON.parse(response.body);
    } catch {
      throw new BackrestError(ERROR_KINDS.NOT_BACKREST, 'The answer is not JSON');
    }
  }

  /** Instance name, repositories and plans. */
  async config() {
    const config = normalizeConfig(await this.call('GetConfig'));
    if (!config) {
      throw new BackrestError(ERROR_KINDS.NOT_BACKREST, 'The answer is not a Backrest config');
    }
    return config;
  }

  async operations(selector, lastN) {
    const data = await this.call('GetOperations', { selector, ...(lastN ? { lastN } : {}) });
    if (!data || typeof data !== 'object') {
      throw new BackrestError(ERROR_KINDS.NOT_BACKREST, 'The answer is not an operation list');
    }
    // An empty list is an empty object in protobuf JSON.
    return (Array.isArray(data.operations) ? data.operations : [])
      .map(normalizeOperation)
      .filter(Boolean);
  }

  /** The last operations of a plan, run by this instance, oldest first. */
  planOperations(planId, instanceId) {
    return this.operations({ planId, ...(instanceId ? { instanceId } : {}) }, PLAN_OPERATIONS);
  }

  /** Every operation Backrest keeps for a repository (it keeps about 30 days). */
  repoOperations(repoGuid) {
    return this.operations({ repoGuid });
  }

  /**
   * Run a plan now. Backrest answers when the backup ends (an error then
   * carries its message), so the caller decides how long it waits.
   */
  async backup(planId, { timeoutMs = 6 * HOUR_MS } = {}) {
    await this.call('Backup', { value: planId }, { timeoutMs });
  }
}
