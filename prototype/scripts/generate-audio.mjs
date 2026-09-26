// Озвучивает записанные реплики урока через Gemini TTS тем же голосом, что и в живом разговоре.
// Запуск: npm run audio [-- --lesson lesson-01 --voice Kore --force]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { TEACHER_VOICE, TTS_MODEL } from '../src/config.js';
import { ROOT, requireApiKey } from './lib/env.mjs';
import { synthesize } from './lib/tts.mjs';
import { durationSec, pcm16ToWav } from './lib/wav.mjs';

const { values: args } = parseArgs({
  options: {
    lesson: { type: 'string', default: 'lesson-01' },
    voice: { type: 'string', default: TEACHER_VOICE },
    force: { type: 'boolean', default: false },
  },
});

const ai = new GoogleGenAI({ apiKey: requireApiKey() });
const lesson = JSON.parse(readFileSync(join(ROOT, 'public', 'lessons', `${args.lesson}.json`), 'utf8'));
const outDir = join(ROOT, 'public', 'audio', lesson.id, args.voice);
mkdirSync(outDir, { recursive: true });

const recorded = lesson.steps.filter((s) => s.type === 'recorded');
console.log(`Урок ${lesson.id}, голос ${args.voice}, модель ${TTS_MODEL}: записей ${recorded.length}`);
try {
  for (const step of recorded) {
    const file = join(outDir, `${step.id}.wav`);
    if (existsSync(file) && !args.force) {
      console.log(`  ${step.id}: уже есть, пропускаю (--force, чтобы перезаписать)`);
      continue;
    }
    const { pcm, rate } = await synthesize(ai, { text: step.text, voice: args.voice, style: lesson.ttsStyle });
    writeFileSync(file, pcm16ToWav(pcm, rate));
    console.log(`  ${step.id}: ${durationSec(pcm.length, rate).toFixed(1)} с → ${file}`);
  }
  console.log('Готово. Прослушай файлы: если прозвучал служебный текст, поправь ttsStyle в уроке.');
} catch (err) {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
}
