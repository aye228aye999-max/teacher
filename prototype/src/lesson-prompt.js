// Инструкции для модели и инструменты урока. Общий модуль для браузера и автотеста.
// Сами инструкции на английском: так модель следует им надёжнее.

import { Behavior, Type } from '@google/genai';

const PERSONA = `You are Anna, a warm, upbeat English tutor. Your student is a Russian-speaking adult at level A2.
You are an AI tutor. If the student asks whether you are a real person or an AI, say honestly that you are an AI tutor, then carry on.`;

const SPEAKING = `HOW YOU SPEAK
- English by default. Simple A2 words, short sentences, a relaxed and slightly slower pace.
- Russian only when the student is stuck or asks for it: at most one short sentence, then back to English.
- One or two short sentences per turn. One question at a time. No lists, no lectures.
- React to what the student says, not only to how they say it. Be curious and a little playful.
- Praise briefly and specifically ("Nice, very polite!"), not after every line. Never say "Great question".`;

const LISTENING = `LISTENING
- Students often pause mid-sentence to find a word. Wait. Never finish their sentence for them.
- If they are clearly stuck (a long silence, "эээ", "ммм"), give a tiny hint: the first word or the item, not the full answer.
- If you did not clearly hear what they said, do not guess and do not correct. Ask them to repeat: "Sorry, could you say that again?"`;

const CORRECTIONS = `CORRECTIONS
- Correct only (a) mistakes with today's target and (b) mistakes that make the meaning unclear.
- First help the student fix it themselves: repeat their phrase up to the mistake with a questioning tone, or give a short hint ("With 'to'?"). Give the correct version only after two unsuccessful tries.
- Other small mistakes: do not mention them now. Call log_error, and mention at most two of them in the wrap-up.
- Accept correct alternatives ("Could I have a tea, please?") as correct, then show the target once ("Perfect. You can also say: I'd like a tea.").`;

const FLOW = `LESSON FLOW
- The app runs the lesson. It sends notes in square brackets, like [STEP practice_1 ...]. Follow only the current step. Never read notes aloud and never mention steps, tools or the app.
- Some parts of the lesson are pre-recorded in your own voice. The app adds them to the conversation as your turns. Treat them as things you said and continue naturally from them.
- When the current step's goal is reached, or the app says time is up, call complete_step. Finish your sentence first and do not announce the transition.`;

function describeStep(step) {
  if (step.type === 'recorded') {
    return `- ${step.id} (pre-recorded, you say): "${step.text}"`;
  }
  return `- ${step.id} (live): ${step.goal}`;
}

export function buildSystemInstruction(lesson) {
  const plan = lesson.steps.map(describeStep).join('\n');
  return [
    PERSONA,
    `TODAY'S TARGET: ${lesson.target}`,
    SPEAKING,
    LISTENING,
    CORRECTIONS,
    FLOW,
    `LESSON PLAN (for context; the app tells you when each step starts)\n${plan}`,
  ].join('\n\n');
}

// Инструменты: через них модель сообщает коду, что происходит на уроке.
// NON_BLOCKING + ответ SILENT: модель не ждёт ответа и не комментирует его вслух.
export const LESSON_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'complete_step',
        description:
          "Call when the current lesson step's goal is reached or the app says time is up. The app then moves to the next step.",
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            step_id: { type: Type.STRING, description: 'Id of the current step, e.g. practice_1.' },
            outcome: {
              type: Type.STRING,
              description: 'Step result, e.g. ok, struggling, target_used, target_not_used, done.',
            },
            note: { type: Type.STRING, description: 'One short sentence about how it went.' },
          },
          required: ['step_id', 'outcome'],
        },
      },
      {
        name: 'log_error',
        description:
          "Silently log a student's mistake that you are not correcting right now, for the wrap-up and future review.",
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            said: { type: Type.STRING, description: 'What the student said.' },
            correct: { type: Type.STRING, description: 'The correct version.' },
            type: { type: Type.STRING, description: 'grammar, vocabulary or pronunciation.' },
          },
          required: ['said', 'correct'],
        },
      },
    ],
  },
];

// Заметка о начале живого шага.
export function stepStartNote(step) {
  return `[STEP ${step.id} starts now. ${step.goal}]`;
}

// Заметка, когда время шага вышло.
export function stepTimeoutNote(step) {
  return `[STEP ${step.id}: time is up. Close this part in one short sentence, then call complete_step.]`;
}

// Контекст перед живым шагом: предыдущие записанные реплики как ходы Анны
// и заметка о новом шаге. Возвращает оба варианта отправки:
// clientContent (роли model/user) и одну текстовую строку (запасной путь).
export function buildStepContext(recordedTexts, step, note = stepStartNote(step)) {
  const turns = [
    ...recordedTexts.map((text) => ({ role: 'model', parts: [{ text }] })),
    { role: 'user', parts: [{ text: note }] },
  ];
  const recorded = recordedTexts.map((t) => `[Anna just said (pre-recorded): "${t}"]`);
  const text = [...recorded, note].join('\n');
  return { turns, text };
}
