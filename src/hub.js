// -----------------------------------------------------------------------------
// The Backrest hub: the instance read on a timer of the container (the
// interval chosen in the configuration, 30 seconds while a backup runs, for
// its progress); the states of the added devices published when they change,
// the scene events fired on the backups and on the overdue plans, and the
// views the widget and the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 15 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every plan, added to Gladys or not — "a backup fails"
// spares the user one scene per device.
//
// The last backup seen of each plan is kept in /data (src/store.js): a backup
// that failed while the integration or Gladys restarted is still announced,
// once.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { BackrestClient, BackrestError, ERROR_KINDS } from './backrest/client.js';
import {
  buildPlanDevice,
  buildRepoDevice,
  buildServerDevice,
  hoursSince,
  overdueAfterMs,
  parsePlanId,
  planIds,
  planValues,
  repoIds,
  repoValues,
  serverIds,
  serverValues,
  stateOf,
} from './devices.js';
import { hostOf, normalizeConfig } from './config.js';
import { ProblemLog } from './problems.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  REPORT_TEXT,
  formatTime,
  labelled,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'backrest-hub' });

export const WIDGET_KEY = 'backrest';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
// The same as guim31/gladys-duplicati and gladys-kopia, so that scenes read alike.
export const TRIGGERS = Object.freeze({
  SUCCEEDED: 'backup_succeeded',
  FAILED: 'backup_failed',
  OVERDUE: 'backup_overdue',
});

export const HUB_TIMINGS = {
  // While a backup runs: its progress and its end, read this often.
  runningPollMs: 30_000,
  // The full history of a repository (snapshots, size, older successes) is
  // read again when a backup of one of its plans ends, and at least this often.
  historyEveryMs: 3600_000,
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // A scene action reads Backrest again when the last read is older.
  freshMs: 15_000,
  // "Start a backup": Backrest answers only when the backup ends. An error
  // within this delay (a path missing, a plan deleted) is the action's error;
  // after it, the backup runs and its end fires the scene triggers.
  startAckMs: 3000,
};

const MAX_TRANSPORTS_PER_REQUEST = 100;

/** "1.2 GB", for a scene message. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const ENDED = new Set(['success', 'warning', 'error']);
const isOk = (op) => op.status === 'success' || op.status === 'warning';

/**
 * What the full history of a repository tells: its size (last "stats"
 * operation), its snapshots, and per plan of this instance the snapshots
 * kept and the last success.
 */
export function summarizeRepo(operations, instance) {
  let stats = null;
  let snapshots = 0;
  const plans = new Map();
  const planOf = (id) => {
    if (!plans.has(id)) {
      plans.set(id, { snapshots: 0, lastSuccess: null });
    }
    return plans.get(id);
  };
  for (const op of operations) {
    const ours = !instance || op.instanceId === instance;
    if (op.kind === 'stats' && op.status === 'success' && op.stats?.totalSize !== null) {
      if (!stats || op.id > stats.id) {
        stats = op;
      }
    } else if (op.kind === 'snapshot' && !op.forgot) {
      snapshots += 1;
      if (ours) {
        planOf(op.planId).snapshots += 1;
      }
    } else if (op.kind === 'backup' && ours && isOk(op) && !op.backup.dryRun && op.end) {
      const plan = planOf(op.planId);
      plan.lastSuccess = Math.max(plan.lastSuccess ?? 0, op.end);
    }
  }
  return { sizeBytes: stats?.stats.totalSize ?? null, snapshots, plans };
}

/** The last backup that ended, as a run: result, duration, counts, message. */
export function runOf(op) {
  if (!op) {
    return null;
  }
  const fileErrors = op.backup.fileErrors;
  const result = op.status;
  return {
    id: op.id,
    result,
    begin: op.begin,
    end: op.end ?? op.begin,
    durationS: op.end ? Math.max(0, Math.round((op.end - op.begin) / 1000)) : null,
    bytesAdded: op.backup.bytesAdded,
    files: op.backup.files,
    errors: result === 'error' ? Math.max(1, fileErrors) : 0,
    warnings: result === 'warning' ? Math.max(1, fileErrors) : 0,
    message:
      result === 'error'
        ? op.message || op.backup.firstError
        : result === 'warning'
          ? op.backup.firstError || op.message
          : '',
  };
}

/**
 * The view of a plan: its last backup, its last success, whether it runs (and
 * its progress), its next run and whether it is overdue.
 */
export function viewOf(plan, operations, history, { now, overdueHours, knownSuccess = null }) {
  const backups = operations.filter((op) => op.kind === 'backup' && !op.backup.dryRun);
  const ended = backups.filter((op) => ENDED.has(op.status)).sort((a, b) => a.id - b.id);
  const running = backups.find((op) => op.status === 'running') ?? null;
  const pending = backups.filter((op) => op.status === 'pending').map((op) => op.begin);
  const lastRun = runOf(ended.at(-1));
  const candidates = ended.filter(isOk).map((op) => op.end ?? op.begin);
  const planHistory = history?.plans.get(plan.id);
  if (planHistory?.lastSuccess) {
    candidates.push(planHistory.lastSuccess);
  }
  // The last success already seen: Backrest forgets its operations after 30 days.
  if (knownSuccess !== null) {
    candidates.push(knownSuccess);
  }
  const lastSuccess = candidates.length > 0 ? Math.max(...candidates) : null;
  const view = {
    ...plan,
    lastRun,
    lastSuccess,
    running: running !== null,
    progress: running ? (running.backup.progress ?? 0) : null,
    nextRun: pending.length > 0 ? Math.min(...pending) : null,
    snapshots: history ? (planHistory?.snapshots ?? 0) : null,
  };
  const limit = overdueAfterMs(view, overdueHours);
  view.overdue = limit !== null && lastSuccess !== null && now - lastSuccess > limit;
  return view;
}

const delay = (ms) => {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

export class BackrestHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/backrest/client.js)
   * @param {boolean} [options.timers] the reading timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    // Defaults until start(): a handler reached after a failed start still
    // answers with a readable message.
    this.config = normalizeConfig({});
    this.client = null;
    this.signature = null;
    /** @type {Map<string, object>} views of the plans of the last read, by id */
    this.plans = new Map();
    /** @type {Map<string, object>} repositories of the last read, by id */
    this.repos = new Map();
    /** @type {Map<string, { signature: string, history: object, at: number }>} by repository id */
    this.histories = new Map();
    this.activeId = null;
    this.readAt = 0;
    this.error = null;
    this.polling = null;
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = { plans: {} };
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.saved = {
      url: typeof saved?.url === 'string' ? saved.url : null,
      plans: saved?.plans && typeof saved.plans === 'object' ? saved.plans : {},
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.signature !== null && this.config.language !== config.language;
    const overdueChanged = this.config.overdueHours !== config.overdueHours;
    this.config = config;
    const signature = JSON.stringify([config.url, config.username, config.password]);
    if (signature !== this.signature) {
      if (config.url && this.saved.url !== config.url) {
        // Another instance: what was seen of the previous one means nothing here.
        this.saved = { url: config.url, plans: {} };
        this.store.save(this.saved);
      }
      this.signature = signature;
      this.client = config.url
        ? new BackrestClient({
            url: config.url,
            username: config.username,
            password: config.password,
            request: this.request,
          })
        : null;
      this.plans = new Map();
      this.repos = new Map();
      this.histories = new Map();
      this.activeId = null;
      this.readAt = 0;
      this.error = null;
      this.polling = null;
    }
    if (languageChanged) {
      this.discovered = null; // new names for the Discovery tab
    }
    if (overdueChanged && this.readAt !== 0) {
      // A new threshold is not an event: the plans overdue by it are only recorded.
      for (const saved of Object.values(this.saved.plans)) {
        saved.overdue = null;
      }
    }
    try {
      if (this.client) {
        await this.pollNow({ publish: true });
      } else {
        await this.afterChanges(true, { publish: true });
      }
    } finally {
      this.schedulePoll();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    const delayMs = this.activeId ? this.timings.runningPollMs : this.config.pollIntervalMs;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.problems.recover('poll', 'Reading Backrest works again');
      } catch (err) {
        this.problems.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, delayMs);
  }

  // --- Reading Backrest --------------------------------------------------------

  /** Read the instance now and publish what changed. */
  async pollNow({ publish = false } = {}) {
    const changed = await this.poll();
    await this.afterChanges(changed, { publish });
  }

  /** Read again when the last read is older than `freshMs` (scene actions). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /**
   * Read the instance and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!this.polling) {
      const polling = this.read(this.client).finally(() => {
        // A read of a previous client must not drop the promise of the current one.
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(client) {
    let snapshot;
    try {
      snapshot = await this.fetch(client);
    } catch (err) {
      if (!(err instanceof BackrestError)) {
        throw err;
      }
      return client === this.client && this.applyFailure(err);
    }
    return client === this.client && this.applySuccess(snapshot);
  }

  /** Everything Backrest says; the repository histories read only when needed. */
  async fetch(client) {
    const config = await client.config();
    const operations = new Map();
    for (const plan of config.plans) {
      operations.set(plan.id, await client.planOperations(plan.id, config.instance));
    }
    const now = this.now();
    const histories = new Map();
    for (const repo of config.repos) {
      if (!repo.guid) {
        continue; // not initialized yet: no operation
      }
      // The last backup ended of each plan of the repository: a new one changes the history.
      const signature = JSON.stringify(
        config.plans
          .filter((plan) => plan.repo === repo.id)
          .map((plan) => [
            plan.id,
            Math.max(
              0,
              ...operations
                .get(plan.id)
                .filter((op) => op.kind !== 'backup' || ENDED.has(op.status))
                .map((op) => op.id),
            ),
          ]),
      );
      const cached = this.histories.get(repo.id);
      if (
        cached &&
        cached.signature === signature &&
        now - cached.at < this.timings.historyEveryMs
      ) {
        histories.set(repo.id, cached);
        continue;
      }
      try {
        const history = summarizeRepo(await client.repoOperations(repo.guid), config.instance);
        histories.set(repo.id, { signature, history, at: now });
      } catch (err) {
        // A busy instance: keep what was read, try again next time.
        if (!(err instanceof BackrestError) || err.kind !== ERROR_KINDS.HTTP) {
          throw err;
        }
        logger.debug(`History of ${repo.id} unreadable: ${err.message}`);
        if (cached) {
          histories.set(repo.id, { ...cached, at: 0 });
        }
      }
    }
    return { config, operations, histories };
  }

  async applySuccess({ config, operations, histories }) {
    let widgetChanged = this.error !== null || this.readAt === 0;
    if (this.error) {
      logger.info('Backrest answers again');
    }
    if (this.readAt === 0) {
      logger.info(
        `Backrest (${hostOf(this.config.url)}): ${config.plans.length} plan(s), ${config.repos.length} repository(ies)`,
      );
    }
    this.error = null;
    const now = this.now();
    this.readAt = now;
    this.histories = histories;
    this.repos = new Map(
      config.repos.map((repo) => {
        const history = histories.get(repo.id)?.history ?? null;
        return [
          repo.id,
          {
            id: repo.id,
            sizeBytes: history?.sizeBytes ?? null,
            snapshots: history ? history.snapshots : null,
          },
        ];
      }),
    );

    const next = new Map();
    let dirty = false;
    for (const plan of config.plans) {
      const view = viewOf(
        plan,
        operations.get(plan.id) ?? [],
        histories.get(plan.repo)?.history ?? null,
        {
          now,
          overdueHours: this.config.overdueHours,
          knownSuccess: this.saved.plans[plan.id]?.lastSuccess ?? null,
        },
      );
      next.set(plan.id, view);
      const previous = this.plans.get(plan.id);
      if (
        !previous ||
        stateOf(previous) !== stateOf(view) ||
        previous.lastSuccess !== view.lastSuccess ||
        (view.running && previous.progress !== view.progress)
      ) {
        widgetChanged = true;
      }
      dirty = (await this.transition(view)) || dirty;
    }
    if ([...this.plans.keys()].some((id) => !next.has(id))) {
      widgetChanged = true; // a plan deleted
    }
    this.plans = next;
    const active = [...next.values()].find((plan) => plan.running)?.id ?? null;
    if (active !== this.activeId) {
      widgetChanged = true;
    }
    this.activeId = active;
    // A plan deleted in Backrest is forgotten.
    for (const id of Object.keys(this.saved.plans)) {
      if (!next.has(id)) {
        delete this.saved.plans[id];
        dirty = true;
      }
    }
    // Written only when something changed: no wear of the SD card at every read.
    if (dirty) {
      this.saved.url = this.config.url;
      this.store.save(this.saved);
    }
    await this.publishStates();
    return widgetChanged;
  }

  applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`Backrest: ${err.message}`);
    }
    return wasError !== err.kind;
  }

  /**
   * Compare a plan with what was seen before; fire the scene events of a new
   * backup and of a plan turning overdue. The first sight of a plan only
   * records. A backup that began before the one recorded is no news (the
   * operation log of a reinstalled Backrest starts its ids again).
   * @returns {boolean} whether the saved state changed
   */
  async transition(plan) {
    const saved = this.saved.plans[plan.id];
    const run = plan.lastRun;
    if (!saved) {
      this.saved.plans[plan.id] = {
        run: run?.id ?? null,
        runAt: run?.begin ?? null,
        overdue: plan.overdue,
        lastSuccess: plan.lastSuccess,
      };
      return true;
    }
    let dirty = false;
    if (plan.lastSuccess !== null && plan.lastSuccess !== saved.lastSuccess) {
      saved.lastSuccess = plan.lastSuccess;
      dirty = true;
    }
    if (run && run.id !== saved.run && (saved.runAt === null || run.begin >= saved.runAt)) {
      saved.run = run.id;
      saved.runAt = run.begin;
      dirty = true;
      await this.fireRun(plan);
    }
    if (plan.overdue !== saved.overdue) {
      // null: the threshold changed, nothing to announce.
      if (plan.overdue && saved.overdue === false) {
        logger.info(`${plan.id} is overdue`);
        await this.fire(TRIGGERS.OVERDUE, plan, {
          hours_since_success: hoursSince(plan, this.now()),
          last_success: formatTime(plan.lastSuccess, this.config.language),
        });
      }
      saved.overdue = plan.overdue;
      dirty = true;
    }
    return dirty;
  }

  async fireRun(plan) {
    const run = plan.lastRun;
    if (run.result === 'success' || run.result === 'warning') {
      await this.fire(TRIGGERS.SUCCEEDED, plan, {
        duration_minutes: Math.round((run.durationS ?? 0) / 60),
        warnings: run.warnings,
        added: formatBytes(run.bytesAdded),
        snapshots: plan.snapshots ?? 0,
      });
    }
    if (run.result === 'error' || run.result === 'warning') {
      if (run.result === 'error') {
        logger.info(`${plan.id}: backup failed`);
      }
      await this.fire(TRIGGERS.FAILED, plan, {
        result: run.result,
        message: run.message,
        errors: run.errors,
        warnings: run.warnings,
      });
    }
  }

  async fire(key, plan, extra = {}) {
    try {
      await this.gladys.publishSceneEvent(key, {
        device: planIds(this.gladys, plan.id).device,
        plan: plan.id,
        ...extra,
      });
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  discoveredDevices() {
    const language = this.config.language;
    if (!this.client || this.readAt === 0 || this.error) {
      return null; // nothing read: keep the list Gladys has
    }
    return [
      buildServerDevice(this.gladys, language),
      ...[...this.plans.values()].map((plan) => buildPlanDevice(this.gladys, plan, language)),
      ...[...this.repos.values()].map((repo) => buildRepoDevice(this.gladys, repo, language)),
    ];
  }

  /** Publish the Discovery list when it changed (a plan added, deleted…). */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices() ?? (this.client ? null : []);
    if (devices === null) {
      return;
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Backrest, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.afterChanges(true, { publish: true });
  }

  /**
   * The user added (or updated) a device: its states sent before were dropped
   * by Gladys, and a device deleted then added again needs its badge.
   */
  async onDeviceCreated(device) {
    this.gladys.forgetPublishedStates?.(device.external_id);
    this.transports.delete(device.external_id);
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll, only if it polls anyway). */
  async pollDevice() {
    await this.pollNow();
  }

  /**
   * The states of the added devices. The SDK skips the values Gladys already
   * has (and sends an unchanged one again after `heartbeatMs`).
   */
  async publishStates() {
    if (this.readAt === 0 || this.error) {
      return;
    }
    const language = this.config.language;
    const now = this.now();
    const values = [];
    for (const plan of this.plans.values()) {
      if (this.isCreated(planIds(this.gladys, plan.id).device)) {
        values.push(...planValues(this.gladys, plan, language, now));
      }
    }
    for (const repo of this.repos.values()) {
      if (this.isCreated(repoIds(this.gladys, repo.id).device)) {
        values.push(...repoValues(this.gladys, repo));
      }
    }
    if (this.isCreated(serverIds(this.gladys).device)) {
      values.push(
        ...serverValues(this.gladys, {
          plans: [...this.plans.values()],
          active: this.activeId ? (this.plans.get(this.activeId) ?? null) : null,
        }),
      );
    }
    if (values.length === 0) {
      return;
    }
    const states = values.map(({ key: _key, ...state }) => state);
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local, or unreachable. */
  async publishTransports() {
    if (!this.client || this.readAt === 0) {
      return;
    }
    const transport = this.error ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL;
    const entries = [];
    const ids = [
      serverIds(this.gladys).device,
      ...[...this.plans.keys()].map((id) => planIds(this.gladys, id).device),
      ...[...this.repos.keys()].map((id) => repoIds(this.gladys, id).device),
    ];
    for (const externalId of ids) {
      if (this.isCreated(externalId) && this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (!this.config.urlTyped) {
      return { connected: false, message: CONNECTION_TEXT.noUrl };
    }
    if (!this.config.url) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views and commands (widget, scene actions, report) ------------------------------

  /** The plan of a device external id, null when it is not one (or no longer exists). */
  find(externalId) {
    const id = parsePlanId(this.gladys, externalId);
    return id ? (this.plans.get(id) ?? null) : null;
  }

  /** Throws the reason Backrest cannot answer, if any. */
  assertReadable() {
    const status = this.connectionStatus();
    if (!status.connected) {
      throw new Error(pick(status.message, this.config.language));
    }
  }

  /** The plan of a device, read again if stale; throws a readable error. */
  async planOf(externalId) {
    // Only the configuration first: a past error is what the read below clears.
    if (!this.client) {
      this.assertReadable();
    }
    await this.refreshIfStale();
    this.assertReadable();
    const plan = this.find(externalId);
    if (!plan) {
      throw new Error(pick(ACTION_TEXT.unknownPlan, this.config.language));
    }
    return plan;
  }

  /**
   * Run a plan now (unless disabled in the configuration). Backrest answers
   * when the backup ends: an error within `startAckMs` is the action's error,
   * later the backup is running and the scene triggers report its end.
   */
  async startBackup(plan) {
    const language = this.config.language;
    if (!this.config.allowStart) {
      throw new Error(pick(ACTION_TEXT.startDisabled, language));
    }
    const client = this.client;
    const backup = client.backup(plan.id);
    const wait = delay(this.timings.startAckMs);
    const outcome = await Promise.race([
      backup.then(
        () => null,
        (err) => err,
      ),
      wait.promise.then(() => 'running'),
    ]);
    wait.cancel();
    if (outcome === 'running') {
      backup
        .then(() => {
          if (client === this.client) {
            return this.pollNow();
          }
          return undefined;
        })
        .catch((err) => logger.debug(`Backup of ${plan.id} from Gladys: ${err.message}`));
    } else if (outcome instanceof BackrestError) {
      const reason = outcome.detail || pick(ERROR_TEXT[outcome.kind], language);
      throw new Error(labelled('Backrest', reason, language), { cause: outcome });
    } else if (outcome) {
      throw outcome;
    }
    logger.info(`${plan.id}: backup started from Gladys`);
    // Shown as running at once; read again in the background, every 30
    // seconds while it runs.
    if (outcome === 'running') {
      this.activeId = plan.id;
    }
    this.schedulePoll();
    (this.polling ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.pollNow())
      .catch((err) => logger.debug(`Read after start failed: ${err.message}`));
  }

  /** "Test the connection": read Backrest now, one line. */
  async testConnection() {
    await this.pollNow({ publish: true });
    const message = {};
    const status = this.connectionStatus();
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      if (!status.connected) {
        message[language] = pick(status.message, language);
        continue;
      }
      const plans = [...this.plans.values()];
      const parts = [text.ok, text.plans(plans.length), text.repos(this.repos.size)];
      const failed = plans.filter((plan) => plan.lastRun?.result === 'error').length;
      const overdue = plans.filter((plan) => plan.overdue).length;
      if (failed > 0) {
        parts.push(text.failed(failed));
      }
      if (overdue > 0) {
        parts.push(text.overdue(overdue));
      }
      message[language] = labelled('Backrest', parts.join(', '), language);
    }
    return message;
  }
}

export { ERROR_KINDS };
