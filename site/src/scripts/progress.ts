// Learning progress: stored in the progress file through the local server's API,
// mirrored to localStorage (and used alone when the API is unavailable).
import { PROGRESS_API_PATH, PROGRESS_FILE_HEADER, SAVE_DEBOUNCE_MS, STORAGE_KEY } from '../config/app.mjs';

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
  version: 1;
  updatedAt?: string;
  chapters: Record<string, ChapterProgress>;
}

let state: Progress = { version: 1, chapters: {} };
export let storage: 'file' | 'browser' = 'browser';
export let storagePath = '';
const listeners = new Set<() => void>();

function normalize(raw: unknown): Progress {
  const p = raw as Partial<Progress> | null;
  if (!p || typeof p !== 'object' || typeof p.chapters !== 'object' || !p.chapters) return { version: 1, chapters: {} };
  return { version: 1, updatedAt: p.updatedAt, chapters: p.chapters };
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

export async function load(): Promise<Progress> {
  const local = readLocal();
  try {
    const res = await fetch(PROGRESS_API_PATH, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('no api');
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
    state = local ?? { version: 1, chapters: {} };
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

export function save() {
  state.updatedAt = new Date().toISOString();
  writeLocal();
  if (storage === 'file') {
    clearTimeout(timer);
    timer = setTimeout(pushToFile, SAVE_DEBOUNCE_MS);
  }
  listeners.forEach((fn) => fn());
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

export function replaceAll(next: unknown) {
  state = normalize(next);
  save();
}
