// Learning progress, always mirrored to localStorage, and stored by whichever API answers:
// - 'file': the local server (`npm start`) writes it to the progress file;
// - 'account': the hosting's Worker keeps it in the signed-in reader's account (sync: ./sync.mjs);
// - 'browser': no API (static hosting, or signed out), localStorage alone.
import {
  ACCOUNT_API_PATH, LOGOUT_API_PATH, PROGRESS_API_PATH, PROGRESS_FILE_HEADER, PROGRESS_REV_HEADER, PROGRESS_VERSION, SAVE_DEBOUNCE_MS,
  STORAGE_KEY, SYNC_STORAGE_KEY,
} from '../../config/app.mjs';
import { migrateProgress } from './migrate.mjs';
import { mergeProgress, parseMarker, planLoad } from './sync.mjs';

export interface QuizAnswer {
  picked?: string[];
  revealed?: boolean;
  self?: 'yes' | 'no';
}
export interface ChapterProgress {
  done?: string;
  checks?: Record<string, boolean>;
  quiz?: Record<string, QuizAnswer>;
}
export interface Progress {
  version: number;
  updatedAt?: string;
  chapters: Record<string, ChapterProgress>;
}

const empty = (): Progress => ({ version: PROGRESS_VERSION, chapters: {} });
let state: Progress = empty();
export let storage: 'file' | 'account' | 'browser' = 'browser';
export let storagePath = '';
const listeners = new Set<() => void>();

/** A well-formed document at the current format version, whichever copy (browser, file, account) it came from. */
function normalize(raw: unknown): Progress {
  const p = raw as Partial<Progress> | null;
  if (!p || typeof p !== 'object' || typeof p.chapters !== 'object' || !p.chapters) return empty();
  return migrateProgress({ version: p.version, updatedAt: p.updatedAt, chapters: p.chapters });
}

function readLocal(): Progress | null {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? normalize(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

function writeLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be blocked */
  }
}

const isEmpty = (p: Progress | null) => !p || Object.keys(p.chapters).length === 0;

// ---- account sync marker: the server revision the browser copy matches, and unsent changes ----
let rev = 0;
let edits = 0; // bumped on every save, to tell whether a finished upload carried the latest state

function readMarker() {
  try {
    return parseMarker(localStorage.getItem(SYNC_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeMarker(dirty: boolean) {
  try {
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({ rev, dirty }));
  } catch {
    /* storage may be blocked */
  }
}

function dropMarker() {
  try {
    localStorage.removeItem(SYNC_STORAGE_KEY);
  } catch {
    /* storage may be blocked */
  }
}

export async function load(): Promise<Progress> {
  const local = readLocal();
  try {
    const res = await fetch(PROGRESS_API_PATH, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('no api');
    const revHeader = res.headers.get(PROGRESS_REV_HEADER);
    if (revHeader !== null) {
      storage = 'account';
      rev = Number(revHeader);
      const plan = planLoad({ local, server: normalize(await res.json()), rev, marker: readMarker() });
      state = plan.state;
      writeMarker(plan.push);
      if (plan.push) void pushToAccount();
      writeLocal();
      return state;
    }
    const file = normalize(await res.json());
    storage = 'file';
    storagePath = decodeURIComponent(res.headers.get(PROGRESS_FILE_HEADER) ?? '');
    // first run with the file: keep whatever the browser already had
    if (isEmpty(file) && !isEmpty(local)) {
      state = local!;
      void pushToFile();
    } else {
      state = file;
    }
  } catch {
    storage = 'browser';
    state = local ?? empty();
  }
  writeLocal();
  return state;
}

let timer: ReturnType<typeof setTimeout> | undefined;
async function pushToFile() {
  try {
    await fetch(PROGRESS_API_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
  } catch {
    /* server gone: localStorage still has it */
  }
}

// Uploads to the account, one request at a time. A 409 means another device wrote first: fetch its copy,
// merge, and upload on top of its revision. A 401 means the session is gone: keep going in the browser.
const MAX_CONFLICT_RETRIES = 3;
let pushing = false;
let pushAgain = false;

async function pushToAccount() {
  if (pushing) {
    pushAgain = true;
    return;
  }
  pushing = true;
  try {
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      const sent = edits;
      const res = await fetch(PROGRESS_API_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', [PROGRESS_REV_HEADER]: String(rev) },
        body: JSON.stringify(state),
      });
      if (res.status === 401) {
        storage = 'browser';
        dropMarker();
        listeners.forEach((fn) => fn());
        return;
      }
      if (res.status === 409) {
        const latest = await fetch(PROGRESS_API_PATH, { cache: 'no-store' });
        if (!latest.ok) return;
        rev = Number(latest.headers.get(PROGRESS_REV_HEADER) ?? rev);
        state = mergeProgress(state, normalize(await latest.json()));
        writeLocal();
        writeMarker(true);
        listeners.forEach((fn) => fn());
        continue;
      }
      if (!res.ok) return;
      rev = (await res.json()).rev;
      writeMarker(edits !== sent);
      if (edits === sent) return;
      // edited while uploading: send the newer state too
    }
  } catch {
    /* offline: the marker stays dirty, the next page load uploads */
  } finally {
    pushing = false;
    if (pushAgain) {
      pushAgain = false;
      void pushToAccount();
    }
  }
}

export function save() {
  state.updatedAt = new Date().toISOString();
  edits++;
  writeLocal();
  if (storage === 'file') {
    clearTimeout(timer);
    timer = setTimeout(pushToFile, SAVE_DEBOUNCE_MS);
  } else if (storage === 'account') {
    writeMarker(true);
    clearTimeout(timer);
    timer = setTimeout(pushToAccount, SAVE_DEBOUNCE_MS);
  }
  listeners.forEach((fn) => fn());
}

/** Signs out: the browser keeps its copy, which is merged into the account again on the next sign-in. */
export async function signOut() {
  if (storage === 'account' && readMarker()?.dirty) {
    clearTimeout(timer);
    await pushToAccount();
  }
  await fetch(LOGOUT_API_PATH, { method: 'POST' });
  dropMarker();
  storage = 'browser';
}

/**
 * Deletes the account with its server copy of the progress. Unsent changes are not uploaded: the browser
 * keeps its copy and goes on with it alone. Returns false when the account could not be deleted (signed
 * out, offline, server error); nothing changes in the browser then.
 */
export async function deleteAccount(): Promise<boolean> {
  try {
    const res = await fetch(ACCOUNT_API_PATH, { method: 'DELETE' });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  clearTimeout(timer);
  dropMarker();
  storage = 'browser';
  writeLocal();
  return true;
}

export function get(): Progress {
  return state;
}

export function chapter(id: string): ChapterProgress {
  return (state.chapters[id] ??= {});
}

export function onChange(fn: () => void) {
  listeners.add(fn);
}

