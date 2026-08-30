/**
 * Locally bundled British-English speech; no browser voice service is required.
 * Phrase clips are synthesized, unlike the existing milk/bread human recordings.
 * Provenance: /assets/sim3d/audio/phrase-SOURCES.md
 */
export const SPEECH_CLIPS = {
  greeting: {
    text: "Hello!",
    zh: "你好！",
    src: "/assets/sim3d/audio/greeting.wav",
  },
  card: {
    text: "Can I pay by card, please?",
    zh: "请问可以刷卡吗？",
    src: "/assets/sim3d/audio/card.wav",
  },
  thanks: {
    text: "Thank you. Have a lovely day!",
    zh: "谢谢，祝你今天愉快！",
    src: "/assets/sim3d/audio/thanks.wav",
  },
  milkPhrase: {
    text: "A carton of milk.",
    zh: "一盒牛奶。",
    src: "/assets/sim3d/audio/milk-phrase.wav",
  },
  breadPhrase: {
    text: "A loaf of bread.",
    zh: "一条面包。",
    src: "/assets/sim3d/audio/bread-phrase.wav",
  },
  repeatRequest: {
    text: "Could you say that again, please?",
    zh: "请再说一遍，好吗？",
    src: "/assets/sim3d/audio/repeat-request.wav",
  },
  affirmative: {
    text: "Yes, of course.",
    zh: "好的，当然可以。",
    src: "/assets/sim3d/audio/affirmative.wav",
  },
  cardRepeat: {
    text: "Sorry, can I pay by card?",
    zh: "不好意思，我可以刷卡吗？",
    src: "/assets/sim3d/audio/card-repeat.wav",
  },
} as const;

export type SpeechClipId = keyof typeof SPEECH_CLIPS;
