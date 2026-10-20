// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Backrest, a temporary
// /data and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs: the tests read Backrest with
// `world.hub.pollNow()`. (Adapted from guim31/gladys-healthchecks.)
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { planIds, repoIds } from '../../src/devices.js';
import { Store } from '../../src/store.js';
import { BASE, FakeBackrest, INSTANCE, PASSWORD, REPO_PASSWORD, USERNAME } from './fakeBackrest.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const HOUR = 3_600_000;
export const START = Date.UTC(2026, 9, 19, 10, 0, 0);

/** A manual clock, shared by the hub, the fake and the tests. */
export function createClock(start = START) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * The default instance, one repository "local": "documents", daily, backed up
 * 8 hours ago; "photos", daily, failed 2 hours ago (last success 26 hours
 * ago); "archive", on the 1st of the month (cron), never run.
 */
export function defaultBackrest(clock) {
  const now = clock.time;
  const fake = new FakeBackrest({ now: clock.now });
  fake.addRepo('local');
  fake.addPlan('documents', { next: now + 16 * HOUR });
  fake.run('documents', 'success', { end: now - 32 * HOUR });
  fake.run('documents', 'success', { end: now - 8 * HOUR, seconds: 420 });
  fake.addPlan('photos', { next: now + 22 * HOUR });
  fake.run('photos', 'success', { end: now - 26 * HOUR });
  fake.run('photos', 'error', { end: now - 2 * HOUR, seconds: 1 });
  fake.addPlan('archive', { schedule: { cron: '0 3 1 * *' } });
  fake.stats('local', { at: now - 20 * HOUR, totalSize: 1_234_567_890 });
  return fake;
}

export async function createWorld({
  clock = createClock(),
  backrest = defaultBackrest(clock),
  config = { url: BASE, username: USERNAME, password: PASSWORD, language: 'en' },
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-backrest-')),
  timings = { startAckMs: 5 },
  timers = false,
} = {}) {
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: backrest.request,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, backrest, app, hub: app.hub, clock, dataDir };
}

/** External ids of the device of a plan. */
export const idsOf = (world, id) => planIds(world.gladys, id);
export const repoIdsOf = (world, id) => repoIds(world.gladys, id);

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

export { BASE, FakeBackrest, INSTANCE, PASSWORD, REPO_PASSWORD, USERNAME };
