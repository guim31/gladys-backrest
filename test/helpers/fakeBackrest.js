// -----------------------------------------------------------------------------
// An in-memory Backrest: its config and operation log rendered like the
// Connect RPC API (shapes checked against the real answers of
// test/fixtures/backrest in test/client.test.js: 64-bit numbers as strings,
// oldest operation first, `{}` for an empty list). `run()` records a backup
// the way Backrest does: the backup operation, and the snapshot it indexed
// when it succeeded (with or without warnings).
// -----------------------------------------------------------------------------

export const BASE = 'http://192.0.2.10:9898';
export const USERNAME = 'gladys';
export const PASSWORD = 'correct horse battery staple';
export const INSTANCE = 'home-server';

// Never sent to Gladys nor logged: the tests check it.
export const REPO_PASSWORD = 'restic-secret-do-not-leak';

const STATUS = {
  pending: 'STATUS_PENDING',
  running: 'STATUS_INPROGRESS',
  success: 'STATUS_SUCCESS',
  warning: 'STATUS_WARNING',
  error: 'STATUS_ERROR',
  cancelled: 'STATUS_USER_CANCELLED',
};

const json = (status, data) => ({ status, body: JSON.stringify(data) });

export class FakeBackrest {
  constructor({ auth = true, now = () => Date.now() } = {}) {
    this.auth = auth;
    this.now = now;
    /** @type {Map<string, { id: string, guid: string }>} */
    this.repos = new Map();
    /** @type {Map<string, object>} */
    this.plans = new Map();
    this.ops = [];
    this.nextId = 1;
    /** 'down': no answer; a number: that HTTP status for every request. */
    this.failure = null;
    /** A number: the HTTP status of the repository histories (a busy instance). */
    this.historyFailure = null;
    /** How Backup answers: 'hang' (until finish()), or 'error' (an error operation). */
    this.backupMode = 'hang';
    this.backupMessage = 'failed to backup: path /data/photos does not exist';
    this.started = [];
    this.requests = [];
    this.pendingBackups = [];
  }

  addRepo(id) {
    const guid = Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64);
    this.repos.set(id, { id, guid });
    return id;
  }

  /** A plan; `schedule` like the config (maxFrequencyHours, cron…), `next` its pending run. */
  addPlan(id, { repo = 'local', schedule = { maxFrequencyHours: 24 }, paths, next = null } = {}) {
    this.plans.set(id, { id, repo, paths: paths ?? [`/data/${id}`], schedule });
    if (next !== null) {
      this.op(id, 'pending', { begin: next, kind: 'operationBackup', detail: {} });
    }
  }

  op(planId, status, { begin, end = null, kind, detail, message, repo }) {
    const plan = this.plans.get(planId);
    const repoId = repo ?? plan.repo;
    const op = {
      id: String(this.nextId++),
      modno: '1',
      flowId: String(this.nextId),
      repoId,
      repoGuid: this.repos.get(repoId).guid,
      planId,
      instanceId: INSTANCE,
      status: STATUS[status],
      unixTimeStartMs: String(begin),
      ...(end !== null ? { unixTimeEndMs: String(end) } : {}),
      ...(message ? { displayMessage: message } : {}),
      [kind]: detail,
    };
    this.ops.push(op);
    return op;
  }

  /** Record a backup of `seconds`, ended at `end`. */
  run(
    planId,
    result,
    { end, seconds = 90, added = 12_345_678, errors = [], message, dryRun = false },
  ) {
    const begin = end - seconds * 1000;
    const summary =
      result === 'error'
        ? undefined
        : {
            filesNew: '2',
            dataAdded: String(added),
            totalFilesProcessed: '1200',
            totalBytesProcessed: '987654321',
            totalDuration: seconds - 0.5,
          };
    const detail = {
      ...(summary ? { lastStatus: { summary } } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    };
    const backup = this.op(planId, result, {
      begin,
      end,
      kind: 'operationBackup',
      detail,
      message:
        message ??
        (result === 'error'
          ? this.backupMessage
          : result === 'warning'
            ? 'Partial backup, some files may not have been read completely.'
            : undefined),
    });
    if (result !== 'error' && !dryRun) {
      this.op(planId, 'success', {
        begin: begin + 500,
        end,
        kind: 'operationIndexSnapshot',
        detail: { snapshot: { id: `snap${backup.id}`, paths: this.plans.get(planId).paths } },
      });
    }
    return backup;
  }

  /** A backup running since `begin`, at `percent` (0 to 1). */
  running(planId, { begin, percent = 0.25 }) {
    return this.op(planId, 'running', {
      begin,
      kind: 'operationBackup',
      detail: { lastStatus: { status: { percentDone: percent, totalBytes: '1000' } } },
    });
  }

  /** Turn a running operation into a finished one. */
  finish(op, result, { end, added = 1000 } = {}) {
    op.status = STATUS[result];
    op.unixTimeEndMs = String(end);
    op.operationBackup = { lastStatus: { summary: { dataAdded: String(added) } } };
    for (const resolve of this.pendingBackups.splice(0)) {
      resolve(json(200, {}));
    }
  }

  /** A "stats" operation of a repository. */
  stats(repoId, { at, totalSize, snapshots = 3 }) {
    const repo = this.repos.get(repoId);
    const op = {
      id: String(this.nextId++),
      repoId,
      repoGuid: repo.guid,
      planId: '_system_',
      instanceId: INSTANCE,
      status: STATUS.success,
      unixTimeStartMs: String(at),
      unixTimeEndMs: String(at + 1000),
      operationStats: {
        stats: { totalSize: String(totalSize), snapshotCount: String(snapshots) },
      },
    };
    this.ops.push(op);
  }

  /** Forget the snapshots of a plan, as a retention policy would. */
  forgetSnapshots(planId) {
    for (const op of this.ops) {
      if (op.planId === planId && op.operationIndexSnapshot) {
        op.operationIndexSnapshot.forgot = true;
      }
    }
  }

  config() {
    return {
      modno: 3,
      version: 6,
      instance: INSTANCE,
      repos: [...this.repos.values()].map((repo) => ({
        id: repo.id,
        uri: `rest:https://backup:${REPO_PASSWORD}@192.0.2.20/${repo.id}`,
        guid: repo.guid,
        password: REPO_PASSWORD,
      })),
      plans: [...this.plans.values()],
      auth: this.auth ? { users: [{ name: USERNAME, passwordBcrypt: 'JDJhJDEw' }] } : {},
    };
  }

  operations({ selector = {}, lastN }) {
    let ops = this.ops.filter(
      (op) =>
        (!selector.planId || op.planId === selector.planId) &&
        (!selector.instanceId || op.instanceId === selector.instanceId) &&
        (!selector.repoGuid || op.repoGuid === selector.repoGuid),
    );
    ops = [...ops].sort((a, b) => Number(a.id) - Number(b.id));
    if (lastN) {
      ops = ops.slice(-lastN);
    }
    return ops.length > 0 ? { operations: ops } : {};
  }

  /** The `request` seam of the client (src/backrest/client.js). */
  request = async (url, { method, headers = {}, body } = {}) => {
    const path = url.slice(BASE.length);
    const payload = body ? JSON.parse(body) : {};
    this.requests.push({ method, path, payload });
    if (this.failure === 'down') {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, body: 'Error' };
    }
    if (method !== 'POST' || !path.startsWith('/v1.Backrest/')) {
      return { status: 404, body: '404 page not found' };
    }
    const expected = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
    if (this.auth && headers.authorization !== expected) {
      return { status: 401, body: 'Unauthorized (No Authorization Header)\n' };
    }
    const method_ = path.slice('/v1.Backrest/'.length);
    if (method_ === 'GetConfig') {
      return json(200, this.config());
    }
    if (method_ === 'GetOperations') {
      if (payload.selector?.repoGuid && this.historyFailure) {
        return json(this.historyFailure, { code: 'unavailable', message: 'busy' });
      }
      return json(200, this.operations(payload));
    }
    if (method_ === 'Backup') {
      const plan = this.plans.get(payload.value);
      if (!plan) {
        return json(404, {
          code: 'not_found',
          message: `get plan "${payload.value}": plan not found`,
        });
      }
      this.started.push(plan.id);
      if (this.backupMode === 'error') {
        const now = this.now();
        this.op(plan.id, 'error', {
          begin: now,
          end: now,
          kind: 'operationBackup',
          detail: {},
          message: this.backupMessage,
        });
        return json(500, { code: 'unknown', message: this.backupMessage });
      }
      return new Promise((resolve) => this.pendingBackups.push(resolve));
    }
    return json(404, { code: 'unimplemented', message: `${method_} is not implemented` });
  };
}
