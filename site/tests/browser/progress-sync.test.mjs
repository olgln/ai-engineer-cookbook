// Tests for the account mode of the browser progress store (src/scripts/progress/store.ts, run by Node's type
// stripping): first sync, server-wins when in step, uploads after a change, conflicts with another
// device, an expired session, signing out and deleting the account. fetch and localStorage are fakes; each test loads a fresh
// copy of the module.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  ACCOUNT_API_PATH, LOGOUT_API_PATH, PROGRESS_API_PATH, PROGRESS_REV_HEADER, PROGRESS_VERSION, SAVE_DEBOUNCE_MS, STORAGE_KEY,
  SYNC_STORAGE_KEY,
} from '../../src/config/app.mjs';

/** In-memory account API: one progress document with a revision, like worker/lib/progress.mjs. */
class FakeAccount {
  constructor(data = { version: PROGRESS_VERSION, chapters: {} }, rev = 0) {
    this.data = data;
    this.rev = rev;
    this.signedIn = true;
    this.puts = 0;
    this.pending = 0;
    this.deleted = false;
    /** Status the account deletion answers with while signed in (a server error when not 204). */
    this.deleteStatus = 204;
  }

  async fetch(url, init = {}) {
    this.pending++;
    try {
      await new Promise((r) => setImmediate(r));
      const method = init.method ?? 'GET';
      const json = (status, body, headers = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
      if (url === LOGOUT_API_PATH && method === 'POST') {
        this.signedIn = false;
        return new Response(null, { status: 204 });
      }
      if (url === ACCOUNT_API_PATH) {
        assert.equal(method, 'DELETE');
        if (!this.signedIn) return json(401, { error: 'unauthorized' });
        if (this.deleteStatus !== 204) return json(this.deleteStatus, { error: 'internal error' });
        this.deleted = true;
        this.signedIn = false;
        this.data = null;
        return new Response(null, { status: 204 });
      }
      assert.equal(url, PROGRESS_API_PATH);
      if (!this.signedIn) return json(401, { error: 'unauthorized' });
      if (method === 'GET') return json(200, this.data, { [PROGRESS_REV_HEADER]: String(this.rev) });
      this.puts++;
      if (Number(init.headers[PROGRESS_REV_HEADER]) !== this.rev) return json(409, { error: 'conflict', rev: this.rev });
      this.data = JSON.parse(init.body);
      this.rev++;
      return json(200, { rev: this.rev });
    } finally {
      this.pending--;
    }
  }

  /** Another device writes. */
  writeElsewhere(data) {
    this.data = data;
    this.rev++;
  }
}

let account, store, loads = 0;

beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  account = new FakeAccount();
  globalThis.fetch = (url, init) => account.fetch(url, init);
});

const fresh = () => import(`../../src/scripts/progress/store.ts?copy=${++loads}`);
const marker = () => JSON.parse(store.get(SYNC_STORAGE_KEY) ?? 'null');
const local = () => JSON.parse(store.get(STORAGE_KEY));
const doc = (chapters, updatedAt) => ({ version: PROGRESS_VERSION, ...(updatedAt && { updatedAt }), chapters });

/** Waits for the debounced upload and every request it leads to. */
async function settle() {
  await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 20));
  while (account.pending > 0) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('progress store with an account', () => {
  test('signed out, the browser copy is used alone', async () => {
    account.signedIn = false;
    store.set(STORAGE_KEY, JSON.stringify(doc({ c1: { done: '2026-11-01' } })));
    const P = await fresh();
    await P.load();
    assert.equal(P.storage, 'browser');
    assert.deepEqual(P.get().chapters, { c1: { done: '2026-11-01' } });
  });

  test('an older browser copy and account copy get the current chapter ids; the account gets them on upload', async () => {
    account = new FakeAccount({ version: 1, chapters: { '8-1': { done: '2026-11-01' } } }, 2);
    store.set(STORAGE_KEY, JSON.stringify({ version: 1, chapters: { '9-1': { done: '2026-11-02' } } }));
    const P = await fresh();
    await P.load();
    assert.deepEqual(P.get().chapters, { '7-1': { done: '2026-11-01' }, '8-1': { done: '2026-11-02' } });
    assert.equal(P.get().version, PROGRESS_VERSION);
    await settle();
    assert.deepEqual(account.data, { version: PROGRESS_VERSION, chapters: { '7-1': { done: '2026-11-01' }, '8-1': { done: '2026-11-02' } } });
  });

  test('the first sync merges the browser copy into the account and uploads it', async () => {
    account = new FakeAccount(doc({ c1: { done: '2026-11-01' } }), 4);
    store.set(STORAGE_KEY, JSON.stringify(doc({ c2: { done: '2026-11-02' } })));
    const P = await fresh();
    await P.load();
    assert.equal(P.storage, 'account');
    assert.deepEqual(Object.keys(P.get().chapters).sort(), ['c1', 'c2']);
    await settle();
    assert.deepEqual(Object.keys(account.data.chapters).sort(), ['c1', 'c2']);
    assert.deepEqual(marker(), { rev: 5, dirty: false });
    assert.deepEqual(Object.keys(local().chapters).sort(), ['c1', 'c2']);
  });

  test('in step with the account, its copy replaces a stale browser copy without an upload', async () => {
    account = new FakeAccount(doc({ c1: {} }), 7);
    store.set(STORAGE_KEY, JSON.stringify(doc({ c1: { checks: { 0: true } } })));
    store.set(SYNC_STORAGE_KEY, JSON.stringify({ rev: 6, dirty: false }));
    const P = await fresh();
    await P.load();
    assert.deepEqual(P.get().chapters, { c1: {} });
    await settle();
    assert.equal(account.puts, 0);
    assert.deepEqual(marker(), { rev: 7, dirty: false });
  });

  test('a change is uploaded after the debounce and the marker is clean again', async () => {
    const P = await fresh();
    await P.load();
    P.chapter('c1').done = '2026-11-14';
    P.save();
    assert.deepEqual(marker(), { rev: 0, dirty: true });
    await settle();
    assert.deepEqual(account.data.chapters, { c1: { done: '2026-11-14' } });
    assert.deepEqual(marker(), { rev: 1, dirty: false });
  });

  test('a write from another device in between is merged, not overwritten', async () => {
    const P = await fresh();
    await P.load();
    account.writeElsewhere(doc({ other: { done: '2026-11-13' } }, '2026-11-13T00:00:00.000Z'));
    P.chapter('mine').done = '2026-11-14';
    P.save();
    await settle();
    assert.deepEqual(Object.keys(account.data.chapters).sort(), ['mine', 'other']);
    assert.deepEqual(Object.keys(P.get().chapters).sort(), ['mine', 'other']);
    assert.deepEqual(marker(), { rev: 2, dirty: false });
    assert.equal(account.puts, 2, 'one refused, one accepted');
  });

  test('an expired session switches to the browser copy and forgets the account marker', async () => {
    const P = await fresh();
    await P.load();
    account.signedIn = false;
    P.chapter('c1').done = '2026-11-14';
    P.save();
    await settle();
    assert.equal(P.storage, 'browser');
    assert.equal(marker(), null);
    assert.deepEqual(local().chapters, { c1: { done: '2026-11-14' } });
  });

  test('signing out uploads pending changes first, then keeps the browser copy for the next sign-in', async () => {
    const P = await fresh();
    await P.load();
    P.chapter('c1').done = '2026-11-14';
    P.save();
    await P.signOut();
    assert.deepEqual(account.data.chapters, { c1: { done: '2026-11-14' } }, 'uploaded before signing out');
    assert.equal(account.signedIn, false);
    assert.equal(P.storage, 'browser');
    assert.equal(marker(), null);
    assert.deepEqual(local().chapters, { c1: { done: '2026-11-14' } });
  });

  test('deleting the account switches to the browser copy, which stays, and uploads nothing more', async () => {
    account = new FakeAccount(doc({ c1: { done: '2026-11-01' } }), 3);
    store.set(SYNC_STORAGE_KEY, JSON.stringify({ rev: 3, dirty: false }));
    const P = await fresh();
    await P.load();
    P.chapter('c2').done = '2026-11-14';
    P.save();
    assert.equal(await P.deleteAccount(), true);
    assert.equal(account.deleted, true);
    assert.equal(P.storage, 'browser');
    assert.equal(marker(), null, 'no marker: a new account later starts with a first sync');
    assert.deepEqual(Object.keys(local().chapters).sort(), ['c1', 'c2']);
    await settle();
    assert.equal(account.puts, 0, 'the pending change is not uploaded to the deleted account');
  });

  test('a failed deletion changes nothing in the browser', async () => {
    const P = await fresh();
    await P.load();
    account.deleteStatus = 500;
    assert.equal(await P.deleteAccount(), false);
    assert.equal(P.storage, 'account');
    assert.deepEqual(marker(), { rev: 0, dirty: false });
    account.signedIn = false;
    assert.equal(await P.deleteAccount(), false, 'signed out elsewhere: 401');
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    assert.equal(await P.deleteAccount(), false, 'offline');
    assert.equal(P.storage, 'account');
  });
});
