// Читает prototype/.env (если есть) и возвращает ключ Gemini.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function requireApiKey() {
  loadEnv();
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('Нет GEMINI_API_KEY. Скопируй .env.example в .env и впиши туда ключ из Google AI Studio.');
    process.exit(1);
  }
  return key;
}
