// Ход урока. Порядок шагов, переходы и решения ведёт код, модель отвечает
// только за живые части. Записанные реплики играем сами и сообщаем о них модели.

import { FunctionResponseScheduling } from '@google/genai';
import { rateFromMime } from './audio.js';
import { buildStepContext, stepTimeoutNote } from './lesson-prompt.js';
import { usageToCost } from './pricing.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class LessonEngine {
  // ui: { stepState, addLine, appendLine, endLines, notice, metrics, addError, status }
  constructor({ lesson, link, mic, player, ui, log, voice }) {
    this.lesson = lesson;
    this.link = link;
    this.mic = mic;
    this.player = player;
    this.ui = ui;
    this.log = log;
    this.voice = voice;

    this.stopped = false;
    this.currentStep = null;
    this.resolveStep = null;
    this.outcomes = {};
    this.errors = [];
    this.pendingRecorded = []; // записанные реплики, о которых модель ещё не знает

    this.modelSpeaking = false;
    this.idleWaiters = [];
    this.lastTurnStartAt = 0;
    this.latencies = [];
    this.totals = { cost: 0, tokens: { audioIn: 0, textIn: 0, audioOut: 0, textOut: 0 } };
  }

  // --- события от Live API ---

  onServerContent(sc) {
    if (sc.interrupted) {
      this.player.flush();
      this.setModelSpeaking(false);
      this.ui.endLines();
      this.log('interrupted');
    }
    for (const part of sc.modelTurn?.parts || []) {
      const data = part.inlineData;
      if (data?.data && data.mimeType?.startsWith('audio/')) {
        if (!this.modelSpeaking) this.onModelTurnStart();
        this.player.playPcm16(data.data, rateFromMime(data.mimeType));
      }
    }
    if (sc.inputTranscription?.text) this.ui.appendLine('student', sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.ui.appendLine('anna', sc.outputTranscription.text);
    if (sc.waitingForInput) this.log('waiting_for_input');
    if (sc.turnComplete) {
      this.setModelSpeaking(false);
      this.ui.endLines();
      this.log('turn_complete', { reason: sc.turnCompleteReason });
    }
  }

  onModelTurnStart() {
    this.setModelSpeaking(true);
    const now = performance.now();
    // Пауза между последним звуком ученика и первым звуком ответа — то, что слышит ученик.
    // Включает время, которое мы нарочно ждём, чтобы не перебивать (silenceMs).
    const since = now - this.mic.lastVoiceAt;
    if (this.mic.lastVoiceAt > this.lastTurnStartAt && since < 10000) {
      this.latencies.push(Math.round(since));
      this.log('latency', { ms: Math.round(since) });
    }
    this.lastTurnStartAt = now;
    this.updateMetrics();
  }

  onToolCall(calls) {
    const responses = [];
    for (const call of calls) {
      const args = call.args || {};
      this.log('tool_call', { name: call.name, args });
      if (call.name === 'complete_step') {
        const stepId = this.currentStep?.id;
        if (stepId) {
          this.outcomes[stepId] = args.outcome;
          if (args.step_id && args.step_id !== stepId) this.log('step_id_mismatch', { expected: stepId, got: args.step_id });
          this.finishStep();
        }
      } else if (call.name === 'log_error') {
        this.errors.push(args);
        this.ui.addError(args);
      }
      responses.push({
        id: call.id,
        name: call.name,
        response: { output: 'ok' },
        scheduling: FunctionResponseScheduling.SILENT,
      });
    }
    this.link.sendToolResponses(responses);
  }

  onUsage(usage) {
    const { tokens, cost } = usageToCost(usage);
    for (const k of Object.keys(this.totals.tokens)) this.totals.tokens[k] += tokens[k] || 0;
    this.totals.cost += cost;
    this.log('usage', { usage, cost });
    this.updateMetrics();
  }

  // --- ход урока ---

  async run() {
    for (const step of this.lesson.steps) {
      if (this.stopped) break;
      if (this.shouldSkip(step)) {
        this.ui.stepState(step.id, 'skipped');
        this.log('step_skip', { step: step.id });
        continue;
      }
      this.ui.stepState(step.id, 'active');
      this.log('step_start', { step: step.id });
      if (step.type === 'recorded') await this.playRecorded(step);
      else await this.runLive(step);
      if (this.stopped) break;
      this.ui.stepState(step.id, 'done');
      this.log('step_end', { step: step.id, outcome: this.outcomes[step.id] });
    }
    if (!this.stopped) this.ui.status('Урок закончен');
  }

  shouldSkip(step) {
    const rule = step.skipIf;
    return Boolean(rule && this.outcomes[rule.step] === rule.outcome);
  }

  async playRecorded(step) {
    // Пока играет запись, микрофон в модель не отправляем, чтобы она не приняла запись за ученика.
    this.mic.enabled = false;
    this.ui.status('Запись');
    this.ui.addLine('anna', step.text, { recorded: true });
    const url = `/audio/${this.lesson.id}/${this.voice}/${step.id}.wav`;
    try {
      await this.player.playUrl(url);
    } catch (err) {
      this.log('recorded_missing', { url, error: err.message });
      this.ui.notice(`Нет записи ${url}. Запусти «npm run audio». Пока показываю текст.`);
      await sleep(Math.min(15000, 1500 + step.text.length * 55));
    }
    this.pendingRecorded.push(step.text);
    this.mic.enabled = true;
  }

  async runLive(step) {
    this.currentStep = step;
    const done = new Promise((resolve) => (this.resolveStep = resolve));
    this.ui.status('Разговор');
    this.link.sendContext(buildStepContext(this.pendingRecorded, step));
    this.pendingRecorded = [];

    const limit = (step.maxSeconds || 120) * 1000;
    const softTimer = setTimeout(() => {
      this.log('step_timeout', { step: step.id });
      this.link.sendContext(buildStepContext([], step, stepTimeoutNote(step)));
    }, limit);
    const hardTimer = setTimeout(() => {
      this.log('step_forced', { step: step.id });
      this.finishStep();
    }, limit + 30000);

    await done;
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    await this.waitModelIdle();
    this.currentStep = null;
  }

  finishStep() {
    const resolve = this.resolveStep;
    this.resolveStep = null;
    resolve?.();
  }

  setModelSpeaking(value) {
    this.modelSpeaking = value;
    if (!value) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((r) => r());
    }
  }

  // Ждём, пока Анна договорит и звук доиграет (но не дольше 15 секунд).
  async waitModelIdle() {
    const idle = this.modelSpeaking ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
    await Promise.race([idle.then(() => this.player.waitDrained()), sleep(15000)]);
  }

  stop() {
    this.stopped = true;
    this.finishStep();
    this.setModelSpeaking(false);
  }

  updateMetrics() {
    this.ui.metrics({
      cost: this.totals.cost,
      tokens: this.totals.tokens,
      latencyMedian: median(this.latencies),
      latencyCount: this.latencies.length,
    });
  }

  summary() {
    return {
      outcomes: this.outcomes,
      errors: this.errors,
      latencies: this.latencies,
      latencyMedian: median(this.latencies),
      totals: this.totals,
    };
  }
}
