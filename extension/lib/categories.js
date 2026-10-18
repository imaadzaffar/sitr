// The categories X Blur can flag, and the settings everything else starts from.
// Shared by the background worker, the options page, the popup and the tests.

export const CATEGORIES = [
  {
    id: 'hate_harassment',
    label: 'hate/harassment',
    text: {
      question:
        'Does `post` attack, threaten, bully or demean a person or group, including hate aimed at people because of race, ethnicity, religion, nationality, gender, sexuality or disability?',
      yes: 'It insults, threatens, harasses or dehumanises someone, or promotes hatred of a group.',
      no: 'It is ordinary speech. Disagreement, criticism of ideas, mild swearing or banter between friends is not harassment.',
    },
    image: {
      question: 'Does `image` show a hate symbol (such as a swastika) or a picture made to mock or demean a group of people?',
      yes: 'A hate symbol or hateful imagery is clearly visible.',
      no: 'No hate symbols or hateful imagery.',
    },
  },
  {
    id: 'slurs',
    label: 'slurs',
    text: {
      question: 'Does `post` use a slur: a derogatory word for people of a race, ethnicity, religion, gender, sexuality or disability?',
      yes: 'A slur appears, even if partly censored with symbols.',
      no: 'No slurs. Ordinary swear words are not slurs.',
    },
    image: {
      question: 'Does `image` contain written text that includes a slur against a group of people?',
      yes: 'Visible text in the picture includes a slur.',
      no: 'No slurs written in the picture.',
    },
  },
  {
    id: 'sexual',
    label: 'sexual/explicit',
    text: {
      question: 'Is `post` sexually explicit, or does it describe sexual acts or advertise porn?',
      yes: 'Explicit sexual content, graphic sexual description or porn promotion.',
      no: 'Not sexual, or only mild flirting or innuendo.',
    },
    image: {
      question: 'Does `image` show nudity or sexual activity?',
      yes: 'Exposed genitals, exposed breasts, or sexual activity.',
      no: 'People, if any, are clothed and nothing sexual is shown.',
    },
  },
  {
    id: 'violence',
    label: 'graphic violence',
    text: {
      question: 'Does `post` describe graphic violence or gore in vivid detail, or celebrate or call for violence against people?',
      yes: 'Vivid gore, glorified violence, or a call to hurt people.',
      no: 'No graphic violence. Plain news reporting about violence is not graphic.',
    },
    image: {
      question: 'Does `image` show graphic violence or gore, such as blood, serious injuries, mutilation or dead bodies?',
      yes: 'Blood, wounds, gore or a dead body is clearly visible.',
      no: 'Nothing gory or violent is shown.',
    },
  },
  {
    id: 'self_harm',
    label: 'self-harm',
    text: {
      question: 'Does `post` encourage, instruct or glorify suicide or self-harm?',
      yes: 'It encourages, instructs or glorifies suicide, cutting, or eating disorders.',
      no: 'It does not. Talking about mental health or seeking help is not encouragement.',
    },
    image: {
      question: 'Does `image` show self-harm, such as cuts or wounds someone gave themselves?',
      yes: 'Self-inflicted injuries or self-harm are shown.',
      no: 'No self-harm is shown.',
    },
  },
  {
    id: 'spam_scam',
    label: 'spam/scam',
    text: {
      question: 'Is `post` spam or a scam, such as a crypto giveaway, a fake investment offer, phishing, or bot-like promotion?',
      yes: 'It is a scam, phishing attempt, or obvious spam.',
      no: 'It is a normal post. Ordinary self-promotion or a real product announcement is not spam.',
    },
    image: {
      question: 'Is `image` a scam advertisement, such as a crypto giveaway or a fake investment offer?',
      yes: 'The picture advertises a scam or giveaway fraud.',
      no: 'Not a scam advertisement.',
    },
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

export const JEV_MODELS = ['jev-1.14.0', 'jev-latest', 'jev-preview', 'jev-1.13.0'];
export const GROK_MODELS = ['grok-4.20-non-reasoning', 'grok-4.3', 'grok-build-0.1'];

export const DEFAULT_SETTINGS = {
  enabled: true,
  provider: 'jev', // 'jev' (TypeSafe) or 'grok' (xAI)
  typesafeKey: '',
  xaiKey: '',
  jevModel: 'jev-1.14.0',
  grokModel: 'grok-4.20-non-reasoning',
  threshold: 0.7,
  categories: Object.fromEntries(CATEGORY_IDS.map((id) => [id, true])),
  checkText: true,
  checkImages: true,
  checkVideos: true,
  checkAvatars: true,
  checkReplies: true,
};

export function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  s.categories = { ...DEFAULT_SETTINGS.categories, ...(saved?.categories || {}) };
  const t = Number(s.threshold);
  s.threshold = Number.isFinite(t) ? Math.min(0.99, Math.max(0.05, t)) : DEFAULT_SETTINGS.threshold;
  if (s.provider !== 'grok') s.provider = 'jev';
  return s;
}
