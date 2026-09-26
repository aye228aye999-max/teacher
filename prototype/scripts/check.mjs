// Проверяет ключ и что нужные модели доступны этому ключу.
// Запуск: npm run check

import { GoogleGenAI } from '@google/genai';
import { LIVE_MODELS, TTS_MODEL } from '../src/config.js';
import { requireApiKey } from './lib/env.mjs';

const ai = new GoogleGenAI({ apiKey: requireApiKey() });
const wanted = [LIVE_MODELS.live, LIVE_MODELS.thinking, TTS_MODEL];

try {
  const found = new Set();
  const related = [];
  const pager = await ai.models.list({ config: { pageSize: 200 } });
  for await (const m of pager) {
    const id = (m.name || '').replace(/^models\//, '');
    found.add(id);
    if (/live|tts|native-audio/i.test(id)) related.push(id);
  }
  console.log('Ключ работает.');
  for (const id of wanted) console.log(`${found.has(id) ? '✓' : '✗'} ${id}`);
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length) {
    console.log('\nГолосовые модели, доступные ключу:');
    related.sort().forEach((id) => console.log(`  ${id}`));
    console.log('\nЕсли нужной модели нет, поменяй идентификатор в src/config.js.');
  }
} catch (err) {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
}
