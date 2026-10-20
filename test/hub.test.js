// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and a fake Backrest: discovery,
// states, scene events on backups and overdue plans, persistence across
// restarts, the backup running, the start action, errors, quiet logs, the
// widget and the reading timer of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS, REPO_KEYS, SERVER_KEYS, overdueAfterMs, serverIds } from '../src/devices.js';
import { cronPeriodMs } from '../src/cron.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import {
  BASE,
  FakeBackrest,
  HOUR,
  PASSWORD,
  REPO_PASSWORD,
  START,
  USERNAME,
  createClock,
  createDevices,
  createWorld,
  idsOf,
  repoIdsOf,
} from './helpers/world.js';

const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const state = (world, id, key) => world.fake.lastState(idsOf(world, id).feature(key));
const CONFIG = { url: BASE, username: USERNAME, password: PASSWORD };
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('one device per plan, per repository and one for the instance, nothing polled by Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Backrest', 'documents', 'photos', 'archive', 'local'],
  );
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  // Nothing is published for devices not added, and the first read fires nothing.
  assert.equal(world.fake.states.length, 0);
  assert.equal(world.fake.sceneEvents.length, 0);
  assert.equal(world.fake.connectionStatus.connected, true);
  // The repository password and URI of the Backrest config never reach Gladys.
  assert.ok(!JSON.stringify(devices).includes(REPO_PASSWORD));
});

test('the states of the added devices: success, failure, never run, repository', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.equal(state(world, 'documents', FEATURE_KEYS.STATE), 'OK');
  assert.equal(state(world, 'documents', FEATURE_KEYS.HOURS_SINCE_SUCCESS), 8);
  assert.equal(state(world, 'documents', FEATURE_KEYS.LAST_DURATION), 420);
  assert.equal(state(world, 'documents', FEATURE_KEYS.BYTES_ADDED), 12.3);
  assert.equal(state(world, 'documents', FEATURE_KEYS.SNAPSHOTS), 2);
  assert.equal(state(world, 'documents', FEATURE_KEYS.RUNNING), 0);
  assert.notEqual(state(world, 'documents', FEATURE_KEYS.NEXT_RUN), '-');

  assert.equal(state(world, 'photos', FEATURE_KEYS.STATE), 'Failed');
  assert.equal(state(world, 'photos', FEATURE_KEYS.ERRORS), 1);
  // The last success is the backup before the failure.
  assert.equal(state(world, 'photos', FEATURE_KEYS.HOURS_SINCE_SUCCESS), 26);

  assert.equal(state(world, 'archive', FEATURE_KEYS.STATE), 'Never run');
  assert.equal(state(world, 'archive', FEATURE_KEYS.LAST_SUCCESS), '-');
  assert.equal(state(world, 'archive', FEATURE_KEYS.HOURS_SINCE_SUCCESS), undefined);
  assert.equal(state(world, 'archive', FEATURE_KEYS.SNAPSHOTS), 0);
  assert.equal(state(world, 'archive', FEATURE_KEYS.NEXT_RUN), '-');

  const repo = repoIdsOf(world, 'local');
  assert.equal(world.fake.lastState(repo.feature(REPO_KEYS.SIZE)), 1234.6);
  assert.equal(world.fake.lastState(repo.feature(REPO_KEYS.SNAPSHOTS)), 3);

  const server = serverIds(world.gladys);
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.FAILED)), 1);
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.RUNNING)), 0);
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.CURRENT_PLAN)), '-');
});

test('a new backup fires "succeeded" or "failed", warnings both, once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { backrest, clock } = world;

  clock.advance(HOUR);
  backrest.run('documents', 'success', { end: clock.time, seconds: 600, added: 1_200_000_000 });
  await world.hub.pollNow();
  assert.deepEqual(events(world, TRIGGERS.SUCCEEDED).at(-1).data, {
    device: idsOf(world, 'documents').device,
    plan: 'documents',
    duration_minutes: 10,
    warnings: 0,
    added: '1.2 GB',
    snapshots: 3,
  });
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.SUCCEEDED).length, 1, 'not twice');

  clock.advance(HOUR);
  backrest.run('documents', 'error', { end: clock.time, message: 'repository is locked' });
  await world.hub.pollNow();
  assert.deepEqual(events(world, TRIGGERS.FAILED).at(-1).data, {
    device: idsOf(world, 'documents').device,
    plan: 'documents',
    result: 'error',
    message: 'repository is locked',
    errors: 1,
    warnings: 0,
  });

  clock.advance(HOUR);
  backrest.run('documents', 'warning', {
    end: clock.time,
    errors: [
      { item: '/data/documents/a.db', during: 'archival', message: 'permission denied' },
      { item: '/data/documents/b.db', during: 'archival', message: 'permission denied' },
    ],
  });
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.SUCCEEDED).length, 2);
  const warning = events(world, TRIGGERS.FAILED).at(-1).data;
  assert.equal(warning.result, 'warning');
  assert.equal(warning.warnings, 2);
  assert.equal(warning.message, '/data/documents/a.db: permission denied');
  assert.equal(world.hub.find(idsOf(world, 'documents').device).lastSuccess, clock.time);

  // A dry run is not a backup.
  clock.advance(HOUR);
  backrest.run('documents', 'success', { end: clock.time, dryRun: true });
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.SUCCEEDED).length, 2);
});

test('a plan becomes overdue once, by its schedule, and back when it succeeds', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const { backrest, clock } = world;
  // documents: every 24 hours, last success 8 hours ago; overdue after 24 + 6 hours.
  clock.advance(21 * HOUR);
  await world.hub.pollNow();
  const documents = () =>
    events(world, TRIGGERS.OVERDUE).filter((event) => event.data.plan === 'documents');
  assert.equal(documents().length, 0);
  clock.advance(2 * HOUR);
  await world.hub.pollNow();
  const overdue = documents();
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].data.hours_since_success, 31);
  assert.equal(state(world, 'documents', FEATURE_KEYS.STATE), 'Overdue');
  // photos is overdue too, but failed: its state says "Failed".
  assert.equal(state(world, 'photos', FEATURE_KEYS.STATE), 'Failed');
  assert.equal(world.fake.lastState(serverIds(world.gladys).feature(SERVER_KEYS.OVERDUE)), 2);

  await world.hub.pollNow();
  assert.equal(documents().length, 1, 'not twice');
  backrest.run('documents', 'success', { end: clock.time });
  await world.hub.pollNow();
  assert.equal(state(world, 'documents', FEATURE_KEYS.STATE), 'OK');
});

test('a repository history unreadable for a while fires nothing, and keeps its figures', async (t) => {
  const world = await createWorld({ timings: { startAckMs: 5, historyEveryMs: 0 } });
  t.after(() => world.app.stop());
  await createDevices(world);
  world.backrest.historyFailure = 503;
  await world.hub.pollNow();
  // A history too long to read in time does not stop the plans either.
  world.backrest.historyFailure = 'timeout';
  await world.hub.pollNow();
  assert.equal(world.fake.sceneEvents.length, 0);
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.hub.repos.get('local').snapshots, 3);
  world.backrest.historyFailure = null;
  world.clock.advance(HOUR);
  world.backrest.run('archive', 'success', { end: world.clock.time });
  await world.hub.pollNow();
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => [event.key, event.data.plan]),
    [[TRIGGERS.SUCCEEDED, 'archive']],
  );
  assert.equal(world.hub.repos.get('local').snapshots, 4);
});

test('the last success stays known when failures push it out of the operations read', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const before = world.hub.find(idsOf(world, 'photos').device).lastSuccess;
  for (let i = 0; i < 70; i += 1) {
    world.clock.advance(HOUR);
    world.backrest.run('photos', 'error', { end: world.clock.time });
  }
  // Backrest has forgotten the old operations (30 days): only /data remembers.
  world.backrest.ops = world.backrest.ops.filter(
    (op) => op.planId !== 'photos' || op.status === 'STATUS_ERROR',
  );
  await world.hub.pollNow();
  assert.equal(world.hub.find(idsOf(world, 'photos').device).lastSuccess, before);
});

test('the snapshots forgotten by the retention policy are no longer counted', async (t) => {
  // The default timings: forget marks the operations already read, no new id.
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.backrest.forgetSnapshots('documents');
  await world.hub.pollNow();
  assert.equal(world.hub.find(idsOf(world, 'documents').device).snapshots, 0);
  assert.equal(world.hub.repos.get('local').snapshots, 1);
});

test('the overdue threshold: period, cron (longest gap), none without schedule, or fixed', () => {
  const daily = { schedule: { periodMs: 24 * HOUR } };
  const hourly = { schedule: { periodMs: HOUR } };
  assert.equal(overdueAfterMs(daily, null), 30 * HOUR);
  assert.equal(overdueAfterMs(hourly, null), 2 * HOUR);
  assert.equal(overdueAfterMs({ schedule: { cron: '0 3 * * *' } }, null), 30 * HOUR);
  // Weekdays only: 72 hours from Friday to Monday.
  assert.equal(overdueAfterMs({ schedule: { cron: '30 2 * * 1-5' } }, null), 90 * HOUR);
  assert.equal(overdueAfterMs({ schedule: { cron: 'nonsense' } }, null), null);
  assert.equal(overdueAfterMs({ schedule: null }, null), null);
  assert.equal(overdueAfterMs({ schedule: null }, 48), 48 * HOUR);
  assert.equal(cronPeriodMs('*/15 * * * *'), 15 * 60_000);
  assert.equal(cronPeriodMs('@daily'), 24 * HOUR);
  assert.equal(cronPeriodMs('0 0 * * SUN'), 7 * 24 * HOUR);
  assert.equal(cronPeriodMs('0 4 1 * *'), 31 * 24 * HOUR);
  assert.equal(cronPeriodMs('0 0 1 1 *'), 365 * 24 * HOUR);
  // The 31st: from August to October.
  assert.equal(cronPeriodMs('0 3 31 * *'), 61 * 24 * HOUR);
  // Months outside the summer, steps and ranges of weekdays.
  assert.equal(cronPeriodMs('0 3 * 1-6 *'), 185 * 24 * HOUR);
  assert.equal(cronPeriodMs('0 3 * * 1/2'), 3 * 24 * HOUR);
  assert.equal(cronPeriodMs('0 3 * * MON-SUN'), 24 * HOUR);
  assert.equal(cronPeriodMs('0 3 * * 0,7'), 7 * 24 * HOUR);
});

test('a backup made while the integration was stopped is announced after a restart, once', async (t) => {
  const clock = createClock();
  const first = await createWorld({ clock });
  await first.app.stop();
  clock.advance(HOUR);
  first.backrest.run('documents', 'error', { end: clock.time });
  const second = await createWorld({ clock, backrest: first.backrest, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.equal(events(second, TRIGGERS.FAILED).length, 1);
  await second.app.stop();
  const third = await createWorld({ clock, backrest: first.backrest, dataDir: first.dataDir });
  t.after(() => third.app.stop());
  assert.equal(events(third, TRIGGERS.FAILED).length, 0);
});

test('a backup running: the plan and the instance show it and its progress', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const { backrest, clock } = world;
  const server = serverIds(world.gladys);
  const op = backrest.running('archive', { begin: clock.time, percent: 0.307 });
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.RUNNING)), 1);
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.PROGRESS)), 30);
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.CURRENT_PLAN)), 'archive');
  assert.equal(state(world, 'archive', FEATURE_KEYS.RUNNING), 1);
  assert.equal(state(world, 'archive', FEATURE_KEYS.STATE), 'Running');
  assert.equal(world.hub.activeId, 'archive');

  clock.advance(10 * 60_000);
  backrest.finish(op, 'success', { end: clock.time });
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.RUNNING)), 0);
  assert.equal(world.fake.lastState(server.feature(SERVER_KEYS.PROGRESS)), 0);
  assert.equal(state(world, 'archive', FEATURE_KEYS.STATE), 'OK');
  assert.equal(state(world, 'archive', FEATURE_KEYS.LAST_DURATION), 600);
  assert.equal(events(world, TRIGGERS.SUCCEEDED).at(-1).data.plan, 'archive');
});

test('"Start a backup" runs the plan in Backrest, unless disabled in the configuration', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const device = idsOf(world, 'archive').device;
  const ack = await world.fake.sceneAction('start_backup', { device });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.backrest.started, ['archive']);
  assert.equal(world.hub.activeId, 'archive');

  await world.fake.configUpdated({ ...CONFIG, language: 'fr', allow_start: false });
  const refused = await world.fake.sceneAction('start_backup', { device });
  assert.equal(refused.success, false);
  assert.match(refused.error, /désactivé/);
  assert.equal(world.backrest.started.length, 1);

  const unknown = await world.fake.sceneAction('get_backup_status', { device: 'nope' });
  assert.equal(unknown.success, false);
});

test('"Start a backup" that Backrest refuses at once fails with its message, then fires "failed"', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.backrest.backupMode = 'error';
  world.clock.advance(HOUR);
  const ack = await world.fake.sceneAction('start_backup', {
    device: idsOf(world, 'photos').device,
  });
  assert.equal(ack.success, false);
  assert.equal(ack.error, 'Backrest: failed to backup: path /data/photos does not exist');
  await settle();
  await world.hub.pollNow();
  assert.equal(events(world, TRIGGERS.FAILED).at(-1).data.plan, 'photos');
});

test('"State of a plan" gives a sentence in the language of the configuration', async (t) => {
  const world = await createWorld({ config: { ...CONFIG, language: 'fr' } });
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('get_backup_status', {
    device: idsOf(world, 'photos').device,
  });
  assert.equal(ack.success, true, ack.error);
  const outputs = ack.data.outputs;
  assert.equal(outputs.failed, true);
  assert.equal(outputs.state, 'En échec');
  assert.equal(outputs.hours_since_success, 26);
  assert.match(outputs.sentence, /^photos : En échec, dernière réussite \d\d\/10 \d\d:\d\d\.$/);
  const never = await world.fake.sceneAction('get_backup_status', {
    device: idsOf(world, 'archive').device,
  });
  assert.equal(never.data.outputs.hours_since_success, -1);
  assert.match(never.data.outputs.sentence, /jamais réussi/);
});

test('Backrest down, wrong password, no configuration: a status, the badge, no crash', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.backrest.failure = 'down';
  await world.hub.pollNow();
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /does not answer/);
  assert.ok(
    world.fake.transports.some((entry) => entry.transport === 'unreachable'),
    'unreachable badge',
  );
  const action = await world.fake.sceneAction('get_backup_status', {
    device: idsOf(world, 'archive').device,
  });
  assert.equal(action.success, false);
  world.backrest.failure = null;
  world.clock.advance(60_000);
  const back = await world.fake.sceneAction('get_backup_status', {
    device: idsOf(world, 'archive').device,
  });
  assert.equal(back.success, true, back.error);
  assert.equal(world.fake.connectionStatus.connected, true);

  await world.fake.configUpdated({ ...CONFIG, password: 'wrong', language: 'en' });
  assert.match(world.fake.connectionStatus.message.en, /password missing or refused/);
  await world.fake.configUpdated({ url: BASE, language: 'en' });
  assert.match(world.fake.connectionStatus.message.en, /password missing or refused/);
  await world.fake.configUpdated({ url: '', language: 'en' });
  assert.match(world.fake.connectionStatus.message.en, /address of your Backrest/);
  const report = await world.fake.action('test_connection', {});
  assert.equal(report.success, true);
});

test('a Backrest without authentication is read without credentials', async (t) => {
  const clock = createClock();
  const backrest = new FakeBackrest({ auth: false, now: clock.now });
  backrest.addRepo('nas');
  backrest.addPlan('home', { repo: 'nas' });
  backrest.run('home', 'success', { end: START - HOUR });
  const world = await createWorld({ clock, backrest, config: { url: BASE, language: 'en' } });
  t.after(() => world.app.stop());
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.hub.find(idsOf(world, 'home').device).lastSuccess, START - HOUR);
});

test('"Test the connection" sums up the instance', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.success, true, ack.error);
  const message = ack.data?.message ?? ack.data;
  assert.equal(message.en, 'Backrest: Connected, 3 plan(s), 1 repository(ies), 1 failed');
  assert.equal(message.fr, 'Backrest : Connecté, 3 plan(s), 1 dépôt(s), 1 en échec');
});

test('the widget: valid content, failed first, then the others', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await world.fake.widgetGet(WIDGET_KEY, { settings: {}, language });
    assert.equal(ack.success, true, ack.error);
    const content = ack.data.content;
    assert.deepEqual(validateWidgetContent(content).errors ?? [], []);
    const status = content.components.find((c) => c.type === 'status');
    assert.deepEqual(
      status.items.map((item) => item.label),
      ['photos', 'archive', 'documents'],
    );
  }
  const chosen = await world.fake.widgetGet(WIDGET_KEY, {
    settings: { plans: [idsOf(world, 'documents').device] },
    language: 'en',
  });
  const rows = chosen.data.content.components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((item) => item.label),
    ['documents'],
  );
  const action = await world.fake.widgetAction(WIDGET_KEY, 'refresh', {}, { language: 'en' });
  assert.equal(action.success, true, action.error);
});

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

test('a normal reading cycle writes nothing at the info level, nor any secret', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const sent = world.fake.states.length;
  const lines = await captureLogs(t, 'debug', async () => {
    for (let cycle = 0; cycle < 6; cycle += 1) {
      world.clock.advance(5 * 60_000);
      await world.hub.pollNow();
    }
  });
  assert.ok(world.fake.states.length >= sent);
  const all = lines.join('\n');
  assert.ok(!all.includes(PASSWORD) && !all.includes(REPO_PASSWORD));
  const quiet = await captureLogs(t, 'info', async () => {
    world.clock.advance(5 * 60_000);
    await world.hub.pollNow();
  });
  assert.deepEqual(quiet, []);
});

test('the internal timer reads Backrest, every 30 seconds while a backup runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = createClock();
  const backrest = new FakeBackrest({ now: clock.now });
  backrest.addRepo('local');
  backrest.addPlan('documents');
  backrest.running('documents', { begin: START - 60_000 });
  const world = await createWorld({ clock, backrest, timers: true });
  t.after(() => world.app.stop());
  const reads = () => backrest.requests.filter((r) => r.path.endsWith('/GetConfig')).length;
  const before = reads();
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(reads(), before + 1);
});
