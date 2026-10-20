// -----------------------------------------------------------------------------
// The view of a Backrest plan (what Backrest says, put together by src/hub.js)
// and the Gladys devices, proposed in the Discovery tab (the user adds the
// ones to follow, nothing is created on their behalf):
//
//   - one device per plan, identified by its Backrest id:
//       state                text/text      "OK", "Failed", "Overdue"… (the
//                                           language of the configuration)
//       last_success         text/text      day/month hours:minutes
//       hours_since_success  duration/integer (h)
//       last_duration        duration/integer (s)   of the last backup
//       bytes_added          data/size (MB)         added by the last backup
//       snapshots            counter-sensor/integer snapshots of the plan kept
//       errors, warnings     counter-sensor/integer of the last backup
//       running              input/binary   1 while this plan backs up
//       next_run             text/text      next scheduled backup, "-" if none
//
//   - one device per repository: its size (from the last "stats" operation of
//     Backrest) and the snapshots it holds;
//
//   - one "Backrest" device for the instance: a backup running, its progress,
//     its plan, and the number of plans failed and overdue.
//
// Published with should_poll: false: the integration reads Backrest on its
// own timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { ID_PATTERN } from './backrest/client.js';
import { cronPeriodMs } from './cron.js';
import { STATE_TEXT, formatTime, pick } from './texts.js';

export const PLAN_TYPE = 'plan';
export const REPO_TYPE = 'repo';
export const SERVER_TYPE = 'server';
export const SERVER_ID = 'main';
export const MODEL = 'Backrest';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  STATE: 'state',
  LAST_SUCCESS: 'last_success',
  HOURS_SINCE_SUCCESS: 'hours_since_success',
  LAST_DURATION: 'last_duration',
  BYTES_ADDED: 'bytes_added',
  SNAPSHOTS: 'snapshots',
  ERRORS: 'errors',
  WARNINGS: 'warnings',
  RUNNING: 'running',
  NEXT_RUN: 'next_run',
});

export const REPO_KEYS = Object.freeze({
  SIZE: 'size',
  SNAPSHOTS: 'snapshots',
});

export const SERVER_KEYS = Object.freeze({
  RUNNING: 'running',
  PROGRESS: 'progress',
  CURRENT_PLAN: 'current_plan',
  FAILED: 'plans_failed',
  OVERDUE: 'plans_overdue',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.STATE]: 'State',
    [FEATURE_KEYS.LAST_SUCCESS]: 'Last successful backup',
    [FEATURE_KEYS.HOURS_SINCE_SUCCESS]: 'Hours since last success',
    [FEATURE_KEYS.LAST_DURATION]: 'Last backup duration',
    [FEATURE_KEYS.BYTES_ADDED]: 'Data added by the last backup',
    [FEATURE_KEYS.SNAPSHOTS]: 'Snapshots',
    [FEATURE_KEYS.ERRORS]: 'Errors of the last backup',
    [FEATURE_KEYS.WARNINGS]: 'Warnings of the last backup',
    [FEATURE_KEYS.RUNNING]: 'Running',
    [FEATURE_KEYS.NEXT_RUN]: 'Next scheduled backup',
    [`repo_${REPO_KEYS.SIZE}`]: 'Repository size',
    [`repo_${REPO_KEYS.SNAPSHOTS}`]: 'Snapshots',
    [`server_${SERVER_KEYS.RUNNING}`]: 'Backup running',
    [SERVER_KEYS.PROGRESS]: 'Progress',
    [SERVER_KEYS.CURRENT_PLAN]: 'Current plan',
    [SERVER_KEYS.FAILED]: 'Failed plans',
    [SERVER_KEYS.OVERDUE]: 'Overdue plans',
  },
  fr: {
    [FEATURE_KEYS.STATE]: 'État',
    [FEATURE_KEYS.LAST_SUCCESS]: 'Dernière sauvegarde réussie',
    [FEATURE_KEYS.HOURS_SINCE_SUCCESS]: 'Heures depuis la dernière réussite',
    [FEATURE_KEYS.LAST_DURATION]: 'Durée de la dernière sauvegarde',
    [FEATURE_KEYS.BYTES_ADDED]: 'Données ajoutées (dernière sauvegarde)',
    [FEATURE_KEYS.SNAPSHOTS]: 'Instantanés',
    [FEATURE_KEYS.ERRORS]: 'Erreurs de la dernière sauvegarde',
    [FEATURE_KEYS.WARNINGS]: 'Avertissements de la dernière sauvegarde',
    [FEATURE_KEYS.RUNNING]: 'En cours',
    [FEATURE_KEYS.NEXT_RUN]: 'Prochaine sauvegarde planifiée',
    [`repo_${REPO_KEYS.SIZE}`]: 'Taille du dépôt',
    [`repo_${REPO_KEYS.SNAPSHOTS}`]: 'Instantanés',
    [`server_${SERVER_KEYS.RUNNING}`]: 'Sauvegarde en cours',
    [SERVER_KEYS.PROGRESS]: 'Progression',
    [SERVER_KEYS.CURRENT_PLAN]: 'Plan actuel',
    [SERVER_KEYS.FAILED]: 'Plans en échec',
    [SERVER_KEYS.OVERDUE]: 'Plans en retard',
  },
  de: {
    [FEATURE_KEYS.STATE]: 'Zustand',
    [FEATURE_KEYS.LAST_SUCCESS]: 'Letzte erfolgreiche Sicherung',
    [FEATURE_KEYS.HOURS_SINCE_SUCCESS]: 'Stunden seit letztem Erfolg',
    [FEATURE_KEYS.LAST_DURATION]: 'Dauer der letzten Sicherung',
    [FEATURE_KEYS.BYTES_ADDED]: 'Von der letzten Sicherung hinzugefügt',
    [FEATURE_KEYS.SNAPSHOTS]: 'Snapshots',
    [FEATURE_KEYS.ERRORS]: 'Fehler der letzten Sicherung',
    [FEATURE_KEYS.WARNINGS]: 'Warnungen der letzten Sicherung',
    [FEATURE_KEYS.RUNNING]: 'Läuft',
    [FEATURE_KEYS.NEXT_RUN]: 'Nächste geplante Sicherung',
    [`repo_${REPO_KEYS.SIZE}`]: 'Repository-Größe',
    [`repo_${REPO_KEYS.SNAPSHOTS}`]: 'Snapshots',
    [`server_${SERVER_KEYS.RUNNING}`]: 'Sicherung läuft',
    [SERVER_KEYS.PROGRESS]: 'Fortschritt',
    [SERVER_KEYS.CURRENT_PLAN]: 'Aktueller Plan',
    [SERVER_KEYS.FAILED]: 'Fehlgeschlagene Pläne',
    [SERVER_KEYS.OVERDUE]: 'Überfällige Pläne',
  },
  es: {
    [FEATURE_KEYS.STATE]: 'Estado',
    [FEATURE_KEYS.LAST_SUCCESS]: 'Última copia correcta',
    [FEATURE_KEYS.HOURS_SINCE_SUCCESS]: 'Horas desde el último éxito',
    [FEATURE_KEYS.LAST_DURATION]: 'Duración de la última copia',
    [FEATURE_KEYS.BYTES_ADDED]: 'Datos añadidos por la última copia',
    [FEATURE_KEYS.SNAPSHOTS]: 'Instantáneas',
    [FEATURE_KEYS.ERRORS]: 'Errores de la última copia',
    [FEATURE_KEYS.WARNINGS]: 'Avisos de la última copia',
    [FEATURE_KEYS.RUNNING]: 'En ejecución',
    [FEATURE_KEYS.NEXT_RUN]: 'Próxima copia programada',
    [`repo_${REPO_KEYS.SIZE}`]: 'Tamaño del repositorio',
    [`repo_${REPO_KEYS.SNAPSHOTS}`]: 'Instantáneas',
    [`server_${SERVER_KEYS.RUNNING}`]: 'Copia en curso',
    [SERVER_KEYS.PROGRESS]: 'Progreso',
    [SERVER_KEYS.CURRENT_PLAN]: 'Plan actual',
    [SERVER_KEYS.FAILED]: 'Planes fallidos',
    [SERVER_KEYS.OVERDUE]: 'Planes con retraso',
  },
};

// Display bounds (the core never applies them on write).
export const MAX_HOURS = 100_000;
export const MAX_DURATION_S = 7 * 24 * 3600;
export const MAX_SIZE_MB = 1_000_000_000;
export const MAX_COUNT = 1_000_000;
export const MAX_PLANS = 10_000;

const HOUR_MS = 3_600_000;

/** The nominal period of a plan schedule in ms, null without a usable one. */
export function periodOf(plan) {
  const schedule = plan.schedule;
  if (!schedule) {
    return null;
  }
  return schedule.periodMs ?? cronPeriodMs(schedule.cron);
}

/**
 * How long without a success makes a plan overdue, in ms; null when it cannot
 * be overdue. Automatic: the longest gap of its schedule plus a quarter of it
 * (an hour at least), the margin Backrest itself gives its dashboard. A plan
 * without schedule is overdue only with a fixed threshold.
 */
export function overdueAfterMs(plan, overdueHours) {
  if (overdueHours) {
    return overdueHours * HOUR_MS;
  }
  const period = periodOf(plan);
  return period ? period + Math.max(HOUR_MS, period / 4) : null;
}

/**
 * The state of a plan, by what needs attention first.
 * @returns {'running'|'failed'|'overdue'|'warning'|'ok'|'never'}
 */
export function stateOf(plan) {
  if (plan.running) {
    return 'running';
  }
  if (plan.lastRun?.result === 'error') {
    return 'failed';
  }
  if (plan.overdue) {
    return 'overdue';
  }
  if (plan.lastRun?.result === 'warning') {
    return 'warning';
  }
  return plan.lastSuccess !== null || plan.lastRun ? 'ok' : 'never';
}

/** Whole hours since the last success, null if none. */
export const hoursSince = (plan, now) =>
  plan.lastSuccess === null ? null : Math.max(0, Math.floor((now - plan.lastSuccess) / HOUR_MS));

export const planIds = (gladys, id) => gladys.externalIds(PLAN_TYPE, id);
export const repoIds = (gladys, id) => gladys.externalIds(REPO_TYPE, id);
export const serverIds = (gladys) => gladys.externalIds(SERVER_TYPE, SERVER_ID);

/** The plan id of a device external id, null when it is not a plan of ours. */
export function parsePlanId(gladys, externalId) {
  const prefix = planIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const id = externalId.slice(prefix.length);
  return ID_PATTERN.test(id) ? id : null;
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const text = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.TEXT, DEVICE_FEATURE_TYPES.TEXT.TEXT, {
    keep_history: false,
    min: 0,
    max: 0,
  });

const counter = (name, externalId, max) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max },
  );

const binary = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.INPUT, DEVICE_FEATURE_TYPES.SENSOR.BINARY, {
    keep_history: true,
    min: 0,
    max: 1,
  });

const duration = (name, externalId, unit, max) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.DURATION,
    DEVICE_FEATURE_TYPES.DURATION.INTEGER,
    { unit, keep_history: true, min: 0, max },
  );

const size = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.DATA, DEVICE_FEATURE_TYPES.DATA.SIZE, {
    unit: DEVICE_FEATURE_UNITS.MEGABYTE,
    keep_history: true,
    min: 0,
    max: MAX_SIZE_MB,
  });

/** The discovery payload of a plan. */
export function buildPlanDevice(gladys, plan, language = 'en') {
  const ids = planIds(gladys, plan.id);
  const names = NAMES[language] ?? NAMES.en;
  const name = (key) => names[key];
  return {
    name: plan.id,
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [
      { name: 'REPOSITORY', value: plan.repo },
      ...(plan.paths.length > 0
        ? [{ name: 'PATHS', value: plan.paths.join(', ').slice(0, 255) }]
        : []),
    ],
    features: [
      text(name(FEATURE_KEYS.STATE), ids.feature(FEATURE_KEYS.STATE)),
      text(name(FEATURE_KEYS.LAST_SUCCESS), ids.feature(FEATURE_KEYS.LAST_SUCCESS)),
      duration(
        name(FEATURE_KEYS.HOURS_SINCE_SUCCESS),
        ids.feature(FEATURE_KEYS.HOURS_SINCE_SUCCESS),
        DEVICE_FEATURE_UNITS.HOURS,
        MAX_HOURS,
      ),
      duration(
        name(FEATURE_KEYS.LAST_DURATION),
        ids.feature(FEATURE_KEYS.LAST_DURATION),
        DEVICE_FEATURE_UNITS.SECONDS,
        MAX_DURATION_S,
      ),
      size(name(FEATURE_KEYS.BYTES_ADDED), ids.feature(FEATURE_KEYS.BYTES_ADDED)),
      counter(name(FEATURE_KEYS.SNAPSHOTS), ids.feature(FEATURE_KEYS.SNAPSHOTS), MAX_COUNT),
      counter(name(FEATURE_KEYS.ERRORS), ids.feature(FEATURE_KEYS.ERRORS), MAX_COUNT),
      counter(name(FEATURE_KEYS.WARNINGS), ids.feature(FEATURE_KEYS.WARNINGS), MAX_COUNT),
      binary(name(FEATURE_KEYS.RUNNING), ids.feature(FEATURE_KEYS.RUNNING)),
      text(name(FEATURE_KEYS.NEXT_RUN), ids.feature(FEATURE_KEYS.NEXT_RUN)),
    ],
  };
}

/** The discovery payload of a repository. */
export function buildRepoDevice(gladys, repo, language = 'en') {
  const ids = repoIds(gladys, repo.id);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: repo.id,
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: [
      size(names[`repo_${REPO_KEYS.SIZE}`], ids.feature(REPO_KEYS.SIZE)),
      counter(names[`repo_${REPO_KEYS.SNAPSHOTS}`], ids.feature(REPO_KEYS.SNAPSHOTS), MAX_COUNT),
    ],
  };
}

/** The discovery payload of the instance. */
export function buildServerDevice(gladys, language = 'en') {
  const ids = serverIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: 'Backrest',
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: [
      binary(names[`server_${SERVER_KEYS.RUNNING}`], ids.feature(SERVER_KEYS.RUNNING)),
      sensor(
        names[SERVER_KEYS.PROGRESS],
        ids.feature(SERVER_KEYS.PROGRESS),
        DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR,
        DEVICE_FEATURE_TYPES.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
        { unit: DEVICE_FEATURE_UNITS.PERCENT, keep_history: false, min: 0, max: 100 },
      ),
      text(names[SERVER_KEYS.CURRENT_PLAN], ids.feature(SERVER_KEYS.CURRENT_PLAN)),
      counter(names[SERVER_KEYS.FAILED], ids.feature(SERVER_KEYS.FAILED), MAX_PLANS),
      counter(names[SERVER_KEYS.OVERDUE], ids.feature(SERVER_KEYS.OVERDUE), MAX_PLANS),
    ],
  };
}

const megabytes = (bytes) => Math.round((bytes / 1_000_000) * 10) / 10;

const withIds = (ids, values) =>
  values.map(({ key, ...value }) => ({
    key,
    device_feature_external_id: ids.feature(key),
    ...value,
  }));

/**
 * The value of every feature of a plan: `{ key, device_feature_external_id,
 * state|text }`, nothing for a value that is not known.
 */
export function planValues(gladys, plan, language, now) {
  const values = [
    { key: FEATURE_KEYS.STATE, text: pick(STATE_TEXT[stateOf(plan)], language) },
    {
      key: FEATURE_KEYS.LAST_SUCCESS,
      text: plan.lastSuccess === null ? '-' : formatTime(plan.lastSuccess, language),
    },
  ];
  const hours = hoursSince(plan, now);
  if (hours !== null) {
    values.push({ key: FEATURE_KEYS.HOURS_SINCE_SUCCESS, state: Math.min(hours, MAX_HOURS) });
  }
  const run = plan.lastRun;
  if (run?.durationS !== null && run?.durationS !== undefined) {
    values.push({
      key: FEATURE_KEYS.LAST_DURATION,
      state: Math.min(run.durationS, MAX_DURATION_S),
    });
  }
  if (run?.bytesAdded !== null && run?.bytesAdded !== undefined) {
    values.push({ key: FEATURE_KEYS.BYTES_ADDED, state: megabytes(run.bytesAdded) });
  }
  if (plan.snapshots !== null) {
    values.push({ key: FEATURE_KEYS.SNAPSHOTS, state: Math.min(plan.snapshots, MAX_COUNT) });
  }
  values.push(
    { key: FEATURE_KEYS.ERRORS, state: Math.min(run?.errors ?? 0, MAX_COUNT) },
    { key: FEATURE_KEYS.WARNINGS, state: Math.min(run?.warnings ?? 0, MAX_COUNT) },
    { key: FEATURE_KEYS.RUNNING, state: plan.running ? 1 : 0 },
    {
      key: FEATURE_KEYS.NEXT_RUN,
      text: plan.nextRun === null ? '-' : formatTime(plan.nextRun, language),
    },
  );
  return withIds(planIds(gladys, plan.id), values);
}

/** The values of a repository, nothing before its history is read. */
export function repoValues(gladys, repo) {
  const values = [];
  if (repo.sizeBytes !== null) {
    values.push({ key: REPO_KEYS.SIZE, state: megabytes(repo.sizeBytes) });
  }
  if (repo.snapshots !== null) {
    values.push({ key: REPO_KEYS.SNAPSHOTS, state: Math.min(repo.snapshots, MAX_COUNT) });
  }
  return withIds(repoIds(gladys, repo.id), values);
}

/** The values of the instance device. */
export function serverValues(gladys, { plans, active }) {
  return withIds(serverIds(gladys), [
    { key: SERVER_KEYS.RUNNING, state: active ? 1 : 0 },
    { key: SERVER_KEYS.PROGRESS, state: active ? (active.progress ?? 0) : 0 },
    { key: SERVER_KEYS.CURRENT_PLAN, text: active ? active.id : '-' },
    // The last backup, not the state: a failed plan running again still counts.
    {
      key: SERVER_KEYS.FAILED,
      state: plans.filter((plan) => plan.lastRun?.result === 'error').length,
    },
    { key: SERVER_KEYS.OVERDUE, state: plans.filter((plan) => plan.overdue).length },
  ]);
}
