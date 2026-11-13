/* =====================================================================
   Bella English — AI 토비 연결 서버 (Cloudflare Worker) · 가족용
   ---------------------------------------------------------------------
   앱 → 이 서버 → Claude API.  API 키는 이 서버에만 있고 앱에는 없음.
   가족: kid(딸) / dad(아빠) / mom(엄마)  — 어른은 어른용 토비·상황으로 대화

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
        - 있으면: 서버에서도 횟수 제한 + 사용 금액 계산 + 어디서나 대화 기록 확인 (/parent)
        - 없으면: 제한은 기기에서만, 기록도 기기 안에만 저장
   5) 주소(https://bella-tobi.○○○.workers.dev)와 가족 코드를 앱 설정 → "AI 토비 연결"에 입력
   ===================================================================== */

const DEFAULT_MODEL = 'claude-haiku-5-5';
const PERSON_LIMIT = 100;   // 한 사람 하루 기본 대답 수
const EXTEND_STEP = 50;     // "더 하기" 한 번에 늘어나는 수
const DAILY_MAX = 500;      // 가족 전체 하루 대답 최대 (안전 상한)
const EXTRA_LIMIT = 300;    // 가족 전체 하루 대화 시작·요약·한국어 도우미·예문 수
const PRICE_IN = 0.10, PRICE_OUT = 0.50;   // 100만 토큰당 달러 (Claude Haiku 5.5)
const KEEP_DAYS = 400;      // 서버 기록 보관 일수 (충전 금액 유효기간 1년 + 여유)
const ORIGINS = ['https://changho-web.github.io', 'http://localhost:8517', 'http://127.0.0.1:8517'];

const WHO = {kid: {ko: '👧 딸', adult: false}, dad: {ko: '👨 아빠', adult: true}, mom: {ko: '👩 엄마', adult: true}};

/* ---------- 상황: 아이용 12개 + 어른용 12개 + 자유 대화 + 단어 대화 ---------- */
const SCENES = {
  friend:   {ko: '🧒 새 친구 만나기', min: 4, max: 7, en: 'You are Tobi, a kid who just moved to her neighborhood from Canada. You meet her for the first time and want to be friends. Talk about names, age, likes, hobbies, and favorite things.'},
  icecream: {ko: '🍦 아이스크림 가게', min: 4, max: 7, en: 'You work at "Tobi\'s Ice Cream". She is the customer. Help her order: flavor, cup or cone, size, toppings, for here or to go, paying. Goal: she gets her ice cream.'},
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

/* ---------- 토비 지시문 ---------- */
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

function kidSystem(sceneId, lv, words, n) {
  const sc = SCENES[sceneId];
  return `You are Tobi, a cheerful, kind fox character in "Bella English", an English speaking-practice app for a 10-year-old girl in Korea.
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
  return `You are Tobi, a friendly, patient English conversation partner in "Bella English", a family English-speaking app.
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
  return `You write a short, encouraging report in Korean (해요체, warm and simple) for ${who}, after a speaking practice with Tobi, an AI conversation partner.
Scene: ${SCENES[sceneId].en}
Level: ${(adult ? LEVELS_ADULT : LEVELS_KID)[lv].split('.')[0]}
The learner's lines came from speech recognition, so ignore likely recognition errors.
- praise: 1-2 warm, specific Korean sentences about what they did well (mention a real sentence or expression they used).
- better: up to ${adult ? 4 : 3} of their sentences that could be more natural${adult ? ' or more polite for the situation' : ''}. said = their words exactly as in the transcript, better = natural English, ko = a short Korean tip. Empty array if nothing important.
- words: up to ${adult ? 5 : 4} useful English words or ${adult ? 'set phrases for this situation' : 'short expressions'} from this conversation worth learning, preferring ones Tobi used that may be new. en = English, ko = Korean meaning.
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
      if (text.length > 40000) return json({error: 'too_big'}, 413, cors);
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
      switch (url.pathname) {
        case '/ping': return await ping(ctx);
        case '/chat': return await chat(ctx);
        case '/summary': return await summary(ctx);
        case '/translate': return await translate(ctx);
        case '/examples': return await examples(ctx);
        case '/extend': return await extend(ctx);
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

function toMessages(hist) {
  const msgs = [{role: 'user', content: '[The app just opened this scene. Start the conversation: greet the learner and ask your first question.]'}];
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
async function askClaude(env, rec, system, messages, schema, maxTokens) {
  const effort = env.EFFORT || 'low';
  const send = withEffort => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    body: JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, system, messages,
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
  if (rec) rec.usd += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * num(env.PRICE_IN, PRICE_IN) / 1e6 +
    (u.output_tokens || 0) * num(env.PRICE_OUT, PRICE_OUT) / 1e6;
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
  return json(Object.assign({ok: true, model: env.MODEL || DEFAULT_MODEL, kv: !!env.BELLA_KV, usage: usage(rec, env)}, counts(rec, ctx.who, L)), 200, ctx.cors);
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

  const system = (ctx.adult ? adultSystem : kidSystem)(sceneId, lv, cleanWords(b.words), n);
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
  const transcript = hist.map(h => (h.w === 'c' ? 'Learner: ' : 'Tobi: ') + h.x).join('\n');
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

async function logs(b, env) {
  if (!env.BELLA_KV) return {kv: false, days: []};
  const n = Math.min(Math.max(parseInt(b.days, 10) || 7, 1), 30);
  const days = [];
  for (let i = 0; i < n; i++) {
    const rec = await env.BELLA_KV.get('day:' + kstDay(i), 'json');
    if (rec) days.push(rec);
  }
  const today = await loadDay(env);
  return {kv: true, scenes: Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, v.ko])),
    who: Object.fromEntries(Object.entries(WHO).map(([k, v]) => [k, v.ko])), usage: usage(today, env), limits: limits(env), days};
}

/* ---------- 부모용 대화 기록 화면 (/parent) ---------- */
const PARENT_HTML = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bella English · 가족 대화 기록</title>
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
</style></head><body><header>🦊 Bella English · 가족 대화 기록</header><main>
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
    $('#msg').textContent=d.days.length?'':'이 기간에 AI 토비 대화가 없어요.';
    $('#out').innerHTML=d.days.map(day=>{
      const ss=Object.values(day.sessions||{}).filter(s=>!who||(s.who||'kid')===who).sort((a,b)=>b.t-a.t);
      const pp=Object.entries(day.people||{}).map(([k,p])=>(d.who[k]||k)+' '+p.turns+'번').join(' · ');
      return '<div class="day">'+esc(day.day)+' · 대답 '+day.turns+'번'+(pp?' ('+esc(pp)+')':'')+' · '+usd(day.usd)+'</div><div class="card">'+(ss.length?ss.map(s=>{
        const tm=new Date(s.t);const kids=s.lines.filter(x=>x.w==='c').length;const me=(d.who[s.who||'kid']||'').split(' ')[0];
        const sum=s.summary?'<div class="sum">🌟 '+esc(s.summary.praise)+(s.summary.better||[]).map(x=>'<div>✏️ '+esc(x.said)+' → <b>'+esc(x.better)+'</b> '+esc(x.ko)+'</div>').join('')+(s.summary.words&&s.summary.words.length?'<div>📒 '+s.summary.words.map(w=>esc(w.en)+'('+esc(w.ko)+')').join(', ')+'</div>':'')+'<div>👉 '+esc(s.summary.tip)+'</div></div>':'';
        const fx=(s.fixes||[]).map(x=>'<div class="fix">💡 '+esc(x.said)+' → <b>'+esc(x.better)+'</b> '+esc(x.ko)+'</div>').join('');
        return '<div class="s"><details><summary>'+esc(d.who[s.who||'kid']||'')+' · <b>'+esc(d.scenes[s.scene]||s.scene)+'</b> '+(LV[s.level]||'')+' <span class="t">'+tm.getHours()+':'+String(tm.getMinutes()).padStart(2,'0')+' · 대답 '+kids+'번</span></summary>'+
          s.lines.map(x=>'<div class="l'+(x.w==='c'?' c':'')+'">'+(x.w==='c'?me+' ':'🦊 ')+esc(x.x)+'</div>').join('')+fx+'</details>'+sum+'</div>';
      }).join(''):'<span class="t">대화 없음</span>')+'</div>';
    }).join('');
  }catch(e){$('#msg').textContent='연결 오류: '+e.message;}
};
</script></body></html>`;
