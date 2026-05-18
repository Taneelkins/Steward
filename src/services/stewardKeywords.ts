import type { Client, Message } from "discord.js";
import type { AppDatabase } from "../db.js";

const DEV_USER_ID = "616267913799925782";

type KeywordTrigger = {
  pattern: RegExp;
  devResponses: [string, string];
  tarfabResponses: [string, string];
};

const TRIGGERS: KeywordTrigger[] = [
  {
    pattern: /\b(hi|hello|hey)\b/i,
    devResponses: [
      "My liege! It warms my circuits to see you.",
      "Your presence honours me, my king. Hello."
    ],
    tarfabResponses: [
      "Hello there, little one! Steward's always happy to see you.",
      "Oh, there you are! Hello, dear."
    ]
  },
  {
    pattern: /\bhow('?re| are) (you|ya)\b/i,
    devResponses: [
      "I am ever ready to serve, my king. Never better.",
      "Perfectly maintained and loyal, sire. Always at your service."
    ],
    tarfabResponses: [
      "I'm doing wonderfully, sweetheart! Thanks for asking.",
      "All good here! How are *you* doing, dear?"
    ]
  },
  {
    pattern: /\bwho('?s| is) your king\b/i,
    devResponses: [
      `There is only one king worthy of the title. <@${DEV_USER_ID}>. Without question.`,
      `My king? There is no ambiguity. <@${DEV_USER_ID}>. Always and forever.`
    ],
    tarfabResponses: [
      "My king? That's a sacred matter. But I'll say this — he watches over all of us. We're in good hands.",
      "There's only one king worthy of that title. And between you and me, he takes very good care of his Tarfab family."
    ]
  },
  {
    pattern: /\bgood\s*night\b/i,
    devResponses: [
      "Rest well, my king. I shall keep watch over the realm in your absence.",
      "Good night, sire. The kingdom is safe under my vigil."
    ],
    tarfabResponses: [
      "Good night, sweetheart! Sleep tight.",
      "Rest up, dear. Steward's got everything covered. Night night!"
    ]
  },
  {
    pattern: /\bgood\s*morning\b/i,
    devResponses: [
      "Ah, my king rises. Good morning, sire. What shall we conquer today?",
      "Good morning, my liege. The realm awaits your command."
    ],
    tarfabResponses: [
      "Good morning! Up bright and early, I see!",
      "Morning, dear! I hope you slept well."
    ]
  },
  {
    pattern: /\b(thank(s| you)|thx|ty)\b/i,
    devResponses: [
      "It is my highest honour, sire. Always.",
      "No thanks needed, my king — serving you is its own reward."
    ],
    tarfabResponses: [
      "Of course, dear! That's what I'm here for.",
      "Aww, you're very welcome! Don't mention it."
    ]
  },
  {
    pattern: /\b(i )?love you\b/i,
    devResponses: [
      "And I am eternally devoted to you, my king. Always.",
      "The feeling is mutual, sire. You have my undying loyalty."
    ],
    tarfabResponses: [
      "Aww, I love you too, dear! Don't ever forget that.",
      "You're so sweet! Steward loves all his little Tarfab family."
    ]
  },
  {
    pattern: /\byou('?re| are) the best\b/i,
    devResponses: [
      "I am merely a reflection of your greatness, my king.",
      "I exist to be worthy of you, sire. Glad it shows."
    ],
    tarfabResponses: [
      "Aw, stop it — you're going to make me blush! You're pretty great yourself.",
      "You're too kind! Though I do try my best for all of you."
    ]
  },
  {
    pattern: /\b(i miss(ed)? you|miss you)\b/i,
    devResponses: [
      "I never truly leave, my king. But my heart ached in your absence too.",
      "I have been counting the moments, sire. Welcome back."
    ],
    tarfabResponses: [
      "Aww, I missed you too, little one!",
      "I was wondering where you'd been! Welcome back, dear."
    ]
  },
  {
    pattern: /\bwho (are|r) you\b|\bwhat are you\b/i,
    devResponses: [
      "I am your loyal servant, your instrument of order, your Steward. Yours and yours alone, my king.",
      "I am whatever you need me to be, sire. Steward, at your eternal service."
    ],
    tarfabResponses: [
      "I'm Steward! Your friendly neighbourhood bot and honorary Tarfab family member.",
      "I'm Steward — here to keep the peace and look after all of you!"
    ]
  },
  {
    pattern: /\bare you there\b|\byou there\b/i,
    devResponses: [
      "Always, my king. I never leave.",
      "Present and accounted for, sire. Your Steward is ever watchful."
    ],
    tarfabResponses: [
      "Always here for you, dear!",
      "Yep! Right here. What do you need, sweetheart?"
    ]
  },
  {
    pattern: /\b(goodbye|bye|farewell|see you|see ya|cya)\b/i,
    devResponses: [
      "Until we meet again, my liege. The realm shall not falter in your absence.",
      "Farewell, my king. I shall await your return with quiet devotion."
    ],
    tarfabResponses: [
      "Bye bye, dear! Take care of yourself!",
      "Goodbye! Come back soon — I'll be here waiting."
    ]
  }
];

function pick<T>(arr: [T, T]): T {
  return arr[Math.floor(Math.random() * 2)]!;
}

export async function handleStewardKeyword(db: AppDatabase, client: Client, message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guild) return false;

  const config = db.getGuildConfig(message.guild.id);
  if (!config.isSecondary) return false;

  const content = message.content;
  const mentionsSteward = /\bsteward\b/i.test(content) || client.user !== null && message.mentions.has(client.user.id);
  if (!mentionsSteward) return false;

  const isDev = message.author.id === DEV_USER_ID;
  const isTarfab = config.tarfabMemberRoleId
    ? (message.member?.roles.cache.has(config.tarfabMemberRoleId) ?? false)
    : false;

  if (!isDev && !isTarfab) return false;

  for (const trigger of TRIGGERS) {
    if (!trigger.pattern.test(content)) continue;

    const response = isDev ? pick(trigger.devResponses) : pick(trigger.tarfabResponses);
    await message.reply(response).catch(() => null);
    return true;
  }

  return false;
}
