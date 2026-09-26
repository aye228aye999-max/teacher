// Страница тестового урока: кнопки, стенограмма, метрики и журнал.

import { Mic, Player } from './audio.js';
import { DEFAULT_SILENCE_MS, LIVE_MODELS, TEACHER_VOICE } from './config.js';
import { LessonEngine } from './lesson-engine.js';
import { LiveLink } from './live-link.js';

const VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Despina', 'Sulafat', 'Puck', 'Charon'];

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const lessonId = params.get('lesson') || 'lesson-01';

// --- журнал ---

const events = [];
const lines = [];
let startedAt = Date.now();

function log(type, data) {
  events.push({ t: Date.now() - startedAt, type, ...(data === undefined ? {} : { data }) });
}

// --- интерфейс ---

let openLine = null; // незакрытая реплика, в которую дописываем расшифровку

function newLine(who, text, recorded = false) {
  const el = document.createElement('div');
  el.className = `line ${who}${recorded ? ' recorded' : ''}`;
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = who === 'anna' ? (recorded ? 'Анна · запись' : 'Анна') : 'Ты';
  const body = document.createElement('span');
  body.className = 'text';
  body.textContent = text;
  el.append(name, body);
  $('transcript').append(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  const line = { who, text, recorded, t: Date.now() - startedAt, el: body };
  lines.push(line);
  return line;
}

const ui = {
  stepState(id, state) {
    const li = document.querySelector(`#steps li[data-id="${id}"]`);
    if (li) li.dataset.state = state;
  },
  addLine(who, text, { recorded = false } = {}) {
    openLine = null;
    newLine(who, text, recorded);
  },
  appendLine(who, text) {
    if (openLine && openLine.who === who) {
      openLine.text += text;
      openLine.el.textContent = openLine.text;
    } else {
      openLine = newLine(who, text.trimStart());
    }
  },
  endLines() {
    openLine = null;
  },
  notice(message) {
    const box = $('notice');
    box.textContent = message;
    box.hidden = false;
  },
  status(text) {
    $('status').textContent = text;
  },
  metrics({ cost, tokens, latencyMedian, latencyCount }) {
    $('cost').textContent = `$${cost.toFixed(4)}`;
    $('latency').textContent = latencyMedian == null ? '—' : `${(latencyMedian / 1000).toFixed(2)} с (${latencyCount})`;
    const audio = tokens.audioIn + tokens.audioOut;
    const text = tokens.textIn + tokens.textOut;
    $('tokens').textContent = `${audio} / ${text}`;
  },
  addError({ said, correct }) {
    $('errors-box').hidden = false;
    const li = document.createElement('li');
    li.textContent = `${said} → ${correct}`;
    $('errors').append(li);
  },
};

function renderSteps(lesson) {
  const list = $('steps');
  list.replaceChildren();
  for (const step of lesson.steps) {
    const li = document.createElement('li');
    li.dataset.id = step.id;
    li.dataset.state = 'pending';
    li.textContent = step.type === 'recorded' ? `${step.id} · запись` : step.id;
    list.append(li);
  }
}

function setDot(state) {
  $('dot').dataset.state = state;
}

// --- настройки ---

for (const v of VOICES) {
  const opt = document.createElement('option');
  opt.value = v;
  opt.textContent = v;
  $('voice').append(opt);
}
$('voice').value = params.get('voice') || TEACHER_VOICE;
$('model').value = params.get('model') === 'thinking' ? 'thinking' : 'live';
$('silence').value = params.get('silence') || DEFAULT_SILENCE_MS;
$('ctx').value = params.get('ctx') === 'text' ? 'text' : 'clientContent';

// --- урок ---

let lesson;
let engine;
let link;
let mic;
let player;
let audioCtx;
let settings;

async function loadLesson() {
  const res = await fetch(`/lessons/${lessonId}.json`);
  if (!res.ok) throw new Error(`Урок ${lessonId} не найден`);
  lesson = await res.json();
  $('title').textContent = lesson.title;
  document.title = lesson.title;
  renderSteps(lesson);
}

async function start() {
  finished = false;
  $('start').disabled = true;
  $('settings').open = false;
  $('notice').hidden = true;
  $('transcript').replaceChildren();
  events.length = 0;
  lines.length = 0;
  startedAt = Date.now();
  renderSteps(lesson);
  ui.status('Подключаюсь…');
  setDot('busy');

  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();
    player = new Player(audioCtx);
    mic = new Mic(audioCtx);
    await mic.start();

    settings = {
      lesson: lesson.id,
      model: LIVE_MODELS[$('model').value],
      voice: $('voice').value,
      silenceMs: Number($('silence').value) || DEFAULT_SILENCE_MS,
      contextMode: $('ctx').value,
      proactive: params.get('proactive') === '1',
      affective: params.get('affective') === '1',
    };
    log('settings', settings);

    engine = new LessonEngine({ lesson, link: null, mic, player, ui, log, voice: settings.voice });
    link = new LiveLink({
      lesson,
      model: settings.model,
      contextMode: settings.contextMode,
      options: {
        voice: settings.voice,
        silenceMs: settings.silenceMs,
        proactive: settings.proactive,
        affective: settings.affective,
      },
      log,
      handlers: {
        onServerContent: (sc) => engine.onServerContent(sc),
        onToolCall: (calls) => engine.onToolCall(calls),
        onUsage: (usage) => engine.onUsage(usage),
        onStatus: (s) => {
          if (s === 'reconnecting') ui.status('Переподключаюсь…');
          setDot(s === 'connected' ? 'live' : 'busy');
        },
        onError: (message) => ui.notice(message),
      },
    });
    engine.link = link;

    await link.connect();
    mic.onChunk = (pcm) => link.sendAudio(pcm);
    mic.enabled = true;
    setDot('live');
    $('stop').disabled = false;
    $('download').disabled = false;

    await engine.run();
    finish('Урок закончен');
  } catch (err) {
    log('fatal', { message: err.message });
    ui.notice(`Ошибка: ${err.message}`);
    finish('Остановлено из-за ошибки');
  }
}

let finished = true;

function finish(statusText) {
  if (finished) return;
  finished = true;
  engine?.stop();
  link?.close();
  player?.stopAll();
  mic?.stop();
  setDot('off');
  ui.status(statusText);
  $('start').disabled = false;
  $('stop').disabled = true;
  $('download').disabled = events.length === 0;
}

function download() {
  const report = {
    exportedAt: new Date().toISOString(),
    settings,
    summary: engine?.summary(),
    transcript: lines.map(({ who, text, recorded, t }) => ({ t, who, recorded, text })),
    events,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${lesson.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => {
  log('stopped_by_user');
  finish('Остановлено');
});
$('download').addEventListener('click', download);

loadLesson().catch((err) => ui.notice(err.message));
