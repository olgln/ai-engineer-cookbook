// Machine-level settings for the local server, read from the environment.
// Values come from the shell or from site/.env (see .env.example); the shell wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: '4321',
  PROGRESS_FILE: '~/.ai-engineer-cookbook/progress.json',
  PROGRESS_MAX_BYTES: String(2 * 1024 * 1024),
};

const read = (name) => process.env[name]?.trim() || DEFAULTS[name];

function positiveInt(name) {
  const value = Number(read(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${read(name)}"`);
  return value;
}

/** Expand a leading ~ to the home directory and make the path absolute. */
const expandHome = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

export const config = {
  host: read('HOST'),
  port: positiveInt('PORT'),
  progressFile: expandHome(read('PROGRESS_FILE')),
  progressMaxBytes: positiveInt('PROGRESS_MAX_BYTES'),
};
