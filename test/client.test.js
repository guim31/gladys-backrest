// -----------------------------------------------------------------------------
// The Backrest client against the real answers of a Backrest 1.14.1
// (test/fixtures/backrest, recorded from the garethgeorge/backrest image: a
// plan backed up, one whose folder is missing, one with an unreadable file,
// one running, the full history of the repository with a "stats" operation),
// and its errors against the fake. The fake must answer in the same shapes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BackrestClient,
  ERROR_KINDS,
  normalizeConfig,
  normalizeOperation,
  normalizeSchedule,
} from '../src/backrest/client.js';
import { parseServerUrl } from '../src/config.js';
import { summarizeRepo, viewOf } from '../src/hub.js';
import { BASE, FakeBackrest, PASSWORD, USERNAME } from './helpers/fakeBackrest.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/backrest/${name}`, import.meta.url), 'utf8'));
const operations = async (name) => (await fixture(name)).operations.map(normalizeOperation);

test('the config of a real Backrest: plans and repositories, no password kept', async () => {
  const config = normalizeConfig(await fixture('config.json'));
  assert.equal(config.instance, 'gladys-test');
  assert.deepEqual(config.repos, [
    { id: 'local', guid: 'a7ac472786f6313fb06f52bcc13b32c654ec6bd9abd8856b91b327ec750ad164' },
  ]);
  assert.deepEqual(
    config.plans.map((plan) => [plan.id, plan.repo, plan.schedule]),
    [
      ['big', 'local', { periodMs: 6 * 3_600_000 }],
      ['documents', 'local', { periodMs: 24 * 3_600_000 }],
      ['secrets', 'local', { cron: '0 3 * * *' }],
      ['warn', 'local', { periodMs: 24 * 3_600_000 }],
    ],
  );
  assert.ok(!JSON.stringify(config).includes('password'));
  assert.equal(normalizeSchedule({ disabled: true }), null);
  assert.equal(normalizeConfig({ hello: 'world' }), null);
});

test('the operations of a real Backrest: success, error, warning, running, pending', async () => {
  const documents = await operations('ops-documents.json');
  const backup = documents.find((op) => op.kind === 'backup' && op.status === 'success');
  assert.equal(backup.planId, 'documents');
  assert.equal(backup.end - backup.begin, 1499);
  assert.equal(backup.backup.bytesAdded, 301411);
  assert.equal(backup.backup.files, 2);
  assert.ok(documents.some((op) => op.kind === 'snapshot' && op.forgot === false));
  assert.ok(documents.some((op) => op.kind === 'forget'));

  const [failed] = (await operations('ops-secrets.json')).filter((op) => op.status === 'error');
  assert.match(failed.message, /path \/source\/missing does not exist/);
  assert.equal(failed.backup.bytesAdded, null);

  const warn = (await operations('ops-warn.json')).find((op) => op.status === 'warning');
  assert.equal(warn.backup.fileErrors, 1);
  assert.equal(warn.backup.firstError, '/proc/1/mem: open /proc/1/mem: permission denied');

  const running = await operations('ops-running.json');
  assert.deepEqual(
    running.map((op) => op.status),
    ['pending', 'running'],
  );
  assert.equal(running[1].backup.progress, 13);
  assert.equal(running[0].begin > running[1].begin, true, 'the pending run is the next one');
});

test('the view of a real plan: the last backup, its success, its next run', async () => {
  const now = 1792522300000;
  const repo = summarizeRepo(await operations('ops-repo.json'), 'gladys-test');
  assert.equal(repo.sizeBytes, 600360692);
  assert.equal(repo.snapshots, 3);
  assert.equal(repo.plans.get('documents').snapshots, 1);

  const plan = { id: 'warn', repo: 'local', paths: [], schedule: { periodMs: 86_400_000 } };
  const view = viewOf(plan, await operations('ops-warn.json'), repo, { now, overdueHours: null });
  assert.equal(view.lastRun.result, 'warning');
  assert.equal(view.lastRun.warnings, 1);
  assert.equal(view.lastSuccess, 1792522097358);
  assert.equal(view.running, false);
  assert.ok(view.nextRun > now);
  assert.equal(view.snapshots, 1);

  const secrets = viewOf(
    { id: 'secrets', repo: 'local', paths: [], schedule: { cron: '0 3 * * *' } },
    await operations('ops-secrets.json'),
    repo,
    { now, overdueHours: null },
  );
  assert.equal(secrets.lastRun.result, 'error');
  assert.equal(secrets.lastRun.errors, 1);
  assert.equal(secrets.lastSuccess, null);
  assert.equal(secrets.overdue, false);
});

test('the fake answers in the shapes of the real Backrest', async () => {
  const fake = new FakeBackrest();
  fake.addRepo('local');
  fake.addPlan('documents', { next: 2_000_000_000 });
  fake.run('documents', 'success', { end: 1_000_000_000 });
  const client = new BackrestClient({
    url: BASE,
    username: USERNAME,
    password: PASSWORD,
    request: fake.request,
  });
  const real = (await fixture('ops-documents.json')).operations.find(
    (op) => op.operationBackup?.lastStatus,
  );
  const mine = fake.ops.find((op) => op.operationBackup?.lastStatus);
  for (const key of ['id', 'flowId', 'unixTimeStartMs', 'unixTimeEndMs']) {
    assert.equal(typeof mine[key], typeof real[key], key);
  }
  assert.equal((await client.planOperations('documents', 'home-server')).length, 3);
  assert.deepEqual(await client.planOperations('nope', 'home-server'), []);
});

test('the address typed by the user', () => {
  assert.equal(parseServerUrl('192.0.2.10'), 'http://192.0.2.10:9898');
  assert.equal(parseServerUrl('nas.local:9899'), 'http://nas.local:9899');
  assert.equal(parseServerUrl('http://192.0.2.10:9898/#/plan/documents'), 'http://192.0.2.10:9898');
  assert.equal(
    parseServerUrl('https://backup.example.org/backrest/'),
    'https://backup.example.org/backrest',
  );
  assert.equal(
    parseServerUrl('http://192.0.2.10:9898/v1.Backrest/GetConfig'),
    'http://192.0.2.10:9898',
  );
  assert.equal(parseServerUrl('http://user:pass@192.0.2.10'), null);
  assert.equal(parseServerUrl('ftp://192.0.2.10'), null);
  assert.equal(parseServerUrl('  '), null);
});

test('the errors, by kind, without the password in the message', async () => {
  const fake = new FakeBackrest();
  fake.addRepo('local');
  fake.addPlan('documents');
  const kind = async (client, call = (c) => c.config()) => {
    try {
      await call(client);
    } catch (err) {
      assert.ok(!err.message.includes(PASSWORD));
      return err.kind;
    }
    return null;
  };
  const make = (options = {}) =>
    new BackrestClient({
      url: BASE,
      username: USERNAME,
      password: PASSWORD,
      request: fake.request,
      ...options,
    });
  assert.equal(await kind(make({ password: 'wrong' })), ERROR_KINDS.AUTH);
  assert.equal(await kind(make({ username: '' })), ERROR_KINDS.AUTH);
  fake.failure = 'down';
  assert.equal(await kind(make()), ERROR_KINDS.UNREACHABLE);
  fake.failure = 302;
  assert.equal(await kind(make()), ERROR_KINDS.REDIRECT);
  fake.failure = 404; // another service
  assert.equal(await kind(make()), ERROR_KINDS.NOT_BACKREST);
  fake.failure = 405; // the web interface of Backrest, under another path
  assert.equal(await kind(make()), ERROR_KINDS.NOT_BACKREST);
  fake.failure = 500;
  assert.equal(await kind(make()), ERROR_KINDS.HTTP);
  fake.failure = null;
  assert.equal(await kind(make(), (c) => c.backup('nope')), ERROR_KINDS.NOT_FOUND);
  const tls = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
    throw error;
  };
  assert.equal(await kind(make({ request: tls })), ERROR_KINDS.TLS);
  const html = async () => ({ status: 200, body: '<html>Router</html>' });
  assert.equal(await kind(make({ request: html })), ERROR_KINDS.NOT_BACKREST);
  const other = async () => ({ status: 200, body: '{"status":"ok"}' });
  assert.equal(await kind(make({ request: other })), ERROR_KINDS.NOT_BACKREST);

  // The real answer to an unknown plan: its Connect message is kept.
  const real = await readFile(
    new URL('./fixtures/backrest/unknown-plan.json', import.meta.url),
    'utf8',
  );
  const client = make({ request: async () => ({ status: 404, body: real }) });
  await assert.rejects(client.backup('nope'), (err) => {
    assert.equal(err.kind, ERROR_KINDS.NOT_FOUND);
    assert.equal(err.detail, 'get plan "nope": plan not found');
    return true;
  });
});
