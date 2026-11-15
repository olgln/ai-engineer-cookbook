// Machine-level settings for the build and the local server, read from the environment.
// Values come from the shell or from site/.env (see .env.example); the shell wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

/** Every setting with its default; site/.env.example lists the same names (tests/site/settings.test.mjs). */
export const DEFAULTS = {
  HOST: '127.0.0.1',
  PORT: '4321',
  PROGRESS_FILE: '~/.ai-engineer-cookbook/progress.json',
  PROGRESS_MAX_BYTES: String(2 * 1024 * 1024),
  SITE_URL: '',
  GOOGLE_SITE_VERIFICATION: '',
  YANDEX_VERIFICATION: '',
  CLOUDFLARE_WEB_ANALYTICS_TOKEN: '',
};

const read = (name) => process.env[name]?.trim() || DEFAULTS[name];

function positiveInt(name) {
  const value = Number(read(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${read(name)}"`);
  return value;
}

/** Public address of the deployed site, e.g. https://cookbook.example.com; empty for a local build. */
export function siteUrl(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`SITE_URL must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`SITE_URL must be http(s), got "${value}"`);
  return url.href;
}

/**
 * Public token put into an HTML attribute on every page: an ownership token from a search console
 * (Google Search Console, Yandex Webmaster) or the Cloudflare Web Analytics site token; empty when
 * not set. Tokens are letters, digits, `-` and `_`.
 */
export function publicToken(name, value) {
  if (!value) return undefined;
  if (!/^[\w-]+$/.test(value)) throw new Error(`${name} must hold only letters, digits, - and _, got "${value}"`);
  return value;
}

/** Expand a leading ~ to the home directory and make the path absolute. */
const expandHome = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

/** Host names the progress API answers to; anything else (e.g. a DNS-rebinding domain) is refused. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = ['0.0.0.0', '::', '[::]'];

const host = read('HOST');

export const config = {
  host,
  port: positiveInt('PORT'),
  progressFile: expandHome(read('PROGRESS_FILE')),
  progressMaxBytes: positiveInt('PROGRESS_MAX_BYTES'),
  siteUrl: siteUrl(read('SITE_URL')),
  googleSiteVerification: publicToken('GOOGLE_SITE_VERIFICATION', read('GOOGLE_SITE_VERIFICATION')),
  yandexVerification: publicToken('YANDEX_VERIFICATION', read('YANDEX_VERIFICATION')),
  webAnalyticsToken: publicToken('CLOUDFLARE_WEB_ANALYTICS_TOKEN', read('CLOUDFLARE_WEB_ANALYTICS_TOKEN')),
  allowedHosts: new Set(WILDCARD_HOSTS.includes(host) ? LOOPBACK_HOSTS : [...LOOPBACK_HOSTS, host]),
};
