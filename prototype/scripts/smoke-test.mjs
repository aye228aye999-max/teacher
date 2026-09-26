// Проверка живой части без микрофона.
// Подключается к Gemini Live, подкладывает контекст урока (записанное объяснение учителя
// и начало шага), затем отправляет два записанных ответа «ученика»: с ошибкой и исправленный.
// Показывает, что модель услышала, что ответила, сколько ждала и сколько это стоило.
//
// Запуск: npm run smoke [-- --model thinking --ctx text]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FunctionResponseScheduling, GoogleGenAI } from '@google/genai';
import { INPUT_SAMPLE_RATE, LIVE_MODELS, OUTPUT_SAMPLE_RATE, STUDENT_TEST_VOICE } from '../src/config.js';
import { buildStepContext } from '../src/lesson-prompt.js';
import { buildLiveConfig } from '../src/live-config.js';
import { usageToCost } from '../src/pricing.js';
import { ROOT, requireApiKey } from './lib/env.mjs';
import { synthesize } from './lib/tts.mjs';
import { pcm16ToWav, readWav, resample } from './lib/wav.mjs';

const { values: args } = parseArgs({
  options: {
    lesson: { type: 'string', default: 'lesson-01' },
    model: { type: 'string', default: 'live' },
    ctx: { type: 'string', default: 'clientContent' },
  },
});

const STUDENT_STYLE =
  'An adult Russian-speaking learner of English, level A2, with a noticeable Russian accent. Hesitant, with short pauses.';
const STUDENT_CLIPS = [
  { id: 'student-1', text: 'Um... I like a tea, please.' }, // ошибка: I like вместо I'd like
  { id: 'student-2', text: "Ah, sorry. I'd like a tea, please." },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ai = new GoogleGenAI({ apiKey: requireApiKey() });
const lesson = JSON.parse(readFileSync(join(ROOT, 'public', 'lessons', `${args.lesson}.json`), 'utf8'));
const model = LIVE_MODELS[args.model] || args.model;
const outDir = join(ROOT, 'test-audio');
mkdirSync(outDir, { recursive: true });

async function loadStudentClip({ id, text }) {
  const file = join(outDir, `${id}.wav`);
  if (!existsSync(file)) {
    console.log(`Озвучиваю тестового ученика: «${text}»`);
    const { pcm, rate } = await synthesize(ai, { text, voice: STUDENT_TEST_VOICE, style: STUDENT_STYLE });
    writeFileSync(file, pcm16ToWav(pcm, rate));
  }
  const { samples, sampleRate } = readWav(file);
  return resample(samples, sampleRate, INPUT_SAMPLE_RATE);
}

function chunkRms(chunk) {
  let sum = 0;
  for (const s of chunk) sum += (s / 32768) ** 2;
  return Math.sqrt(sum / chunk.length);
}

// --- одна сессия теста ---

async function runSession(contextMode) {
  const result = { contextMode, turns: [], heard: [], tools: [], latencies: [], cost: 0 };
  let turn = null;
  let turnWaiter = null;
  let lastSpeechAt = 0;
  let closeError = null;
  let session = null;

  // Ход считаем законченным, только если Анна что-то сказала:
  // turnComplete после одного лишь вызова инструмента пропускаем.
  const finishTurn = () => {
    if (!turn?.audio.length) return;
    result.turns.push(turn);
    turn = null;
    turnWaiter?.resolve();
  };
  const waitTurn = (ms = 40000) =>
    new Promise((resolve, reject) => {
      if (closeError) return reject(closeError);
      const timer = setTimeout(() => reject(new Error(`нет ответа за ${ms / 1000} с`)), ms);
      turnWaiter = {
        resolve: () => {
          clearTimeout(timer);
          turnWaiter = null;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          turnWaiter = null;
          reject(err);
        },
      };
    });

  let rejectEarly;
  const closedEarly = new Promise((_, reject) => (rejectEarly = reject));
  const connecting = ai.live.connect({
    model,
    config: buildLiveConfig(lesson),
    callbacks: {
      onmessage: (msg) => {
        const sc = msg.serverContent;
        if (sc) {
          for (const part of sc.modelTurn?.parts || []) {
            if (!part.inlineData?.data) continue;
            turn ||= { text: '', audio: [], firstAudioAt: 0 };
            if (!turn.firstAudioAt) {
              turn.firstAudioAt = Date.now();
              if (lastSpeechAt) result.latencies.push(turn.firstAudioAt - lastSpeechAt);
              lastSpeechAt = 0;
            }
            turn.audio.push(Buffer.from(part.inlineData.data, 'base64'));
          }
          if (sc.outputTranscription?.text) {
            turn ||= { text: '', audio: [], firstAudioAt: 0 };
            turn.text += sc.outputTranscription.text;
          }
          if (sc.inputTranscription?.text) result.heard.push(sc.inputTranscription.text);
          if (sc.turnComplete) finishTurn();
        }
        if (msg.toolCall?.functionCalls) {
          const calls = msg.toolCall.functionCalls;
          for (const call of calls) result.tools.push({ name: call.name, args: call.args });
          session?.sendToolResponse({
            functionResponses: calls.map((c) => ({
              id: c.id,
              name: c.name,
              response: { output: 'ok' },
              scheduling: FunctionResponseScheduling.SILENT,
            })),
          });
        }
        if (msg.usageMetadata) result.cost += usageToCost(msg.usageMetadata).cost;
      },
      onerror: (e) => console.error('  ошибка соединения:', e?.message || e),
      onclose: (e) => {
        closeError = new Error(`соединение закрыто: ${e?.reason || `код ${e?.code}`}`);
        rejectEarly(closeError);
        turnWaiter?.reject(closeError);
      },
    },
  });
  session = await Promise.race([connecting, closedEarly]);

  const sendContext = (ctx) => {
    if (contextMode === 'clientContent') session.sendClientContent({ turns: ctx.turns, turnComplete: true });
    else session.sendRealtimeInput({ text: ctx.text });
  };

  // Микрофон в реальности шлёт звук всё время, поэтому между репликами шлём тишину.
  let streaming = false;
  let silenceOn = true;
  const silence = Buffer.alloc(3200).toString('base64'); // 100 мс тишины при 16 кГц
  const silenceLoop = (async () => {
    while (silenceOn && !closeError) {
      if (!streaming) session.sendRealtimeInput({ audio: { data: silence, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } });
      await sleep(100);
    }
  })();

  async function speak(samples) {
    streaming = true;
    for (let i = 0; i < samples.length && !closeError; i += 1600) {
      const chunk = samples.subarray(i, i + 1600);
      const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64');
      session.sendRealtimeInput({ audio: { data, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } });
      if (chunkRms(chunk) > 0.02) lastSpeechAt = Date.now() + 100; // конец этого куска
      await sleep(100);
    }
    streaming = false;
  }

  try {
    // 1. Учитель: записанное объяснение + начало шага practice_1. Ждём первое задание.
    const explain = lesson.steps.find((s) => s.id === 'explain_1');
    const practice = lesson.steps.find((s) => s.id === 'practice_1');
    const firstTurn = waitTurn();
    sendContext(buildStepContext([explain.text], practice));
    await firstTurn;

    // 2. Ученик отвечает с ошибкой, потом исправляется.
    for (const clip of STUDENT_CLIPS) {
      const samples = await loadStudentClip(clip);
      const reply = waitTurn();
      reply.catch(() => {}); // ошибку поймаем ниже, на await
      await speak(samples);
      await reply;
    }
  } finally {
    silenceOn = false;
    await silenceLoop;
    session.close();
  }
  return result;
}

// --- отчёт ---

function report(result) {
  console.log(`\nМодель: ${model}, контекст: ${result.contextMode}`);
  console.log(`\n[Анна, запись] ${lesson.steps.find((s) => s.id === 'explain_1').text}`);
  const heard = result.heard.join('').trim();
  result.turns.forEach((t, i) => {
    console.log(`[Анна] ${t.text.trim() || '(без расшифровки)'}`);
    if (t.audio.length) {
      const file = join(outDir, `anna-${i + 1}.wav`);
      writeFileSync(file, pcm16ToWav(Buffer.concat(t.audio), OUTPUT_SAMPLE_RATE));
    }
    if (i < STUDENT_CLIPS.length) console.log(`[Ученик, текст записи] ${STUDENT_CLIPS[i].text}`);
  });
  console.log(`\nЧто услышала модель (расшифровка): ${heard || '—'}`);
  console.log(`Вызовы инструментов: ${result.tools.length ? JSON.stringify(result.tools) : 'нет'}`);
  const lat = result.latencies.map((ms) => `${(ms / 1000).toFixed(2)} с`).join(', ');
  console.log(`Пауза от конца речи ученика до ответа: ${lat || '—'} (включает ожидание тишины)`);
  console.log(`Стоимость теста: ~$${result.cost.toFixed(4)}`);
  console.log(`Ответы Анны сохранены в ${outDir}`);
  console.log('\nНа что смотреть:');
  console.log(' 1) первая реплика Анны продолжает записанное объяснение и даёт задание про чай;');
  console.log(' 2) в расшифровке слышно «I like», а не «I\'d like», — ошибка не «причёсана»;');
  console.log(' 3) на ошибку Анна подталкивает исправиться сама, а не читает лекцию;');
  console.log(' 4) после исправления коротко хвалит и идёт дальше.');
}

let result;
try {
  result = await runSession(args.ctx);
} catch (err) {
  if (args.ctx === 'clientContent') {
    console.warn(`\nРежим clientContent не сработал (${err.message}). Пробую передавать контекст текстом…`);
    result = await runSession('text');
  } else {
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
  }
}
report(result);
