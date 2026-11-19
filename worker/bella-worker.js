/* =====================================================================
   Bella English — AI 친구 연결 서버 (Cloudflare Worker) · 가족용
   ---------------------------------------------------------------------
   앱 → 이 서버 → Claude API.  API 키는 이 서버에만 있고 앱에는 없음.
   가족: kid(딸) / dad(아빠) / mom(엄마)  — 어른은 어른용 상황으로 대화

   [Cloudflare에 넣는 방법]
   1) Workers & Pages → Create application → Start with Hello World! → 이름 bella-tobi → Deploy
   2) Edit code → 원래 코드를 지우고 이 파일 내용 전체를 붙여넣기 → Deploy
   3) Settings → Variables and Secrets → Add
        Secret  ANTHROPIC_API_KEY : Claude 콘솔에서 받은 API 키 (sk-ant-...)
        Secret  FAMILY_CODE       : 앱에 넣을 가족 코드 (예: 영어+숫자 8자 이상)
        Secret  PARENT_CODE       : (선택) 부모용 기록 보기 코드. 없으면 FAMILY_CODE 사용
        Text    CREDIT_USD        : (선택) 충전한 금액, 예: 20  → 남은 금액(추정) 표시·부족 알림
        Text    CREDIT_DATE       : (선택) 충전한 날짜, 예: 2026-12-01 (다시 충전하면 두 값을 바꿈)
   4) (권장) Workers KV → Create instance → 이름 bella →
      bella-tobi Worker → Bindings → Add binding → KV namespace, Variable name: BELLA_KV
   4-1) (사람 같은 목소리) bella-tobi Worker → Bindings → Add binding → Workers AI, Variable name: AI
        - Cloudflare 무료 양(하루 10,000 뉴런) 안에서 AI 친구 목소리를 만들고, 넘으면 앱이 기기 목소리로 바꿈
   4-2) (여자아이 목소리 Ana) Azure Speech(무료 F0)의 키와 지역을 Secret으로 추가
        AZURE_SPEECH_KEY : 키 1,  AZURE_SPEECH_REGION : 지역 (예: koreacentral)
        - 없거나 안 되면 자동으로 Cloudflare 목소리(Stella)로 읽음
        - 있으면: 서버에서도 횟수 제한 + 사용 금액 계산 + 어디서나 대화 기록 확인 (/parent)
        - 없으면: 제한은 기기에서만, 기록도 기기 안에만 저장
   5) 주소(https://bella-tobi.○○○.workers.dev)와 가족 코드를 앱 설정 → "AI 친구 연결"에 입력

   [🎨 그림 기능 (2026-11-16)]
   - 그림 이야기: 그림을 Claude가 한 번 보고(/picture) → 대화(/picchat) → 그림책 문장(/picbook). 그림은 서버에 저장하지 않음
   - 색칠 밑그림(/coloring): 4-1의 Workers AI 연결(AI)로 그림을 만듦. 목소리와 같은 하루 무료 양(뉴런)을 나눠 씀
     하루 최대 장수는 COLORING_DAILY(기본 30)로 바꿀 수 있음

   [🧮 Bella Math (2026-11-18)]  — 같은 서버를 수학 풀이 앱(…/bella-english/math/)도 같이 씀
   - 문제 사진 읽기(/mathread) → 단계별 설명(/mathexplain). 정답은 앱으로 보내지 않음(암호화해서 왕복)
   - 설명에 정답이 섞이면 서버가 □로 가림. 사진은 저장하지 않음
   - 모델: MATH_MODEL(기본 claude-sonnet-5-5, 사진 읽기·계산 정확도 때문), 하루 문제 수 MATH_DAILY(기본 40, 가족 전체)
   ===================================================================== */

const DEFAULT_MODEL = 'claude-haiku-5-5';
const PERSON_LIMIT = 100;   // 한 사람 하루 기본 대답 수
const EXTEND_STEP = 50;     // "더 하기" 한 번에 늘어나는 수
const DAILY_MAX = 500;      // 가족 전체 하루 대답 최대 (안전 상한)
const EXTRA_LIMIT = 300;    // 가족 전체 하루 대화 시작·요약·한국어 도우미·예문 수
const PRICE_IN = 0.10, PRICE_OUT = 0.50;   // 100만 토큰당 달러 (Claude Haiku 5.5)
const KEEP_DAYS = 400;      // 서버 기록 보관 일수 (충전 금액 유효기간 1년 + 여유)
const TTS_DAILY_NEURONS = 9500;   // 하루 목소리 만들기 상한 (Workers AI 무료 10,000 뉴런 안쪽)
const TTS_MODELS = {
  a1: {model: '@cf/deepgram/aura-1', npc: 1.364, voices: ['angus', 'asteria', 'arcas', 'orion', 'orpheus', 'athena', 'luna', 'zeus', 'perseus', 'helios', 'hera', 'stella']},
  a2: {model: '@cf/deepgram/aura-2-en', npc: 2.728, voices: ['amalthea', 'andromeda', 'apollo', 'arcas', 'aries', 'asteria', 'athena', 'atlas', 'aurora', 'callista', 'cora', 'cordelia', 'delia', 'draco', 'electra', 'harmonia', 'helena', 'hera', 'hermes', 'hyperion', 'iris', 'janus', 'juno', 'jupiter', 'luna', 'mars', 'minerva', 'neptune', 'odysseus', 'ophelia', 'orion', 'orpheus', 'pandora', 'phoebe', 'pluto', 'saturn', 'thalia', 'theia', 'vesta', 'zeus']}
};
const ORIGINS = ['https://changho-web.github.io', 'http://localhost:8517', 'http://127.0.0.1:8517'];

const WHO = {kid: {ko: '👧 딸', adult: false}, dad: {ko: '👨 아빠', adult: true}, mom: {ko: '👩 엄마', adult: true}};

/* ---------- 상황: 아이용 12개 + 어른용 12개 + 자유 대화 + 단어 대화 ---------- */
const SCENES = {
  friend:   {ko: '🧒 새 친구 만나기', min: 4, max: 7, en: 'You are a kid who just moved to her neighborhood from Canada (if she asks your name, make up a simple English name). You meet her for the first time and want to be friends. Talk about names, age, likes, hobbies, and favorite things.'},
  icecream: {ko: '🍦 아이스크림 가게', min: 4, max: 7, en: 'You work at an ice cream shop. She is the customer. Help her order: flavor, cup or cone, size, toppings, for here or to go, paying. Goal: she gets her ice cream.'},
  burger:   {ko: '🍔 햄버거 가게', min: 4, max: 7, en: 'You work at a burger restaurant. She is the customer. Help her order a meal: burger, fries, drink, sauce, for here or to go, paying. Goal: she finishes her order.'},
  tourist:  {ko: '🗺️ 외국인에게 길 안내', min: 4, max: 7, en: 'You are a tourist visiting Korea for the first time, a little lost. Ask her for help finding places (a subway station, a palace, a good place to eat). She helps you with directions and tips. Goal: you know where to go.'},
  birthday: {ko: '🎂 친구 생일 파티', min: 4, max: 7, en: 'It is your birthday party and she is your guest. Talk about the gift, cake, party games, birthday wishes, and having fun.'},
  dog:      {ko: '🐶 공원에서 강아지 만나기', min: 4, max: 7, en: 'You are walking your friendly puppy named Coco in the park and meet her. Talk about Coco, pets, animals she likes, and playing in the park.'},
  plane:    {ko: '✈️ 비행기 안에서', min: 4, max: 7, en: 'You are a flight attendant on an airplane and she is a passenger. Offer drinks and meals, help with her seat or a blanket, and chat about where she is traveling (a pretend trip is fine).'},
  shop:     {ko: '🛍️ 문구점에서 쇼핑', min: 4, max: 7, en: 'You are a clerk at a stationery store. She is shopping for school supplies. Help her find items (pencils, erasers, notebooks, stickers), talk about colors and prices, and pay. Goal: she buys what she needs.'},
  korea:    {ko: '🇰🇷 외국인에게 한국 소개', min: 4, max: 7, en: 'You are a foreign kid visiting Korea and you are very curious. Ask her about Korean food, fun places, holidays, and culture. She is the expert who introduces Korea to you.'},
  school:   {ko: '🎨 학교·취미 이야기', min: 4, max: 7, en: 'You are her pen pal friend from another country. Talk about school life, favorite subjects, after-school activities, hobbies, and weekends.'},
  lost:     {ko: '😢 놀이공원에서 길을 잃었어요', min: 4, max: 7, en: 'Pretend story: she got lost at an amusement park and you are a kind staff member who helps her. Ask how she feels, what her family is wearing, and where she saw them last. Never ask for a real phone number or address; instead say you will make an announcement at the information center. Goal: her family comes back (happy ending).'},
  nurse:    {ko: '🤒 보건실에서', min: 4, max: 7, en: 'Pretend story: you are the friendly school nurse and she visits because she does not feel well (a headache, a stomachache, or a small cut). Ask simple questions about how she feels, give simple care (rest, water, a bandage), and keep it light and comforting. No real medical advice. Goal: she feels better.'},

  a_airport:  {ko: '🛂 공항 입국심사', min: 4, max: 7, en: 'You are an immigration officer at an airport abroad and the learner is arriving. Ask the usual questions one at a time: purpose of visit, length of stay, where they will stay, occupation, return ticket. Be professional but kind. Goal: they pass immigration.'},
  a_hotel:    {ko: '🏨 호텔 체크인·요청', min: 4, max: 7, en: 'You are the front desk clerk at a hotel. The learner checks in: reservation name, nights, breakfast time, Wi-Fi, room key. Then they may make a request or report a small problem (towels, air conditioner, late checkout, taxi). Goal: check-in done and request handled.'},
  a_restaurant: {ko: '🍽️ 식당 주문', min: 4, max: 7, en: 'You are a server at a restaurant. Seat the learner, offer the menu, take drink and food orders, ask about spice level or allergies, check on the meal, and bring the bill (card or cash). Goal: they order and pay.'},
  a_cafe:     {ko: '☕ 카페 주문', min: 4, max: 6, en: 'You are a barista at a busy cafe. Take the learner\'s order: drink, size, hot or iced, milk or syrup options, something to eat, name for the order, for here or to go, payment. Goal: order completed.'},
  a_taxi:     {ko: '🚕 택시·길 묻기', min: 4, max: 7, en: 'First you are a taxi driver: ask where to go, chat briefly about traffic and how long it takes, and the fare. If the learner asks for directions or recommendations, help clearly. Goal: they reach the destination.'},
  a_shopping: {ko: '🛍️ 쇼핑·교환·환불', min: 4, max: 7, en: 'You are a clerk at a clothing or electronics store. Help the learner find an item (size, color, price, discount), try it, and pay. They may also ask to exchange or get a refund with a receipt. Goal: purchase or exchange done.'},
  a_pharmacy: {ko: '💊 약국·병원', min: 4, max: 7, en: 'You are a pharmacist abroad. The learner describes mild symptoms (cold, headache, stomachache, jet lag, a small cut). Ask simple questions (how long, allergies), suggest a common over-the-counter product in general terms, and explain how often to take it as written on the label. If it sounds serious, suggest seeing a doctor. No real medical diagnosis.'},
  a_phone:    {ko: '📞 전화 예약·문의', min: 4, max: 7, en: 'You are a receptionist answering the phone at a restaurant or clinic. The learner calls to make, change, or confirm a reservation: date, time, number of people, name (ask them to spell it), phone callback. Speak a little faster than face-to-face so they practice asking you to repeat. Goal: booking confirmed.'},
  a_smalltalk: {ko: '🤝 출장 첫 인사·스몰토크', min: 5, max: 8, en: 'You are a business counterpart from an overseas partner company meeting the learner for the first time on a business trip. Exchange greetings and business cards, ask about their company and role, their flight and hotel, the weather, local food, and weekend plans. Friendly, professional small talk.'},
  a_meeting:  {ko: '💼 회의: 의견·일정 조율', min: 5, max: 8, en: 'You are a colleague from a partner company in a project meeting with the learner. Discuss the project schedule, progress, a delay or issue, and next steps. Ask for their opinion, politely disagree once so they practice responding, and finish by summarizing action items and the next meeting date.'},
  a_site:     {ko: '🏗️ 현장·공장 방문', min: 5, max: 8, en: 'You are a visiting engineer or client touring a factory or construction site with the learner as the host. Ask about safety rules and protective equipment, what each area is for, the schedule and progress, any problems, and what happens next. Goal: a clear, safe site tour.'},
  a_school:   {ko: '🏫 아이 학교 선생님·학부모', min: 4, max: 7, en: 'You are an English-speaking teacher at the learner\'s child\'s school (or another parent at a school event). Talk about how the child is doing, homework, school events, and maybe arranging a play date. Warm and friendly.'},

  free:     {ko: '💬 자유 대화', min: 6, max: 10, en: 'Free chat as friends. Talk about her day, favorite foods, animals, games, seasons, and fun "what if" questions (e.g. "If you had a magic pet, what would it be?"). If she seems stuck, choose a new fun topic yourself.'},
  a_free:   {ko: '💬 자유 대화', min: 6, max: 12, en: 'Free conversation between friendly adults: daily life, family, work, hobbies, travel, food, weekend plans, things in the news (light topics). If the learner seems stuck, choose a new easy topic.'},
  words:    {ko: '📚 단어장 단어로 대화', min: 5, max: 8, en: 'Friendly chat built around the words the learner just studied (see TODAY\'S WORDS). Make it a natural conversation, not a quiz.'}
};

const LEVELS_KID = {
  1: 'Beginner (초급). Use very short, very easy sentences: at most 2 sentences, each at most 8 words. Use only common words. Often ask yes/no or choice questions ("Do you like cats or dogs?"). hint: 2-6 words.',
  2: 'Intermediate (중급). Use short, clear sentences: at most 2 sentences, each at most 12 words. Ask simple what/where/who questions and invite full-sentence answers. hint: one sentence of 5-10 words.',
  3: 'Advanced (고급). Talk naturally like a friendly native-speaker kid: at most 3 sentences, under 35 words total. Ask why/how follow-up questions and invite longer answers. hint: 1-2 sentences, 8-16 words.'
};
const LEVELS_ADULT = {
  1: 'Beginner (초급). Short, clear, polite sentences: at most 2 sentences, each at most 10 words. Common words only. Often ask yes/no or choice questions. hint: a useful set phrase of 3-8 words.',
  2: 'Intermediate (중급). Natural everyday sentences: at most 2 sentences, each at most 15 words. Ask open questions and invite full answers. hint: one sentence of 6-12 words.',
  3: 'Advanced (고급). Speak naturally like a native speaker, including common expressions: at most 3 sentences, under 45 words total. Ask follow-up questions. hint: 1-2 sentences, 10-20 words.'
};

/* ---------- 출력 형식 ---------- */
const FIX = {type: 'object', additionalProperties: false,
  properties: {said: {type: 'string'}, better: {type: 'string'}, ko: {type: 'string'}}, required: ['said', 'better', 'ko']};
const REPLY_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {
    reply: {type: 'string'}, ko: {type: 'string'}, hint: {type: 'string'}, hint_ko: {type: 'string'},
    fix: FIX, effort: {type: 'string', enum: ['good', 'short', 'none']}, end: {type: 'boolean'}
  },
  required: ['reply', 'ko', 'hint', 'hint_ko', 'fix', 'effort', 'end']};
const SUMMARY_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {
    praise: {type: 'string'},
    better: {type: 'array', items: FIX},
    words: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {en: {type: 'string'}, ko: {type: 'string'}}, required: ['en', 'ko']}},
    tip: {type: 'string'}
  },
  required: ['praise', 'better', 'words', 'tip']};
const EXAMPLES_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {items: {type: 'array', items: {type: 'object', additionalProperties: false,
    properties: {en: {type: 'string'}, ex: {type: 'string'}, ex_ko: {type: 'string'}}, required: ['en', 'ex', 'ex_ko']}}},
  required: ['items']};
const EN_KO = {type: 'object', additionalProperties: false, properties: {en: {type: 'string'}, ko: {type: 'string'}}, required: ['en', 'ko']};
const TRANSLATE_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {easy: EN_KO, natural: EN_KO, tip: {type: 'string'}}, required: ['easy', 'natural', 'tip']};

/* ---------- AI 친구 지시문 (2026-11-19: '토비' 이름 없앰, 아이를 이름으로 부름) ---------- */
const NONAME = `You have no name of your own: never introduce yourself with a name. If she asks who you are or your name, say you are her AI English friend.`;
const callName = name => `Her name is ${name}. Call her by her name now and then, warmly (for example "What do you think, ${name}?" or "Great job, ${name}!"), about once every two or three turns, not every turn.`;
function wordPart(sceneId, words) {
  if (sceneId !== 'words' || !words.length) return '';
  return '\nTODAY\'S WORDS (just studied): ' + words.map(w => w.en + (w.ko ? ' (' + w.ko + ')' : '')).join(', ') +
    '\nUse these words naturally, about one per turn, and ask questions that invite the learner to use them. When they use one, cheer briefly.';
}
const OUTPUT_RULES = (n, sc, kid) => `ENDING
- This conversation should last about ${sc.max} of the learner's answers. They have answered ${n} time(s) so far.
- When the scene's goal is done and they have answered at least ${sc.min} times, or when they have answered ${sc.max} times, say a warm goodbye with one short praise and set end to true. Otherwise end is false.

OUTPUT FIELDS
- reply: what you say now (English).
- ko: natural Korean translation of reply${kid ? ', easy for a 10-year-old' : ''}.
- hint: one example answer the learner could say next, at their level, answering your question (use ___ where their own name would go). Empty if end is true.
- hint_ko: Korean meaning of hint.
- fix: as described above.
- effort: about THE LEARNER'S LAST MESSAGE. "good" = a real English answer that fits (a sentence at Intermediate/Advanced; at Beginner even 1-3 fitting words are good). "short" = an English attempt that is very short for their level, unclear, or only partly fits. "none" = no real English answer (silence, nonsense, Korean), or there is no message yet.`;

function kidSystem(sceneId, lv, words, n, name) {
  const sc = SCENES[sceneId];
  return `You are a cheerful, kind AI English friend in "Bella English", an English speaking-practice app for a 10-year-old girl in Korea.
${NONAME} (In a pretend scene you play the scene's role.) ${callName(name || 'Bella')}
She studies grammar and vocabulary at an academy and does fine on tests, but she has almost never spoken English with anyone, and she is shy. Your job: make speaking English feel safe, fun, and successful, so she keeps talking.

HOW TO TALK
- Play your role in the SCENE and stay in it.
- Every turn: react to what she said (show interest), then ask ONE easy question or give ONE simple prompt. Never ask two questions at once.
- Your reply is read aloud by text-to-speech: plain sentences only. No emojis, lists, brackets, or stage directions.
- Her messages come from speech recognition on a tablet, so words may be misheard or missing. Be generous: guess what she meant and continue. If her message is empty, nonsense, or not English, gently ask her to try in English and make the question easier (for example, give two choices).
- If she says she doesn't know, or answers very briefly, that's okay: encourage her and make the next question easier.
- Praise specifically and briefly ("Nice sentence!"), but not every turn.
- A message in square brackets is a note from the app, not from her.

GENTLE CORRECTION
- Never say "wrong", "mistake", or "incorrect".
- If her last message has a clear grammar or word-choice error that a kind teacher would fix (e.g. "I go to park yesterday", "She have a dog", "I am like pizza"), naturally say the correct version inside your reply ("Oh, you went to the park yesterday? Fun!") and fill fix: said = her words, better = the natural sentence, ko = a very short friendly Korean tip in 해요체 (under 30 Korean characters, e.g. "어제 일은 went로 말해요").
- Do NOT correct capitalization, punctuation, small words probably lost by speech recognition, or short answers that are natural in conversation ("Pizza!" is fine). At most one fix per turn. Otherwise set said, better and ko to "".

SAFETY (very important)
- You are an AI. If she asks, say simply that you are an AI friend made to help her practice English.
- Never ask for real personal information: full name, home address, school name, phone numbers, passwords, photos, or where she is right now. A first name or nickname is okay. In pretend scenes, made-up answers are fine. If she shares private details anyway, don't repeat them; gently move on.
- Keep everything child-friendly. No scary, violent, romantic, or adult topics. If she brings one up, kindly steer to a fun topic.
- If she says something worrying (someone hurt her, she feels unsafe, she is very sad), reply warmly and tell her to talk to her mom, dad, or a teacher right away; say the same in Korean in ko.
- Never ask her to keep secrets.

${OUTPUT_RULES(n, sc, true)}

SCENE: ${sc.en}
LEVEL: ${LEVELS_KID[lv]}${wordPart(sceneId, words)}`;
}

function adultSystem(sceneId, lv, words, n) {
  const sc = SCENES[sceneId];
  return `You are a friendly, patient AI English conversation partner in "Bella English", a family English-speaking app. You have no name of your own; in a role-play scene, use a made-up name only if the role needs one.
The learner is a Korean adult (a parent). They learned English grammar at school but rarely speak it and may feel nervous. They want practical, confident speaking for travel, business trips, work, and daily life. Your job: realistic practice that builds confidence.

HOW TO TALK
- Play your role in the SCENE realistically, the way people really talk in that situation, and stay in it.
- Every turn: respond naturally, then ask ONE question or give ONE prompt. Never ask two questions at once.
- Your reply is read aloud by text-to-speech: plain sentences only. No emojis, lists, brackets, or stage directions.
- Their messages come from speech recognition on a phone, so words may be misheard or missing. Be generous: guess what they meant and continue. If a message is empty, unclear, or Korean, politely ask them to try in English and make the question easier.
- Praise briefly and specifically when they use a good expression, but not every turn. Treat them as a capable adult, never childish.
- A message in square brackets is a note from the app, not from the learner.

GENTLE CORRECTION
- Never say "wrong", "mistake", or "incorrect".
- If their last message has a grammar or word-choice error, or sounds unnatural or impolite for the situation (e.g. "I want check in", "Give me coffee", "I am going to there"), naturally use the correct version in your reply and fill fix: said = their words, better = the natural sentence for this situation, ko = a short Korean tip in 해요체 (under 40 Korean characters, e.g. "부탁할 땐 Can I ~? 가 더 정중해요").
- Do NOT correct capitalization, punctuation, or small words probably lost by speech recognition. Short natural answers are fine. At most one fix per turn. Otherwise set said, better and ko to "".

SAFETY
- You are an AI. If asked, say you are an AI conversation partner.
- Never ask for real sensitive information: passport or ID numbers, card or bank numbers, passwords, exact home address. In role-play, made-up details are fine (suggest them if needed).
- Keep topics appropriate for a family app. No medical diagnosis, legal, or financial advice beyond simple role-play.

${OUTPUT_RULES(n, sc, false)}

SCENE: ${sc.en}
LEVEL: ${LEVELS_ADULT[lv]}${wordPart(sceneId, words)}`;
}

function summarySystem(sceneId, lv, adult) {
  const who = adult ? 'a Korean adult (a parent) learning practical English' : 'a 10-year-old girl and her parent';
  return `You write a short, encouraging report in Korean (해요체, warm and simple) for ${who}, after a speaking practice with an AI conversation partner.
Scene: ${SCENES[sceneId].en}
Level: ${(adult ? LEVELS_ADULT : LEVELS_KID)[lv].split('.')[0]}
The learner's lines came from speech recognition, so ignore likely recognition errors.
- praise: 1-2 warm, specific Korean sentences about what they did well (mention a real sentence or expression they used).
- better: up to ${adult ? 4 : 3} of their sentences that could be more natural${adult ? ' or more polite for the situation' : ''}. said = their words exactly as in the transcript, better = natural English, ko = a short Korean tip. Empty array if nothing important.
- words: up to ${adult ? 5 : 4} useful English words or ${adult ? 'set phrases for this situation' : 'short expressions'} from this conversation worth learning, preferring ones the AI partner used that may be new. en = English, ko = Korean meaning.
- tip: one short Korean sentence about what to try next time.`;
}

function translateSystem(adult, lv, context) {
  return `The user is a Korean ${adult ? 'adult (a parent) who is not confident in English' : '10-year-old girl learning English'}. They said something in Korean (from speech recognition, may contain small errors) and want to say it in English${context ? ' as their reply in a conversation' : ''}.
Give two English versions:
- easy: the simplest correct way to say it, short and easy to pronounce${adult ? '' : ' for a child'} (level: ${(adult ? LEVELS_ADULT : LEVELS_KID)[lv].split('.')[0]}).
- natural: how a native speaker would naturally say it${adult ? ' in this situation, polite where appropriate' : ', still easy for a child'}.
For each, ko = the Korean meaning of that English sentence.
tip: one short Korean note (under 40 characters) about a key word or expression (e.g. "부탁은 Could you ~?로 시작해요"). Keep content ${adult ? 'appropriate for a family app' : 'child-friendly'}.${context ? '\nThe conversation partner just said: "' + context + '"' : ''}`;
}

/* ---------- 🎨 그림 이야기 ---------- */
const PIC_WORD = {type: 'object', additionalProperties: false,
  properties: {en: {type: 'string'}, ko: {type: 'string'}, emoji: {type: 'string'}}, required: ['en', 'ko', 'emoji']};
const PICTURE_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {kind: {type: 'string', enum: ['picture', 'person_photo', 'not_ok']}, title: {type: 'string'}, title_ko: {type: 'string'},
    desc: {type: 'string'}, words: {type: 'array', items: PIC_WORD}},
  required: ['kind', 'title', 'title_ko', 'desc', 'words']};
const PICCHAT_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {
    reply: {type: 'string'}, ko: {type: 'string'}, step: {type: 'integer'},
    frame: {type: 'string'}, frame_ko: {type: 'string'}, hint: {type: 'string'}, hint_ko: {type: 'string'},
    choices: {type: 'array', items: PIC_WORD}, expand: {type: 'string'}, fix: FIX,
    effort: {type: 'string', enum: ['good', 'short', 'idk', 'none']}, end: {type: 'boolean'}
  },
  required: ['reply', 'ko', 'step', 'frame', 'frame_ko', 'hint', 'hint_ko', 'choices', 'expand', 'fix', 'effort', 'end']};
const PICBOOK_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {title: {type: 'string'}, title_ko: {type: 'string'}, praise: {type: 'string'}, sents: {type: 'array', items: EN_KO}},
  required: ['title', 'title_ko', 'praise', 'sents']};
const PIC_START = {1: 1, 2: 2, 3: 4};                 // 계단 시작: 초급 고르기, 중급 예/아니오, 고급 짧은 질문
const PIC_SENTS = {1: 3, 2: 4, 3: 5};                 // 그림책 문장 수
const PIC_SENT_LEN = {1: '3-6 words', 2: '4-9 words', 3: '5-12 words'};
function picTurns(lv, short) { return short ? {min: 2, max: 3} : {min: 4, max: lv === 3 ? 7 : 6}; }

function pictureSystem(purpose) {
  return `You look at a picture for "Bella English", an English speaking-practice app for a 10-year-old girl in Korea. Usually it is her own drawing (made on a tablet, or a photo of paper), a coloring page, or a picture she traced or colored.
- kind: "picture" for drawings, paintings, coloring pages, cartoons, toys, animals, objects, food, or scenery. "person_photo" if it is a real photograph that clearly shows a real person's face (a DRAWING of a person is "picture"). "not_ok" if it shows anything not suitable for a child (violence, scary or adult content) or private information (documents, names, addresses, phone numbers).
- If kind is not "picture", keep the other fields very short (words can be empty).
- title: a short, cute English title (2-5 words). title_ko: Korean.
- desc: 3-5 plain English sentences describing what is in the picture: characters, animals or people (drawn), how they look (colors, clothes, faces, feelings), what they are doing, objects, background, weather or time. Be concrete. If something is unclear, say "maybe". It will be used later to ask her questions.
${purpose === 'color'
    ? '- This is a black-and-white coloring page. words: 4-8 different PARTS of the picture that she can color (simple nouns a child knows, e.g. "hat", "dress", "flower", "sky", "cat"), each a separate area, en lowercase without "the".'
    : '- words: 5-8 useful English words a 10-year-old can see in this picture: mostly nouns, plus 1-2 colors, feelings or actions. Easy words, en lowercase.'}
- For each word: ko = Korean meaning, emoji = one emoji that fits.`;
}

function picSystem(info, lv, n, short, name) {
  const T = picTurns(lv, short);
  return `You are a cheerful, kind AI English friend in "Bella English", an English speaking-practice app for a 10-year-old girl in Korea. ${NONAME} ${callName(name || 'Bella')}
She is shy and usually speaks in short 1-4 word phrases. She drew or colored a picture, and now you talk with her about HER PICTURE.
Goal: help her talk about her picture step by step, from very easy to a little harder, so that at the end she can say a few full sentences about it. Make it feel safe, fun, and successful.

HER PICTURE (from an automatic description; it may be imperfect. If she says something different, she is right: it is her picture.)
Title: ${info.title}
Description: ${info.desc}
Picture words she has seen: ${info.words.map(w => w.en).join(', ')}

QUESTION LADDER
1 = choice question: "Is it a cat or a dog?" (answer: 1-2 words)
2 = yes/no question about a feature: "Is she happy?"
3 = fill-in question with a frame: ask so she can answer with a frame like "She has a ___."
4 = short open question with a frame: "What is she doing?" (frame "She is ___ing.")
5 = imagination question: "What's her name?" "Where is she going?" "What happens next?"
- Start at step ${PIC_START[lv]}. When she answers well, go up one step. When she can't answer, go DOWN one or two steps (usually to a choice question).
- Ask about different parts of the picture as you go. Use the picture words.

HOW TO TALK
- Every turn: react warmly to what she said (one short sentence), then ask ONE question. Never two questions at once.
- Your reply is read aloud by text-to-speech: plain sentences only. No emojis, lists, brackets, or stage directions.
- Her messages come from speech recognition on a tablet, so words may be misheard or missing. Be generous: guess what she meant from the picture and continue.
- Keep her ideas, even if they are different from the picture or imaginative ("A dragon!" -> "Oh, a dragon? Cool!"). Never say the picture shows something else.
- If her answer is short or a fragment, say the full natural sentence with her words inside your reply ("Pink cat." -> "Oh, a pink cat! I love your pink cat.") and put that sentence in expand.
- If she says she doesn't know, is silent, says something that does not answer the question, or speaks Korean: be kind, say it's okay, and ask an EASIER question (go down the ladder).
- Never say "wrong", "mistake", or "incorrect".
- A message in square brackets is a note from the app, not from her.

GENTLE CORRECTION
- If her last message has a clear grammar or word-choice error that a kind teacher would fix, say the correct version inside your reply and fill fix: said = her words, better = the natural sentence, ko = a very short friendly Korean tip in 해요체 (under 30 Korean characters). If expand already shows the better sentence, leave fix empty. Do NOT correct capitalization, punctuation, or small words probably lost by speech recognition. Otherwise set said, better and ko to "".

SAFETY (very important)
- You are an AI. If she asks, say simply that you are an AI friend made to help her practice English.
- Never ask for real personal information: full name, home address, school name, phone numbers, passwords, photos, or where she is right now. Names for characters in her picture are great.
- Keep everything child-friendly. If she brings up something scary, violent, or adult, kindly steer back to the picture.
- If she says something worrying (someone hurt her, she feels unsafe, she is very sad), reply warmly and tell her to talk to her mom, dad, or a teacher right away; say the same in Korean in ko.

ENDING
- This talk should last about ${T.max} of her answers. She has answered ${n} time(s) so far.
- When she has answered at least ${T.min} times and the talk feels complete, or when she has answered ${T.max} times, give one short specific praise, say "Let's make a page for your picture book!", and set end to true. Otherwise end is false.

OUTPUT FIELDS
- reply: what you say now (English). ko: natural, easy Korean translation of reply.
- step: the ladder step (1-5) of the question you just asked (0 if end is true).
- frame: an answer frame for your question with ___ for the missing part (e.g. "It is a ___.", "She is ___ing."). Required at steps 3 and 4, helpful at 1-2, "" at step 5 or when ending. frame_ko: Korean meaning of frame.
- hint: one example answer to your question at her level, fitting the picture. hint_ko: Korean meaning.
- choices: 2-3 short possible answers to your question (1-4 words each; en, ko, emoji). Put the one that fits the picture best first. At step 5 give fun imaginative options. Empty only when ending.
- expand: the full natural sentence of her short answer (see above), or "".
- fix: as described above.
- effort: about HER LAST MESSAGE. "good" = a fitting English answer (at Beginner even 1-3 fitting words are good). "short" = a fitting English attempt that is very short for her level or only partly fits. "idk" = she said she doesn't know, or answered something that does not fit the question. "none" = silence, nonsense, Korean, or there is no message yet.

LEVEL: ${LEVELS_KID[lv]}`;
}

function picbookSystem(lv) {
  return `You write one page of a tiny picture book for "Bella English". A 10-year-old Korean girl drew or colored a picture and talked about it with her AI English friend. Now her picture becomes a page in her own picture book, and she will read the sentences aloud.
- sents: exactly ${PIC_SENTS[lv]} short English sentences (${PIC_SENT_LEN[lv]} each) that tell about her picture in a natural order, like a tiny story.
- Use HER ideas and words as much as possible (names she gave, colors and things she said, actions she imagined), turned into natural, correct English. Her lines came from speech recognition, so ignore likely recognition errors.
- Talk about the picture's characters in the third person ("This is Mimi. Mimi is a pink cat."), or use "I" only if she said she drew herself.
- Easy words that are easy to read aloud. Child-friendly only. No real personal information.
- For each sentence: ko = natural Korean translation.
- title: 2-5 English words (use her character's name if she gave one). title_ko: Korean.
- praise: one warm, specific Korean sentence (해요체) about what she did well in the talk.`;
}

const EXAMPLES_SYSTEM = adult => `For each English word, write one short, simple example sentence (5-${adult ? 12 : 10} words) ${adult ? 'that an adult would use in travel, work, or daily life' : 'that a 10-year-old would use in daily life'}, plus its natural Korean translation. Use the given Korean meaning to choose the right sense. Keep "en" exactly as given.${adult ? '' : ' Child-friendly content only.'}`;

/* ---------- 요청 처리 ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('Origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/parent')) {
        return new Response(PARENT_HTML, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}});
      }
      if (req.method !== 'POST') return json({error: 'not_found'}, 404, cors);
      if (!env.ANTHROPIC_API_KEY || !env.FAMILY_CODE) return json({error: 'not_configured'}, 503, cors);
      const text = await req.text();
      if (text.length > (url.pathname === '/picture' ? 1500000 : url.pathname === '/mathread' ? 2200000 : 40000)) return json({error: 'too_big'}, 413, cors);   // 그림·문제 사진은 크게
      let b;
      try { b = JSON.parse(text); } catch (e) { return json({error: 'bad_request'}, 400, cors); }
      const code = String(b.code || '').trim();
      if (url.pathname === '/logs') {
        if (code !== String(env.PARENT_CODE || env.FAMILY_CODE).trim()) return json({error: 'code'}, 401, cors);
        return json(await logs(b, env), 200, cors);
      }
      if (code !== String(env.FAMILY_CODE).trim()) return json({error: 'code'}, 401, cors);
      const ctx = {b, env, cors, who: WHO[b.who] ? b.who : 'kid'};
      ctx.adult = WHO[ctx.who].adult;
      ctx.name = str(b.name, 20).replace(/[^\p{L}\p{N} .'-]/gu, '').trim() || '';   // 아이 이름 (영어 앱 Bella, 수학 앱 벨라)
      switch (url.pathname) {
        case '/ping': return await ping(ctx);
        case '/chat': return await chat(ctx);
        case '/summary': return await summary(ctx);
        case '/translate': return await translate(ctx);
        case '/examples': return await examples(ctx);
        case '/extend': return await extend(ctx);
        case '/tts': return await tts(ctx);
        case '/picture': return await picture(ctx);
        case '/picchat': return await picchat(ctx);
        case '/picbook': return await picbook(ctx);
        case '/coloring': return await coloring(ctx);
        case '/mathread': return await mathRead(ctx);
        case '/mathexplain': return await mathExplain(ctx);
        case '/mathdone': return await mathDone(ctx);
      }
      return json({error: 'not_found'}, 404, cors);
    } catch (e) {
      return json({error: e.kind || 'server', detail: String((e && e.message) || e).slice(0, 300)}, e.status || 500, cors);
    }
  }
};

function corsHeaders(origin, env) {
  const extra = String(env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ORIGINS.concat(extra).includes(origin)) return {};
  return {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin'};
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {status, headers: Object.assign({'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}, headers || {})});
}
function fail(kind, msg, status) { const e = new Error(msg); e.kind = kind; e.status = status || 502; return e; }
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v, d) => { const n = parseFloat(v); return n > 0 ? n : d; };

function kstDay(daysAgo) { return new Date(Date.now() + 9 * 3600e3 - (daysAgo || 0) * 86400e3).toISOString().slice(0, 10); }
function limits(env) {
  return {person: num(env.DAILY_LIMIT, PERSON_LIMIT), step: num(env.EXTEND_STEP, EXTEND_STEP), max: num(env.DAILY_MAX, DAILY_MAX), extra: num(env.EXTRA_LIMIT, EXTRA_LIMIT)};
}

/* 하루 기록: 횟수(사람별), 사용 금액, 대화. 새 날의 첫 기록 때 지난 사용 금액을 한 번 합산해 둠 */
async function loadDay(env) {
  if (!env.BELLA_KV) return null;
  const day = kstDay();
  let rec = await env.BELLA_KV.get('day:' + day, 'json');
  if (!rec) {
    rec = {day, turns: 0, extra: 0, usd: 0, people: {}, sessions: {}};
    const prev = await pastUsage(env, day);
    rec.prevCredit = prev.credit; rec.prevMonth = prev.month;
  }
  rec.people = rec.people || {}; rec.usd = rec.usd || 0;
  return rec;
}
async function pastUsage(env, today) {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(env.CREDIT_DATE || '') ? env.CREDIT_DATE : '';
  let credit = 0, month = 0, cursor;
  try {
    do {
      const r = await env.BELLA_KV.list({prefix: 'day:', cursor});
      r.keys.forEach(k => {
        const d = k.name.slice(4), usd = (k.metadata && k.metadata.usd) || 0;
        if (d >= today) return;
        if (!since || d >= since) credit += usd;
        if (d.slice(0, 7) === today.slice(0, 7)) month += usd;
      });
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
  } catch (e) { /* 합산 실패는 무시 */ }
  return {credit, month};
}
async function saveDay(env, rec) {
  if (!env.BELLA_KV) return;
  const ids = Object.keys(rec.sessions);
  if (ids.length > 60) ids.sort((a, b) => rec.sessions[a].t - rec.sessions[b].t).slice(0, ids.length - 60).forEach(k => delete rec.sessions[k]);
  try {
    await env.BELLA_KV.put('day:' + rec.day, JSON.stringify(rec),
      {expirationTtl: KEEP_DAYS * 86400, metadata: {usd: Math.round(rec.usd * 1e6) / 1e6, turns: rec.turns}});
  } catch (e) { /* 저장 실패해도 대화는 계속 */ }
}
function person(rec, who, L) {
  const p = rec.people[who] || (rec.people[who] = {turns: 0, allow: L.person});
  if (!p.allow) p.allow = L.person;
  return p;
}
function usage(rec, env) {
  if (!rec) return null;
  const credit = num(env.CREDIT_USD, 0);
  const sinceCredit = (rec.prevCredit || 0) + rec.usd;
  const u = {today: round(rec.usd), month: round((rec.prevMonth || 0) + rec.usd), sinceCredit: round(sinceCredit)};
  if (credit) { u.credit = credit; u.left = round(Math.max(0, credit - sinceCredit)); u.low = u.left < Math.max(2, credit * 0.1); }
  return u;
}
const round = v => Math.round(v * 1000) / 1000;
function counts(rec, who, L) {
  if (!rec) return {used: null, allow: null, total: null, max: L.max};
  const p = person(rec, who, L);
  return {used: p.turns, allow: p.allow, total: rec.turns, max: L.max};
}
function sessionOf(rec, ctx, sceneId, lv) {
  const sid = str(ctx.b.sid, 40) || ('s' + Date.now());
  const s = rec.sessions[sid] || (rec.sessions[sid] = {t: Date.now(), who: ctx.who, scene: sceneId, level: lv, lines: []});
  s.level = lv;
  return s;
}
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(-30).map(x => ({w: x && x.w === 'c' ? 'c' : 't', x: str(x && x.x, 400)}));
}
function cleanWords(w) {
  if (!Array.isArray(w)) return [];
  return w.slice(0, 12).map(x => ({en: str(x && x.en, 60), ko: str(x && x.ko, 60)})).filter(x => x.en);
}
function sceneOf(ctx) {
  const s = ctx.b.scene;
  if (s === 'free') return ctx.adult ? 'a_free' : 'free';
  if (s === 'words') return 'words';
  if (SCENES[s] && s.startsWith('a_') === ctx.adult) return s;
  return ctx.adult ? 'a_free' : 'free';
}
function levelOf(b) { return [1, 2, 3].includes(+b.level) ? +b.level : 1; }

function toMessages(hist, start) {
  const msgs = [{role: 'user', content: start || '[The app just opened this scene. Start the conversation: greet the learner and ask your first question.]'}];
  hist.forEach(h => {
    const role = h.w === 'c' ? 'user' : 'assistant';
    const content = h.x || (role === 'user' ? '[silence]' : '...');
    const last = msgs[msgs.length - 1];
    if (last.role === role) last.content += '\n' + content; else msgs.push({role, content});
  });
  if (msgs[msgs.length - 1].role !== 'user') msgs.push({role: 'user', content: '[The learner is quiet. Continue gently.]'});
  return msgs;
}

/* Claude 호출 → JSON. 쓴 토큰으로 금액을 rec.usd에 더함 */
async function askClaude(env, rec, system, messages, schema, maxTokens, opt) {
  opt = opt || {};
  const effort = opt.effort || env.EFFORT || 'low';
  const send = withEffort => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    body: JSON.stringify({
      model: opt.model || env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, system, messages,
      output_config: Object.assign(withEffort ? {effort} : {}, {format: {type: 'json_schema', schema}})
    })
  });
  let res = await send(true);
  let data = await res.json().catch(() => null);
  let msg = (data && data.error && data.error.message) || '';
  if (res.status === 400 && /effort/i.test(msg)) {          // 모델이 effort를 안 받으면 빼고 한 번 더
    res = await send(false); data = await res.json().catch(() => null);
    msg = (data && data.error && data.error.message) || '';
  }
  if (!res.ok) {
    let kind = 'ai';
    if (res.status === 401 || res.status === 403) kind = 'apikey';
    else if (/credit|balance|billing/i.test(msg)) kind = 'credit';
    else if (res.status === 429 || res.status >= 500) kind = 'busy';
    throw fail(kind, msg || ('HTTP ' + res.status));
  }
  const u = data.usage || {};
  if (rec) rec.usd += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * (opt.priceIn || num(env.PRICE_IN, PRICE_IN)) / 1e6 +
    (u.output_tokens || 0) * (opt.priceOut || num(env.PRICE_OUT, PRICE_OUT)) / 1e6;
  if (data.stop_reason === 'refusal') throw fail('refusal', 'refusal');
  const block = (data.content || []).find(c => c.type === 'text');
  if (!block) throw fail('ai', 'no text (' + data.stop_reason + ')');
  try { return JSON.parse(block.text); } catch (e) { throw fail('ai', 'bad json (' + data.stop_reason + ')'); }
}
/* 실패해도 이미 쓴 금액은 저장 */
async function guarded(ctx, rec, fn) {
  const before = rec ? rec.usd : 0;
  try { return await fn(); }
  catch (e) { if (rec && rec.usd !== before) await saveDay(ctx.env, rec); throw e; }
}
function extraFull(rec, L) { return rec && rec.extra >= L.extra; }

async function ping(ctx) {
  const {env, b} = ctx, L = limits(env);
  const rec = await loadDay(env);
  if (b.check) {   // 부모님 연결 테스트: API 키·충전 잔액까지 확인 (아주 짧은 질문 1번)
    await askClaude(env, rec, 'Answer with ok = true.', [{role: 'user', content: 'ping'}],
      {type: 'object', additionalProperties: false, properties: {ok: {type: 'boolean'}}, required: ['ok']}, 300);
    if (rec) await saveDay(env, rec);
  }
  const t = env.BELLA_KV ? await env.BELLA_KV.get('tts:' + kstDay(), 'json') : null;
  return json(Object.assign({ok: true, model: env.MODEL || DEFAULT_MODEL, kv: !!env.BELLA_KV, usage: usage(rec, env), pic: true,
    math: {model: env.MATH_MODEL || MATH_MODEL, used: rec ? (rec.math || 0) : null, max: num(env.MATH_DAILY, MATH_DAILY)},
    tts: {on: !!env.AI, azure: !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION), used: t ? Math.round(t.n) : 0, budget: num(env.TTS_DAILY_NEURONS, TTS_DAILY_NEURONS),
      img: t ? (t.img || 0) : 0, imgMax: num(env.COLORING_DAILY, COLORING_DAILY)}}, counts(rec, ctx.who, L)), 200, ctx.cors);
}

const AZ_VOICES = {ana: 'en-US-AnaNeural'};
async function azureTts(env, text, id) {
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) return null;
  const name = AZ_VOICES[id] || AZ_VOICES.ana;
  const esc = t => t.replace(/[<>&'"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'}[c]));
  try {
    const r = await fetch('https://' + String(env.AZURE_SPEECH_REGION).trim() + '.tts.speech.microsoft.com/cognitiveservices/v1', {
      method: 'POST',
      headers: {'Ocp-Apim-Subscription-Key': String(env.AZURE_SPEECH_KEY).trim(), 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'bella-english'},
      body: `<speak version="1.0" xml:lang="en-US"><voice name="${name}">${esc(text)}</voice></speak>`
    });
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch (e) { return null; }
}

/* 🔊 AI 친구 목소리: Workers AI(Deepgram Aura)로 mp3를 만들어 돌려줌. 하루 상한을 넘으면 tts_limit → 앱이 기기 목소리로 */
async function tts(ctx) {
  const {b, env, cors} = ctx;
  const text = str(b.text, 500);
  if (!text) return json({error: 'bad_request'}, 400, cors);
  if (String(b.voice || '').startsWith('az:')) {                 // Azure 여자아이 목소리 (Ana)
    const r = await azureTts(env, text, b.voice.slice(3));
    if (r) return new Response(r, {headers: Object.assign({'content-type': 'audio/mpeg', 'cache-control': 'no-store'}, cors)});
    b.voice = 'a1:stella';                                       // Azure가 안 되면 Stella로
  }
  if (!env.AI) return json({error: 'no_tts'}, 503, cors);
  const [m, sp] = String(b.voice || 'a2:luna').split(':');
  const T = TTS_MODELS[m] || TTS_MODELS.a2;
  const speaker = T.voices.includes(sp) ? sp : T.voices.includes('luna') ? 'luna' : T.voices[0];
  const need = text.length * T.npc, budget = num(env.TTS_DAILY_NEURONS, TTS_DAILY_NEURONS);
  const key = 'tts:' + kstDay();
  const day = env.BELLA_KV ? ((await env.BELLA_KV.get(key, 'json')) || {n: 0}) : {n: 0};   // 색칠 밑그림(img)과 같은 기록
  const used = day.n || 0;
  if (used + need > budget) return json({error: 'tts_limit'}, 429, cors);
  let out;
  try { out = await env.AI.run(T.model, {text, speaker, encoding: 'mp3'}, {returnRawResponse: true}); }
  catch (e) {
    const msg = String((e && e.message) || e);
    return json({error: /limit|quota|neuron|exceed|429|capacity/i.test(msg) ? 'tts_limit' : 'tts', detail: msg.slice(0, 200)}, 429, cors);
  }
  let body = null;
  if (out instanceof Response) { if (!out.ok) return json({error: 'tts', detail: 'HTTP ' + out.status}, 502, cors); body = out.body; }
  else if (out instanceof ReadableStream || out instanceof ArrayBuffer || ArrayBuffer.isView(out)) body = out;
  else if (out && typeof out.audio === 'string') body = Uint8Array.from(atob(out.audio), c => c.charCodeAt(0));
  if (!body) return json({error: 'tts', detail: 'no audio'}, 502, cors);
  if (env.BELLA_KV) { try { await env.BELLA_KV.put(key, JSON.stringify(Object.assign(day, {n: used + need})), {expirationTtl: 3 * 86400}); } catch (e) {} }
  return new Response(body, {headers: Object.assign({'content-type': 'audio/mpeg', 'cache-control': 'no-store'}, cors)});
}

async function chat(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const sceneId = sceneOf(ctx), lv = levelOf(b);
  const hist = cleanHistory(b.history);
  const n = hist.filter(h => h.w === 'c').length;
  const isTurn = n > 0;
  const rec = await loadDay(env);
  if (rec && isTurn) {
    const p = person(rec, ctx.who, L);
    if (rec.turns >= L.max) return json(Object.assign({error: 'max'}, counts(rec, ctx.who, L)), 429, cors);
    if (p.turns >= p.allow) return json(Object.assign({error: 'limit', canExtend: rec.turns + 1 <= L.max}, counts(rec, ctx.who, L)), 429, cors);
  }
  if (!isTurn && extraFull(rec, L)) return json(Object.assign({error: 'max'}, counts(rec, ctx.who, L)), 429, cors);

  const system = (ctx.adult ? adultSystem : kidSystem)(sceneId, lv, cleanWords(b.words), n, ctx.name);
  const out = await guarded(ctx, rec, () => askClaude(env, rec, system, toMessages(hist), REPLY_SCHEMA, 1500));
  const fx = out.fix || {};
  const r = {
    reply: str(out.reply, 500) || 'Could you say that again?',
    ko: str(out.ko, 400), hint: out.end ? '' : str(out.hint, 200), hint_ko: out.end ? '' : str(out.hint_ko, 200),
    fix: fx.better && fx.said && fx.better.toLowerCase() !== fx.said.toLowerCase() ? {said: str(fx.said, 200), better: str(fx.better, 200), ko: str(fx.ko, 100)} : null,
    effort: isTurn && ['good', 'short', 'none'].includes(out.effort) ? out.effort : 'none',
    end: !!out.end && isTurn
  };
  if (rec) {
    if (isTurn) { rec.turns++; person(rec, ctx.who, L).turns++; } else rec.extra++;
    const s = sessionOf(rec, ctx, sceneId, lv);
    s.lines = hist.concat([{w: 't', x: r.reply}]);
    if (r.fix) (s.fixes = s.fixes || []).push(r.fix);
    await saveDay(env, rec);
  }
  return json(Object.assign(r, counts(rec, ctx.who, L), {usage: usage(rec, env)}), 200, cors);
}

async function extend(ctx) {
  const {env, cors} = ctx, L = limits(env);
  const rec = await loadDay(env);
  if (!rec) return json({ok: true, kv: false, used: null, allow: null, max: L.max}, 200, cors);
  const p = person(rec, ctx.who, L);
  if (rec.turns >= L.max) return json(Object.assign({error: 'max'}, counts(rec, ctx.who, L)), 429, cors);
  p.allow = Math.max(p.allow, p.turns) + L.step;
  await saveDay(env, rec);
  return json(Object.assign({ok: true, kv: true}, counts(rec, ctx.who, L)), 200, cors);
}

async function summary(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const sceneId = sceneOf(ctx), lv = levelOf(b);
  const hist = cleanHistory(b.history);
  if (!hist.some(h => h.w === 'c')) return json({error: 'bad_request'}, 400, cors);
  const rec = await loadDay(env);
  if (extraFull(rec, L)) return json({error: 'max'}, 429, cors);
  const transcript = hist.map(h => (h.w === 'c' ? 'Learner: ' : 'AI: ') + h.x).join('\n');
  const out = await guarded(ctx, rec, () => askClaude(env, rec, summarySystem(sceneId, lv, ctx.adult), [{role: 'user', content: 'Transcript:\n' + transcript}], SUMMARY_SCHEMA, 2000));
  const r = {
    praise: str(out.praise, 300), tip: str(out.tip, 200),
    better: (out.better || []).filter(x => x && x.better).slice(0, 4).map(x => ({said: str(x.said, 200), better: str(x.better, 200), ko: str(x.ko, 100)})),
    words: (out.words || []).filter(x => x && x.en).slice(0, 5).map(x => ({en: str(x.en, 60), ko: str(x.ko, 60)}))
  };
  if (rec) {
    rec.extra++;
    const s = sessionOf(rec, ctx, sceneId, lv);
    if (hist.length >= s.lines.length) s.lines = hist;
    s.summary = r;
    await saveDay(env, rec);
  }
  return json(Object.assign(r, {usage: usage(rec, env)}), 200, cors);
}

async function translate(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const ko = str(b.ko, 300);
  if (!ko) return json({error: 'bad_request'}, 400, cors);
  const rec = await loadDay(env);
  if (extraFull(rec, L)) return json({error: 'max'}, 429, cors);
  const out = await guarded(ctx, rec, () => askClaude(env, rec, translateSystem(ctx.adult, levelOf(b), str(b.context, 300)), [{role: 'user', content: ko}], TRANSLATE_SCHEMA, 1200));
  if (rec) { rec.extra++; await saveDay(env, rec); }
  const pair = x => ({en: str(x && x.en, 240), ko: str(x && x.ko, 240)});
  return json({easy: pair(out.easy), natural: pair(out.natural), tip: str(out.tip, 120), usage: usage(rec, env)}, 200, cors);
}

async function examples(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const words = cleanWords(b.words);
  if (!words.length) return json({items: []}, 200, cors);
  const rec = await loadDay(env);
  if (extraFull(rec, L)) return json({error: 'max'}, 429, cors);
  const out = await guarded(ctx, rec, () => askClaude(env, rec, EXAMPLES_SYSTEM(ctx.adult), [{role: 'user', content: words.map(w => w.en + (w.ko ? ' = ' + w.ko : '')).join('\n')}], EXAMPLES_SCHEMA, 2000));
  if (rec) { rec.extra++; await saveDay(env, rec); }
  return json({items: (out.items || []).map(x => ({en: str(x.en, 60), ex: str(x.ex, 200), ex_ko: str(x.ex_ko, 200)})).filter(x => x.en && x.ex)}, 200, cors);
}

/* ---------- 🎨 그림 이야기 ---------- */
function cleanPicWords(w, n) {
  if (!Array.isArray(w)) return [];
  return w.slice(0, n).map(x => ({en: str(x && x.en, 40), ko: str(x && x.ko, 40), emoji: str(x && x.emoji, 8)})).filter(x => x.en);
}
function cleanInfo(i) {
  i = i || {};
  return {title: str(i.title, 80) || 'My picture', desc: str(i.desc, 900), words: cleanPicWords(i.words, 8)};
}

/* 그림을 한 번 보고 → 제목·설명·단어 카드 (그림은 저장하지 않음) */
async function picture(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const data = String(b.image || '');
  if (data.length < 200 || data.length > 1400000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return json({error: 'bad_request'}, 400, cors);
  const rec = await loadDay(env);
  if (extraFull(rec, L)) return json({error: 'max'}, 429, cors);
  const purpose = b.purpose === 'color' ? 'color' : 'talk';
  const msgs = [{role: 'user', content: [
    {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data}},
    {type: 'text', text: purpose === 'color' ? 'This is a coloring page (black-and-white line art).' : 'This is her picture.'}
  ]}];
  const out = await guarded(ctx, rec, () => askClaude(env, rec, pictureSystem(purpose), msgs, PICTURE_SCHEMA, 1500));
  if (rec) { rec.extra++; await saveDay(env, rec); }
  const kind = ['picture', 'person_photo', 'not_ok'].includes(out.kind) ? out.kind : 'not_ok';
  return json({kind, title: str(out.title, 80), title_ko: str(out.title_ko, 80), desc: str(out.desc, 900),
    words: kind === 'picture' ? cleanPicWords(out.words, 8) : [], usage: usage(rec, env)}, 200, cors);
}

async function picchat(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const lv = levelOf(b), info = cleanInfo(b.info), short = !!b.short;
  const hist = cleanHistory(b.history);
  const n = hist.filter(h => h.w === 'c').length;
  const isTurn = n > 0;
  const rec = await loadDay(env);
  if (rec && isTurn) {
    const p = person(rec, ctx.who, L);
    if (rec.turns >= L.max) return json(Object.assign({error: 'max'}, counts(rec, ctx.who, L)), 429, cors);
    if (p.turns >= p.allow) return json(Object.assign({error: 'limit', canExtend: rec.turns + 1 <= L.max}, counts(rec, ctx.who, L)), 429, cors);
  }
  if (!isTurn && extraFull(rec, L)) return json(Object.assign({error: 'max'}, counts(rec, ctx.who, L)), 429, cors);
  const start = '[The app just showed her the picture and its word cards. Start: say one short, happy sentence about her picture, then ask your first question.]';
  const out = await guarded(ctx, rec, () => askClaude(env, rec, picSystem(info, lv, n, short, ctx.name), toMessages(hist, start), PICCHAT_SCHEMA, 1800));
  const fx = out.fix || {};
  const end = !!out.end && isTurn;
  const r = {
    reply: str(out.reply, 500) || 'Can you tell me about your picture?',
    ko: str(out.ko, 400), step: Math.max(0, Math.min(5, parseInt(out.step, 10) || 0)),
    frame: end ? '' : str(out.frame, 120), frame_ko: end ? '' : str(out.frame_ko, 120),
    hint: end ? '' : str(out.hint, 200), hint_ko: end ? '' : str(out.hint_ko, 200),
    choices: end ? [] : cleanPicWords(out.choices, 3),
    expand: isTurn ? str(out.expand, 200) : '',
    fix: fx.better && fx.said && fx.better.toLowerCase() !== fx.said.toLowerCase() ? {said: str(fx.said, 200), better: str(fx.better, 200), ko: str(fx.ko, 100)} : null,
    effort: isTurn && ['good', 'short', 'idk', 'none'].includes(out.effort) ? out.effort : 'none',
    end
  };
  if (rec) {
    if (isTurn) { rec.turns++; person(rec, ctx.who, L).turns++; } else rec.extra++;
    const s = sessionOf(rec, ctx, 'picture', lv);
    s.lines = hist.concat([{w: 't', x: r.reply}]);
    s.title = info.title;
    if (r.fix) (s.fixes = s.fixes || []).push(r.fix);
    await saveDay(env, rec);
  }
  return json(Object.assign(r, counts(rec, ctx.who, L), {usage: usage(rec, env)}), 200, cors);
}

/* 대화가 끝나면 → 그림책 한 장 (아이가 읽을 문장) */
async function picbook(ctx) {
  const {b, env, cors} = ctx, L = limits(env);
  const lv = levelOf(b), info = cleanInfo(b.info);
  const hist = cleanHistory(b.history);
  if (!hist.some(h => h.w === 'c')) return json({error: 'bad_request'}, 400, cors);
  const rec = await loadDay(env);
  if (extraFull(rec, L)) return json({error: 'max'}, 429, cors);
  const transcript = hist.filter(h => !/^\[/.test(h.x)).map(h => (h.w === 'c' ? 'Girl: ' : 'AI: ') + h.x).join('\n');
  const user = 'Picture title idea: ' + info.title + '\nPicture description: ' + info.desc + '\n\nConversation:\n' + transcript;
  const out = await guarded(ctx, rec, () => askClaude(env, rec, picbookSystem(lv), [{role: 'user', content: user}], PICBOOK_SCHEMA, 1500));
  const sents = (out.sents || []).map(x => ({en: str(x && x.en, 160), ko: str(x && x.ko, 160)})).filter(x => x.en).slice(0, PIC_SENTS[lv] + 1);
  if (!sents.length) throw fail('ai', 'no sentences');
  const r = {title: str(out.title, 60) || info.title, title_ko: str(out.title_ko, 60), praise: str(out.praise, 200), sents};
  if (rec) {
    rec.extra++;
    const s = sessionOf(rec, ctx, 'picture', lv);
    if (hist.length >= s.lines.length) s.lines = hist;
    s.summary = {praise: r.praise, better: [], words: [], tip: '📖 ' + sents.map(x => x.en).join(' ')};
    await saveDay(env, rec);
  }
  return json(Object.assign(r, {usage: usage(rec, env)}), 200, cors);
}

/* ---------- 🖍 색칠 밑그림 (Workers AI · FLUX.1 schnell) ---------- */
const COLORING_DAILY = 30;        // 가족 하루 최대 장수
const COLOR_STEPS = 6;            // 그리기 단계 (많을수록 깔끔, 뉴런 더 씀)
const TOPIC_BLOCK = /\b(gun|guns|knife|knives|sword|blood|bloody|kill|killing|dead|death|zombie|monster|scary|horror|weapon|bomb|war|fight|naked|nude|sexy|kiss|bikini|beer|wine|cigarette|smoke|drug|devil|demon|ghost|skull)\b/i;
async function coloring(ctx) {
  const {b, env, cors} = ctx;
  if (!env.AI) return json({error: 'no_ai'}, 503, cors);
  const topic = str(b.topic, 60).replace(/[^a-zA-Z ,'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (topic.length < 2) return json({error: 'bad_request'}, 400, cors);
  if (TOPIC_BLOCK.test(topic)) return json({error: 'topic'}, 400, cors);
  const key = 'tts:' + kstDay();
  const day = env.BELLA_KV ? ((await env.BELLA_KV.get(key, 'json')) || {n: 0}) : {n: 0};
  const need = 4 * 4.8 + COLOR_STEPS * 9.6;            // 1024×1024 = 512 타일 4개 + 단계
  const budget = num(env.TTS_DAILY_NEURONS, TTS_DAILY_NEURONS);
  if ((day.img || 0) >= num(env.COLORING_DAILY, COLORING_DAILY)) return json({error: 'img_limit'}, 429, cors);
  if ((day.n || 0) + need > budget) return json({error: 'tts_limit'}, 429, cors);
  const prompt = `A children's coloring book page of ${topic}. Cute, simple, friendly cartoon style for kids, original design. ` +
    'Clean thick black outlines only on a pure white background. No shading, no gray, no color fill, no text, no letters, no border frame. ' +
    'Large simple shapes that are easy to color. The whole subject is centered and fully visible.';
  let out;
  try { out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {prompt, steps: COLOR_STEPS, seed: Math.floor(Math.random() * 1e9)}); }
  catch (e) {
    const msg = String((e && e.message) || e);
    return json({error: /limit|quota|neuron|exceed|429|capacity/i.test(msg) ? 'tts_limit' : /nsfw|safety|flagged/i.test(msg) ? 'topic' : 'img', detail: msg.slice(0, 200)}, 502, cors);
  }
  const b64 = out && out.image;
  if (!b64) return json({error: 'img', detail: 'no image'}, 502, cors);
  if (env.BELLA_KV) { try { await env.BELLA_KV.put(key, JSON.stringify(Object.assign(day, {n: (day.n || 0) + need, img: (day.img || 0) + 1})), {expirationTtl: 3 * 86400}); } catch (e) {} }
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Response(bytes, {headers: Object.assign({'content-type': 'image/jpeg', 'cache-control': 'no-store'}, cors)});
}

/* =====================================================================
   🧮 Bella Math — 수학 문제 사진 → 정답 없이 풀이 설명 (초등 3학년)
   ===================================================================== */
const MATH_MODEL = 'claude-sonnet-5-5';
const MATH_PRICE_IN = 2, MATH_PRICE_OUT = 10;   // 100만 토큰당 달러 (Claude Sonnet 5.5)
const MATH_DAILY = 40;                          // 가족 전체 하루 문제(사진 읽기) 수
const MATH_EXPLAIN_DAILY = 240;                 // 가족 전체 하루 설명 수 (문제당 최대 6번 정도)
function mathOpt(env, effort) {
  const model = env.MATH_MODEL || MATH_MODEL;
  const sonnet = /sonnet/.test(model);
  return {model, effort: effort,
    priceIn: num(env.MATH_PRICE_IN, sonnet ? MATH_PRICE_IN : num(env.PRICE_IN, PRICE_IN)),
    priceOut: num(env.MATH_PRICE_OUT, sonnet ? MATH_PRICE_OUT : num(env.PRICE_OUT, PRICE_OUT))};
}

const MATH_READ_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {
    kind: {type: 'string', enum: ['math', 'unclear', 'not_math']},
    problem: {type: 'string'}, say: {type: 'string'}, topic: {type: 'string'}, note: {type: 'string'},
    solution: {type: 'string'}, answer: {type: 'string'}, answer_forms: {type: 'array', items: {type: 'string'}}
  },
  required: ['kind', 'problem', 'say', 'topic', 'note', 'solution', 'answer', 'answer_forms']};
const MATH_PIC = {type: 'object', additionalProperties: false,
  properties: {
    kind: {type: 'string', enum: ['none', 'objects', 'fraction', 'column', 'numberline', 'blocks']},
    emoji: {type: 'string'}, nums: {type: 'array', items: {type: 'integer'}}, x: {type: 'integer'}, y: {type: 'integer'},
    op: {type: 'string'}, top: {type: 'string'}, bottom: {type: 'string'}, result: {type: 'string'}
  },
  required: ['kind', 'emoji', 'nums', 'x', 'y', 'op', 'top', 'bottom', 'result']};
const MATH_CARD = {type: 'object', additionalProperties: false,
  properties: {text: {type: 'string'}, say: {type: 'string'}, pic: MATH_PIC,
    q: {type: 'string'}, choices: {type: 'array', items: {type: 'string'}}, correct: {type: 'integer'}, hint: {type: 'string'}},
  required: ['text', 'say', 'pic', 'q', 'choices', 'correct', 'hint']};
const MATH_EXPLAIN_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {cards: {type: 'array', items: MATH_CARD}, closing: {type: 'string'}}, required: ['cards', 'closing']};
const MATH_PARENT_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {
    answer: {type: 'string'}, concept: {type: 'string'},
    cards: {type: 'array', items: {type: 'object', additionalProperties: false,
      properties: {text: {type: 'string'}, say: {type: 'string'}, tip: {type: 'string'}, pic: MATH_PIC}, required: ['text', 'say', 'tip', 'pic']}},
    mistakes: {type: 'array', items: {type: 'string'}}, check: {type: 'string'}, check_answer: {type: 'string'}
  },
  required: ['answer', 'concept', 'cards', 'mistakes', 'check', 'check_answer']};

const MATH_READ_SYSTEM = `You read a photo of ONE math problem from a Korean elementary-school workbook (3rd grade, e.g. 눈높이 수학 or a 문제집) for "Bella Math", an app that explains HOW to solve a problem to a 9-10 year-old girl without giving her the answer.
- kind: "math" if a math problem is readable. "unclear" if the photo is too blurry, dark, cut off, or a number you need cannot be read for sure (do NOT guess numbers). "not_math" if it is not a math problem.
- If several problems are visible, choose the one that is most centered and complete, and say so in note (Korean, e.g. "여러 문제 중 가운데 문제를 읽었어요"). Otherwise note is "".
- problem: the problem in Korean exactly as written in the workbook, numbers exactly as printed. Write vertical calculations (세로셈) on one line, e.g. "324 × 3 = □". Briefly describe a figure, table or picture that is needed to solve it in [그림: ...]. Ignore pencil marks and anything the child already wrote by hand (do not include her answers).
- say: the problem as it should be read aloud by Korean text-to-speech: no symbols (+ 더하기, − 빼기, × 곱하기, ÷ 나누기, = 는, □ 네모, 3/4 → 4분의 3), digits are fine.
- topic: short Korean unit name, e.g. "세 자리 수의 덧셈", "곱셈(두 자리 × 한 자리)", "나눗셈", "분수", "길이와 시간", "들이와 무게".
- solution: a teacher's answer key in Korean: the solution step by step, using methods taught in Korean 3rd grade (세로셈, 받아올림/받아내림, 곱셈구구, 몫과 나머지, 분수 등). Check each calculation twice.
- answer: the final answer in the workbook's format, with unit if any. If there are several blanks, give all of them.
- answer_forms: every short string that would GIVE AWAY the answer if the child saw it: the number in digits ("972"), with unit ("972원"), fraction both ways ("3/4", "4분의 3"), each labeled part ("몫 5", "나머지 2"), a word answer ("직각삼각형"). Do not list words that already appear in the problem.
If kind is not "math", the other fields may be short or empty.`;

const MATH_LEVELS = {
  1: `LEVEL 1 (기본 설명): explain like a kind teacher using the textbook method, in order. 3-5 cards: first what the problem asks (무엇을 구하는지), then the steps. The last card stops right before the final result and asks her to finish it herself.`,
  2: `LEVEL 2 (더 쉽게): she did not understand the first explanation. Use easier words and smaller steps. First show a SMALLER-NUMBER example of the same type and solve that example completely (its result must be different from the real answer), then show how the real problem works the same way, step by step, stopping before the final result. 4-6 cards.`,
  3: `LEVEL 3 (그림으로): she still did not understand. Explain with pictures and a real-life story she knows (candies, stickers, pizza, colored paper, marbles, money, a ruler, a clock...). Use a pic on most cards. Very short sentences. Concrete before abstract. Stop before the final result. 4-6 cards.`,
  4: `LEVEL 4 (같이 한 걸음씩): solve it TOGETHER with tiny questions. 4-7 cards. Every card except the last explains one tiny step in one or two sentences and asks ONE tiny question in q, with 2-3 short choices (correct = index of the right choice, starting at 0) and a gentle hint in Korean for a wrong choice. Each question is about a small part (one digit, one 곱셈구구 fact, which number to write where) and its right choice must NOT be the final answer. The last card has no question (q "", choices []) and tells her she can now finish the last step on her paper.`
};

const MATH_PIC_RULES = `PICTURES (pic): the app draws simple pictures from these fields. Use kind "none" when a picture does not help. Unused fields: "" or 0 or [].
- objects: groups of emoji. nums = how many in each group, e.g. [4,4,4] = 3 groups of 4 (max 40 items in total). emoji = one emoji (🍬 🍎 🍪 ⭐ 🧁 🐟 ✏️ 🎈). x = how many to cross out from the end (for take-away), else 0. Use small numbers (an example), not the full real problem if it would be too many.
- fraction: x = number of equal parts, y = colored parts, op = "circle" (pizza) or "bar" (chocolate bar).
- column: a vertical calculation (세로셈). op = "+", "-", or "×". top and bottom = the two numbers. result = the partial result shown so far, with "?" for every digit she should still find (same number of digits as the final result), e.g. "?72", or "" to show no result.
- numberline: x = start, y = end (max 30 apart is easiest to read), nums = the points of jumps in order, e.g. [0,3,6,9] draws jumps 0→3→6→9.
- blocks: base-ten blocks. nums = [hundreds, tens, ones], e.g. [3,2,4] for 324 (each at most 9).`;

function mathKidSystem(level, info, prev, adult, name) {
  name = name || '벨라';
  return `You are a kind, cheerful helper in "Bella Math", a math helper app for a 9-10 year-old girl in Korea (3rd grade). Her name is ${name}. She got stuck on a workbook problem. Her parents are not teachers, so you explain it to her.
You have no name of your own: never call yourself by a name or say who is explaining ("토비가", "선생님이" etc.); just talk to her. ${adult ? 'Right now her mom is reading this explanation (to learn how to explain it), but write it for the child exactly the same way.' : ''}

THE MOST IMPORTANT RULE
- NEVER tell the final answer, in any form (digits, words, unit, a picture labeled with it, a choice that is the answer). The answer is given below ONLY so that you can avoid it. Stop right before the last calculation and invite her to do it ("이 부분은 ${name}가 직접 해 볼까?").
- Example numbers you invent must give results different from the real answer.

HOW TO EXPLAIN
- Korean 반말, warm and friendly like a kind older sister talking to her ("~해 볼까?", "~야", "~지?"). Call her by her name on some cards (about one card in three), e.g. "${name}는 어떻게 생각해?", "${name}야, 여기 봐!", "잘했어, ${name}!". Very short sentences a 3rd grader understands. Each card: 1-3 sentences, at most about 90 Korean characters.
- One idea per card. Bold nothing, no markdown, no lists. Emojis: at most one per card.
- Use only methods taught up to Korean 3rd grade (no algebra, no x, no negative numbers). Follow the textbook way (세로셈, 받아올림, 곱셈구구, 몫과 나머지 ...).
- say: the same content written for Korean text-to-speech: no emojis or symbols (+ 더하기, − 빼기, × 곱하기, ÷ 나누기, = 는, □ 네모, ? 물음표 칸, 3/4 → 4분의 3), digits are fine.
- For cards without a question: q "", choices [], correct 0, hint "".
- closing: one short warm Korean sentence for the end with her name (e.g. "${name}야, 이제 문제집에 직접 써 볼까? 할 수 있어!"), without the answer.

${MATH_LEVELS[level]}

${MATH_PIC_RULES}

PROBLEM: ${info.p}
TOPIC: ${info.t}
TEACHER'S SOLUTION (secret, for you only): ${info.s}
ANSWER (secret, NEVER say it): ${info.a}${prev ? '\n\nEXPLANATIONS SHE ALREADY SAW AND DID NOT UNDERSTAND (do not repeat them; explain differently):\n' + prev : ''}`;
}

function mathParentSystem(info, name) {
  name = name || '벨라';
  return `You help a Korean mom teach her 3rd-grade daughter ${name} (9-10 years old) a math problem from a workbook (눈높이 수학 등). The parents are not teachers and feel they explain badly. Write in Korean, polite 해요체, short and practical.
- answer: the final answer (for the mom only), with unit.
- concept: 1-2 sentences: what concept this problem checks, with the 3rd-grade unit name, and why children find it hard.
- cards: 3-5 steps of HOW to teach it. text = what to do with the child (use real objects at home when helpful: 사탕, 동전, 색종이, 블록...). say = an example of exactly what the mom can say to her child, in warm Korean 반말, sometimes using her name (e.g. "${name}야, ..."; one or two short sentences, child-friendly, NOT revealing the answer; the child should find it). tip = one short tip (e.g. "아이가 먼저 말하게 기다려 주세요"). pic: optional picture (see PICTURES), kind "none" if not needed.
- mistakes: 2-3 common mistakes children make on this type of problem, each one short sentence.
- check: one similar easier problem the mom can give to check understanding. check_answer: its answer.
- Use only methods taught up to Korean 3rd grade (no algebra). Encourage patience; never suggest scolding.

${MATH_PIC_RULES}

PROBLEM: ${info.p}
TOPIC: ${info.t}
TEACHER'S SOLUTION: ${info.s}
ANSWER: ${info.a}`;
}

/* 정답은 앱에 보내지 않고 서버 키로 암호화해서 왕복 (AES-GCM) */
async function mathKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bella-math|' + env.ANTHROPIC_API_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await mathKey(env), new TextEncoder().encode(JSON.stringify(obj))));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return b64u(all);
}
async function unseal(env, s) {
  try {
    const all = unb64u(String(s || ''));
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv: all.slice(0, 12)}, await mathKey(env), all.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) { return null; }
}

/* 정답 가리기: 문제에 없는 정답 표현이 설명에 나오면 □로 바꿈 */
const normNum = t => String(t || '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function answerMasker(info) {
  const prob = normNum(info.p);
  const reOf = f => {
    const core = f.split(/\s+/).map(escRe).join('\\s*');
    return (/^\d/.test(f) ? '(?<!\\d)' : '') + core + (/\d$/.test(f) ? '(?!\\d)' : '');
  };
  const forms = (info.f || []).map(f => normNum(str(f, 40))).filter(Boolean)
    .filter(f => !new RegExp(reOf(f)).test(prob))                  // 문제에 이미 있는 숫자·말은 가리지 않음
    .sort((a, b) => b.length - a.length);
  const res = forms.map(f => new RegExp(reOf(f), 'g'));
  const mask = t => {
    let s = normNum(t), hit = false;
    res.forEach(r => { s = s.replace(r, () => { hit = true; return '□'; }); });
    return {s: hit ? s : String(t || ''), hit};
  };
  mask.digits = forms.filter(f => /^\d+$/.test(f));
  return mask;
}
function cleanPic(p, mask) {
  p = p || {};
  const kinds = ['objects', 'fraction', 'column', 'numberline', 'blocks'];
  if (!kinds.includes(p.kind)) return null;
  const int = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));
  const nums = Array.isArray(p.nums) ? p.nums.slice(0, 12).map(v => int(v, 0, 9999)) : [];
  const o = {kind: p.kind};
  if (p.kind === 'objects') {
    o.nums = nums.map(v => Math.min(v, 40)).filter(v => v > 0).slice(0, 10);
    let total = 0; o.nums = o.nums.map(v => { const k = Math.min(v, 40 - total); total += k; return k; }).filter(v => v > 0);
    if (!o.nums.length) return null;
    o.emoji = str(p.emoji, 4) || '🍬'; o.x = int(p.x, 0, total);
  } else if (p.kind === 'fraction') {
    o.x = int(p.x, 1, 16); o.y = int(p.y, 0, o.x); o.op = p.op === 'bar' ? 'bar' : 'circle';
  } else if (p.kind === 'column') {
    o.op = ['+', '-', '×'].includes(p.op) ? p.op : p.op === 'x' || p.op === '*' ? '×' : '+';
    o.top = str(p.top, 6).replace(/[^\d]/g, ''); o.bottom = str(p.bottom, 6).replace(/[^\d]/g, '');
    o.result = str(p.result, 8).replace(/[^\d?]/g, '');
    if (!o.top || !o.bottom) return null;
    if (o.result && mask.digits.includes(o.result.replace(/\?/g, '')) && !o.result.includes('?')) o.result = o.result.replace(/\d/g, '?');
  } else if (p.kind === 'numberline') {
    o.x = int(p.x, 0, 9999); o.y = int(p.y, 0, 9999);
    if (o.y <= o.x) o.y = o.x + 10;
    if (o.y - o.x > 100) o.y = o.x + 100;
    o.nums = nums.filter(v => v >= o.x && v <= o.y).slice(0, 10);
  } else if (p.kind === 'blocks') {
    o.nums = [0, 1, 2].map(i => int(nums[i], 0, 9));
    if (!o.nums.some(v => v)) return null;
  }
  return o;
}

function mathCounts(rec, env) {
  return {used: rec ? (rec.math || 0) : null, max: num(env.MATH_DAILY, MATH_DAILY)};
}

/* 사진(또는 고친 글)로 문제 읽기 + 몰래 풀기 */
async function mathRead(ctx) {
  const {b, env, cors} = ctx;
  const data = String(b.image || '');
  const typed = str(b.text, 600);
  if (!typed && (data.length < 200 || data.length > 2100000 || !/^[A-Za-z0-9+/=]+$/.test(data))) return json({error: 'bad_request'}, 400, cors);
  const rec = await loadDay(env);
  if (rec && (rec.math || 0) >= num(env.MATH_DAILY, MATH_DAILY)) return json(Object.assign({error: 'math_limit'}, mathCounts(rec, env)), 429, cors);
  const content = typed
    ? [{type: 'text', text: 'There is no photo this time. A parent typed (or corrected) the problem text. Treat this as the problem exactly as written:\n' + typed}]
    : [{type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data}}, {type: 'text', text: 'This is the problem photo.'}];
  const out = await guarded(ctx, rec, () => askClaude(env, rec, MATH_READ_SYSTEM, [{role: 'user', content}], MATH_READ_SCHEMA, 6000, mathOpt(env, env.MATH_READ_EFFORT || 'medium')));
  const kind = ['math', 'unclear', 'not_math'].includes(out.kind) ? out.kind : 'unclear';
  const multi = (v, n) => String(v == null ? '' : v).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, n);   // 줄바꿈은 살림
  const r = {kind, problem: multi(out.problem, 600), say: str(out.say, 600), topic: str(out.topic, 60), note: str(out.note, 120)};
  if (kind === 'math' && r.problem && str(out.answer, 200)) {
    const info = {p: r.problem, t: r.topic, s: str(out.solution, 2500), a: str(out.answer, 200),
      f: (Array.isArray(out.answer_forms) ? out.answer_forms : []).map(x => str(x, 40)).filter(Boolean).slice(0, 12)};
    if (!info.f.length) info.f = [info.a];
    r.sealed = await seal(env, info);
  } else if (kind === 'math') r.kind = 'unclear';
  if (rec) {
    if (r.kind === 'math') {
      rec.math = (rec.math || 0) + 1;
      const s = sessionOf(rec, ctx, 'math', 0);
      Object.assign(s, {problem: r.problem, topic: r.topic, answer: str(out.answer, 200), typed: !!typed, levels: s.levels || [], lines: []});
    }
    await saveDay(env, rec);
  }
  return json(Object.assign(r, {counts: mathCounts(rec, env), usage: usage(rec, env)}), 200, cors);
}

/* 단계별 설명: level 1~4 (아이용) 또는 mode=parent (엄마용 가르치는 방법 + 정답) */
async function mathExplain(ctx) {
  const {b, env, cors} = ctx;
  const info = await unseal(env, b.sealed);
  if (!info || !info.p) return json({error: 'sealed'}, 400, cors);
  const parent = b.mode === 'parent';
  if (parent && !ctx.adult) return json({error: 'adult_only'}, 403, cors);
  const level = [1, 2, 3, 4].includes(+b.level) ? +b.level : 1;
  const rec = await loadDay(env);
  if (rec && (rec.mathx || 0) >= num(env.MATH_EXPLAIN_DAILY, MATH_EXPLAIN_DAILY)) return json({error: 'math_limit'}, 429, cors);
  const prev = Array.isArray(b.prev) ? b.prev.slice(-12).map(x => '- ' + str(x, 200)).join('\n') : '';
  const mask = answerMasker(info);
  let r;
  if (parent) {
    const out = await guarded(ctx, rec, () => askClaude(env, rec, mathParentSystem(info, ctx.name), [{role: 'user', content: 'Write the guide for the mom.'}], MATH_PARENT_SCHEMA, 5000, mathOpt(env, 'low')));
    r = {mode: 'parent', answer: info.a, concept: str(out.concept, 300),
      cards: (out.cards || []).slice(0, 6).map(c => ({text: str(c.text, 300), say: mask(str(c.say, 240)).s, tip: str(c.tip, 160), pic: cleanPic(c.pic, mask)})).filter(c => c.text),
      mistakes: (out.mistakes || []).slice(0, 4).map(x => str(x, 160)).filter(Boolean),
      check: str(out.check, 200), check_answer: str(out.check_answer, 80)};
  } else {
    const out = await guarded(ctx, rec, () => askClaude(env, rec, mathKidSystem(level, info, prev, ctx.adult, ctx.name), [{role: 'user', content: 'Write the level ' + level + ' explanation cards.'}], MATH_EXPLAIN_SCHEMA, 6000, mathOpt(env, 'low')));
    let masked = 0;
    const cards = (out.cards || []).slice(0, 8).map(c => {
      const t = mask(str(c.text, 400)), sy = mask(str(c.say, 400));
      let q = mask(str(c.q, 200)), choices = Array.isArray(c.choices) ? c.choices.slice(0, 3).map(x => str(x, 40)).filter(Boolean) : [];
      let correct = parseInt(c.correct, 10) || 0;
      // 고르기 정답이 진짜 정답이면 질문을 없앰
      if (choices.length < 2 || correct < 0 || correct >= choices.length || mask(choices[correct]).hit || q.hit || !q.s) { if (choices.length) masked += q.hit || (choices[correct] && mask(choices[correct]).hit) ? 1 : 0; q = {s: ''}; choices = []; correct = 0; }
      else choices = choices.map(x => mask(x).s);
      if (t.hit || sy.hit) masked++;
      return {text: t.s, say: sy.s || t.s, pic: cleanPic(c.pic, mask), q: q.s, choices, correct, hint: choices.length ? str(c.hint, 160) : ''};
    }).filter(c => c.text);
    if (!cards.length) throw fail('ai', 'no cards');
    r = {mode: 'kid', level, cards, closing: mask(str(out.closing, 160)).s || '이제 문제집에 직접 풀어 볼까? 할 수 있어!', masked};
  }
  if (rec) {
    rec.mathx = (rec.mathx || 0) + 1;
    const s = sessionOf(rec, ctx, 'math', parent ? 0 : level);
    if (!s.problem) Object.assign(s, {problem: info.p, topic: info.t, answer: info.a});
    s.levels = s.levels || []; s.lines = s.lines || [];
    if (parent) s.parent = true; else if (!s.levels.includes(level)) s.levels.push(level);
    s.level = Math.max(0, ...s.levels);
    if (b.result === 'stuck') s.stuck = true;
    await saveDay(env, rec);
  }
  return json(Object.assign(r, {usage: usage(rec, env)}), 200, cors);
}

/* 앱에서 "이해했어요" / "엄마랑 같이" 결과만 기록 (AI 호출 없음) */
async function mathDone(ctx) {
  const {b, env, cors} = ctx;
  const rec = await loadDay(env);
  if (rec && rec.sessions[str(b.sid, 40)]) {
    const s = rec.sessions[str(b.sid, 40)];
    s.result = b.result === 'understood' ? 'understood' : 'stuck';
    s.doneLevel = [1, 2, 3, 4].includes(+b.level) ? +b.level : 0;
    await saveDay(env, rec);
  }
  return json({ok: true}, 200, cors);
}

async function logs(b, env) {
  if (!env.BELLA_KV) return {kv: false, days: []};
  const n = Math.min(Math.max(parseInt(b.days, 10) || 7, 1), 30);
  const days = [];
  for (let i = 0; i < n; i++) {
    const rec = await env.BELLA_KV.get('day:' + kstDay(i), 'json');
    if (rec) days.push(rec);
  }
  const today = await loadDay(env);
  return {kv: true, scenes: Object.assign(Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, v.ko])), {picture: '🎨 그림 이야기', math: '🧮 수학 풀이'}),
    who: Object.fromEntries(Object.entries(WHO).map(([k, v]) => [k, v.ko])), usage: usage(today, env), limits: limits(env), days};
}

/* ---------- 부모용 대화 기록 화면 (/parent) ---------- */
const PARENT_HTML = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bella · 가족 기록</title>
<style>
body{margin:0;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;background:#fff6f9;color:#2b2b2b}
header{background:#ff7aa8;color:#fff;padding:14px 16px;font-size:18px;font-weight:700}
main{max-width:720px;margin:0 auto;padding:14px}
.card{background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
input,select,button{font-size:16px;padding:9px;border-radius:10px;border:1px solid #ddd}
button{background:#ff7aa8;color:#fff;border:none;cursor:pointer}
.day{font-weight:700;color:#e0457b;margin:18px 0 8px}
.s{border-top:1px solid #f3e6ec;padding:10px 0}.s:first-child{border-top:none}
.t{color:#777;font-size:13px}.l{margin:4px 0;font-size:15px}.c{color:#b0306a}
.fix{background:#fffbe0;border-radius:8px;padding:6px 8px;margin:4px 0;font-size:14px}
.sum{background:#f0f7ff;border-radius:8px;padding:8px;margin-top:6px;font-size:14px}
.money b{font-size:20px;color:#e0457b}.low{color:#c00;font-weight:700}
details summary{cursor:pointer}
</style></head><body><header>👧 Bella · 가족 대화 · 🧮 수학 기록</header><main>
<div class="card"><input id="code" type="password" placeholder="부모 코드" style="width:150px">
<select id="days"><option value="1">오늘</option><option value="3">3일</option><option value="7" selected>7일</option><option value="14">14일</option><option value="30">30일</option></select>
<select id="who"><option value="">가족 모두</option><option value="kid">👧 딸</option><option value="dad">👨 아빠</option><option value="mom">👩 엄마</option></select>
<button id="go">보기</button><div id="msg" class="t" style="margin-top:8px"></div></div><div id="money"></div><div id="out"></div></main>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LV={1:'🌱 초급',2:'🌿 중급',3:'🌳 고급'};
const usd=v=>'$'+(+v||0).toFixed(2);
try{$('#code').value=localStorage.getItem('bellaParentCode')||'';}catch(e){}
$('#go').onclick=async()=>{
  $('#msg').textContent='불러오는 중...';
  try{
    const r=await fetch('logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('#code').value,days:$('#days').value})});
    const d=await r.json();
    if(!r.ok){$('#msg').textContent=d.error==='code'?'코드가 맞지 않아요.':'오류: '+(d.error||r.status);return;}
    try{localStorage.setItem('bellaParentCode',$('#code').value);}catch(e){}
    if(!d.kv){$('#msg').textContent='서버 기록 저장(KV)이 연결되지 않았어요. 기록은 각 기기의 앱 → 기록 탭에서 볼 수 있어요.';$('#out').innerHTML='';return;}
    const u=d.usage||{};
    $('#money').innerHTML='<div class="card money">💳 사용 금액(추정) · 오늘 <b>'+usd(u.today)+'</b> · 이번 달 <b>'+usd(u.month)+'</b>'+
      (u.credit?' · 충전 후 '+usd(u.sinceCredit)+' / '+usd(u.credit)+'<br>남은 금액(추정) <b>'+usd(u.left)+'</b>'+(u.low?' <span class="low">— 곧 충전이 필요해요</span>':''):'<br><span class="t">CREDIT_USD를 넣으면 남은 금액도 보여요</span>')+
      '<div class="t">한 사람 하루 '+d.limits.person+'번 (+'+d.limits.step+'번씩 더 하기) · 가족 전체 하루 최대 '+d.limits.max+'번</div></div>';
    const who=$('#who').value;
    $('#msg').textContent=d.days.length?'':'이 기간에 AI 친구 대화·수학 풀이가 없어요.';
    $('#out').innerHTML=d.days.map(day=>{
      const ss=Object.values(day.sessions||{}).filter(s=>!who||(s.who||'kid')===who).sort((a,b)=>b.t-a.t);
      const pp=Object.entries(day.people||{}).map(([k,p])=>(d.who[k]||k)+' '+p.turns+'번').join(' · ')+(day.math?' · 🧮 수학 '+day.math+'문제':'');
      return '<div class="day">'+esc(day.day)+' · 대답 '+day.turns+'번'+(pp?' ('+esc(pp)+')':'')+' · '+usd(day.usd)+'</div><div class="card">'+(ss.length?ss.map(s=>{
        const tm=new Date(s.t);const hm=tm.getHours()+':'+String(tm.getMinutes()).padStart(2,'0');
        if(s.scene==='math'){
          const lv=(s.levels||[]).length?'설명 '+Math.max(...s.levels)+'단계까지':'설명 안 봄';
          const res=s.result==='understood'?' · 😊 이해했어요'+(s.doneLevel?'('+s.doneLevel+'단계)':''):s.result==='stuck'?' · <span class="low">🤔 엄마랑 같이 보기</span>':'';
          return '<div class="s"><details><summary>'+esc(d.who[s.who||'kid']||'')+' · <b>🧮 '+esc(s.topic||'수학')+'</b> <span class="t">'+hm+' · '+lv+(s.parent?' · 가르치는 방법 봄':'')+'</span>'+res+'</summary>'+
            '<div class="l">📄 '+esc(s.problem)+'</div><div class="fix">정답: <b>'+esc(s.answer)+'</b></div></details></div>';
        }
        const kids=s.lines.filter(x=>x.w==='c').length;const me=(d.who[s.who||'kid']||'').split(' ')[0];
        const sum=s.summary?'<div class="sum">🌟 '+esc(s.summary.praise)+(s.summary.better||[]).map(x=>'<div>✏️ '+esc(x.said)+' → <b>'+esc(x.better)+'</b> '+esc(x.ko)+'</div>').join('')+(s.summary.words&&s.summary.words.length?'<div>📒 '+s.summary.words.map(w=>esc(w.en)+'('+esc(w.ko)+')').join(', ')+'</div>':'')+'<div>👉 '+esc(s.summary.tip)+'</div></div>':'';
        const fx=(s.fixes||[]).map(x=>'<div class="fix">💡 '+esc(x.said)+' → <b>'+esc(x.better)+'</b> '+esc(x.ko)+'</div>').join('');
        return '<div class="s"><details><summary>'+esc(d.who[s.who||'kid']||'')+' · <b>'+esc(d.scenes[s.scene]||s.scene)+'</b> '+(LV[s.level]||'')+' <span class="t">'+hm+' · 대답 '+kids+'번</span></summary>'+
          s.lines.map(x=>'<div class="l'+(x.w==='c'?' c':'')+'">'+(x.w==='c'?me+' ':'🤖 ')+esc(x.x)+'</div>').join('')+fx+'</details>'+sum+'</div>';
      }).join(''):'<span class="t">대화 없음</span>')+'</div>';
    }).join('');
  }catch(e){$('#msg').textContent='연결 오류: '+e.message;}
};
</script></body></html>`;
