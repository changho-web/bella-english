/* =====================================================================
   Bella English — AI 토비 연결 서버 (Cloudflare Worker)
   ---------------------------------------------------------------------
   앱(탭) → 이 서버 → Claude API.  API 키는 이 서버에만 있고 앱에는 없음.

   [Cloudflare에 넣는 방법]
   1) Workers & Pages → Create application → Start with Hello World! → 이름 bella-tobi → Deploy
   2) Edit code → 원래 코드를 지우고 이 파일 내용 전체를 붙여넣기 → Deploy
   3) Settings → Variables and Secrets → Add → Type: Secret 으로 추가
        ANTHROPIC_API_KEY : Claude 콘솔에서 받은 API 키 (sk-ant-...)
        FAMILY_CODE       : 앱에 넣을 가족 코드 (예: 영어+숫자 8자 이상)
        PARENT_CODE       : (선택) 부모용 기록 보기 코드. 없으면 FAMILY_CODE 사용
   4) (권장) Workers KV → Create instance → 이름 bella →
      bella-tobi Worker → Bindings → Add binding → KV namespace, Variable name: BELLA_KV
        - 있으면: 서버에서도 하루 60번 제한 + 부모님이 어디서나 대화 기록 확인 (/parent)
        - 없으면: 제한은 탭에서만, 기록도 탭 안에만 저장
   5) 주소(https://bella-tobi.○○○.workers.dev)와 가족 코드를 앱 설정 → "AI 토비 연결"에 입력
   ===================================================================== */

const DEFAULT_MODEL = 'claude-haiku-5-5';
const TURN_LIMIT = 60;    // 하루 아이 대답 수 (AI 토비 대화)
const EXTRA_LIMIT = 40;   // 하루 대화 시작 + 요약 + 예문 만들기 수
const KEEP_DAYS = 90;     // 서버 기록 보관 일수
const ORIGINS = ['https://changho-web.github.io', 'http://localhost:8517', 'http://127.0.0.1:8517'];

/* ---------- 상황 (앱 상황극 12개 + 자유 대화 + 단어 대화) ---------- */
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
  free:     {ko: '💬 자유 대화', min: 6, max: 10, en: 'Free chat as friends. Talk about her day, favorite foods, animals, games, seasons, and fun "what if" questions (e.g. "If you had a magic pet, what would it be?"). If she seems stuck, choose a new fun topic yourself.'},
  words:    {ko: '📚 오늘 배운 단어로 대화', min: 5, max: 8, en: 'Friendly chat built around the words she just learned (see TODAY\'S WORDS). Make it a fun conversation, not a quiz.'}
};

const LEVELS = {
  1: 'Beginner (초급). Use very short, very easy sentences: at most 2 sentences, each at most 8 words. Use only common words. Often ask yes/no or choice questions ("Do you like cats or dogs?"). hint: 2-6 words.',
  2: 'Intermediate (중급). Use short, clear sentences: at most 2 sentences, each at most 12 words. Ask simple what/where/who questions and invite full-sentence answers. hint: one sentence of 5-10 words.',
  3: 'Advanced (고급). Talk naturally like a friendly native-speaker kid: at most 3 sentences, under 35 words total. Ask why/how follow-up questions and invite longer answers. hint: 1-2 sentences, 8-16 words.'
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

/* ---------- 토비 지시문 ---------- */
function tobiSystem(sceneId, lv, words, n) {
  const sc = SCENES[sceneId];
  let wordPart = '';
  if (sceneId === 'words' && words.length) {
    wordPart = '\nTODAY\'S WORDS (she just learned these): ' + words.map(w => w.en + (w.ko ? ' (' + w.ko + ')' : '')).join(', ') +
      '\nUse these words naturally, about one per turn, and ask questions that make her want to use them. When she uses one, cheer briefly ("Great, you used library!").';
  }
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

ENDING
- This conversation should last about ${sc.max} of her answers. She has answered ${n} time(s) so far.
- When the scene's goal is done and she has answered at least ${sc.min} times, or when she has answered ${sc.max} times, say a warm goodbye with one short praise and set end to true. Otherwise end is false.

OUTPUT FIELDS
- reply: what you say now (English).
- ko: natural Korean translation of reply, easy for a 10-year-old.
- hint: one example answer she could say next, at her level, answering your question (use ___ where her own name would go). Empty if end is true.
- hint_ko: Korean meaning of hint.
- fix: as described above.
- effort: about HER LAST MESSAGE. "good" = a real English answer that fits (a sentence at Intermediate/Advanced; at Beginner even 1-3 fitting words are good). "short" = an English attempt that is very short for her level, unclear, or only partly fits. "none" = no real English answer (silence, nonsense, Korean), or there is no message from her yet.

SCENE: ${sc.en}
LEVEL: ${LEVELS[lv]}${wordPart}`;
}

function summarySystem(sceneId, lv) {
  return `You write a short, encouraging report in Korean (해요체, warm and simple) for a 10-year-old girl and her parent, after she practiced speaking English with Tobi, an AI fox friend.
Scene: ${SCENES[sceneId].en}
Level: ${LEVELS[lv].split('.')[0]}
Her lines came from speech recognition, so ignore likely recognition errors.
- praise: 1-2 warm, specific Korean sentences about what she did well (mention a real sentence or word she used).
- better: up to 3 of her sentences that could be more natural. said = her words exactly as in the transcript, better = natural English, ko = a short Korean tip. Empty array if nothing important.
- words: up to 4 useful English words or short expressions from this conversation worth learning, preferring ones Tobi used that may be new to her. en = English, ko = Korean meaning.
- tip: one short Korean sentence about what to try next time.`;
}

const EXAMPLES_SYSTEM = `For each English word, write one short, simple example sentence (5-10 words) that a 10-year-old would use in daily life, plus its natural Korean translation. Use the given Korean meaning to choose the right sense. Keep "en" exactly as given. Child-friendly content only.`;

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
      if (url.pathname === '/ping') return json(await ping(env, b), 200, cors);
      if (url.pathname === '/chat') return await chat(b, env, cors);
      if (url.pathname === '/summary') return await summary(b, env, cors);
      if (url.pathname === '/examples') return await examples(b, env, cors);
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

function kstDay(daysAgo) { return new Date(Date.now() + 9 * 3600e3 - (daysAgo || 0) * 86400e3).toISOString().slice(0, 10); }
function turnLimit(env) { const n = parseInt(env.DAILY_LIMIT, 10); return n > 0 ? n : TURN_LIMIT; }
async function loadDay(env, day) {
  if (!env.BELLA_KV) return null;
  return (await env.BELLA_KV.get('day:' + day, 'json')) || {day, turns: 0, extra: 0, sessions: {}};
}
async function saveDay(env, rec) {
  if (!env.BELLA_KV) return;
  const ids = Object.keys(rec.sessions);
  if (ids.length > 40) ids.sort((a, b) => rec.sessions[a].t - rec.sessions[b].t).slice(0, ids.length - 40).forEach(k => delete rec.sessions[k]);
  await env.BELLA_KV.put('day:' + rec.day, JSON.stringify(rec), {expirationTtl: KEEP_DAYS * 86400});
}
function sessionOf(rec, b, sceneId, lv) {
  const sid = str(b.sid, 40) || ('s' + Date.now());
  const s = rec.sessions[sid] || (rec.sessions[sid] = {t: Date.now(), scene: sceneId, level: lv, lines: []});
  s.level = lv;
  return s;
}
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  return h.slice(-30).map(x => ({w: x && x.w === 'c' ? 'c' : 't', x: str(x && x.x, 400)}));
}
function cleanWords(w) {
  if (!Array.isArray(w)) return [];
  return w.slice(0, 12).map(x => ({en: str(x && x.en, 40), ko: str(x && x.ko, 40)})).filter(x => x.en);
}
function sceneOf(b) { return SCENES[b.scene] ? b.scene : 'free'; }
function levelOf(b) { return [1, 2, 3].includes(+b.level) ? +b.level : 1; }

/* 앱 대화 기록 → Claude 메시지 (사용자 차례로 끝나야 함) */
function toMessages(hist) {
  const msgs = [{role: 'user', content: '[The app just opened this scene. Start the conversation: greet her and ask your first question.]'}];
  hist.forEach(h => {
    const role = h.w === 'c' ? 'user' : 'assistant';
    const content = h.x || (role === 'user' ? '[silence]' : '...');
    const last = msgs[msgs.length - 1];
    if (last.role === role) last.content += '\n' + content; else msgs.push({role, content});
  });
  if (msgs[msgs.length - 1].role !== 'user') msgs.push({role: 'user', content: '[She is quiet. Continue gently.]'});
  return msgs;
}

async function askClaude(env, system, messages, schema, maxTokens) {
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
  if (data.stop_reason === 'refusal') throw fail('refusal', 'refusal');
  const block = (data.content || []).find(c => c.type === 'text');
  if (!block) throw fail('ai', 'no text (' + data.stop_reason + ')');
  try { return JSON.parse(block.text); } catch (e) { throw fail('ai', 'bad json (' + data.stop_reason + ')'); }
}

async function ping(env, b) {
  if (b.check) {   // 부모님 연결 테스트: API 키·충전 잔액까지 확인 (아주 짧은 질문 1번)
    await askClaude(env, 'Answer with ok = true.', [{role: 'user', content: 'ping'}],
      {type: 'object', additionalProperties: false, properties: {ok: {type: 'boolean'}}, required: ['ok']}, 300);
  }
  const rec = await loadDay(env, kstDay());
  return {ok: true, model: env.MODEL || DEFAULT_MODEL, kv: !!env.BELLA_KV, used: rec ? rec.turns : null, limit: turnLimit(env)};
}

async function chat(b, env, cors) {
  const sceneId = sceneOf(b), lv = levelOf(b);
  const hist = cleanHistory(b.history);
  const n = hist.filter(h => h.w === 'c').length;
  const isTurn = n > 0;
  const limit = turnLimit(env);
  const rec = await loadDay(env, kstDay());
  if (rec && isTurn && rec.turns >= limit) return json({error: 'limit', used: rec.turns, limit}, 429, cors);
  if (rec && !isTurn && rec.extra >= EXTRA_LIMIT) return json({error: 'limit', used: rec.turns, limit}, 429, cors);

  const out = await askClaude(env, tobiSystem(sceneId, lv, cleanWords(b.words), n), toMessages(hist), REPLY_SCHEMA, 1500);
  const fx = out.fix || {};
  const r = {
    reply: str(out.reply, 400) || 'Can you say that again?',
    ko: str(out.ko, 300), hint: out.end ? '' : str(out.hint, 200), hint_ko: out.end ? '' : str(out.hint_ko, 200),
    fix: fx.better && fx.said && fx.better.toLowerCase() !== fx.said.toLowerCase() ? {said: str(fx.said, 200), better: str(fx.better, 200), ko: str(fx.ko, 80)} : null,
    effort: isTurn && ['good', 'short', 'none'].includes(out.effort) ? out.effort : 'none',
    end: !!out.end && isTurn
  };
  if (rec) {
    if (isTurn) rec.turns++; else rec.extra++;
    const s = sessionOf(rec, b, sceneId, lv);
    s.lines = hist.concat([{w: 't', x: r.reply}]);
    if (r.fix) (s.fixes = s.fixes || []).push(r.fix);
    await saveDay(env, rec);
  }
  return json(Object.assign(r, {used: rec ? rec.turns : null, limit}), 200, cors);
}

async function summary(b, env, cors) {
  const sceneId = sceneOf(b), lv = levelOf(b);
  const hist = cleanHistory(b.history);
  if (!hist.some(h => h.w === 'c')) return json({error: 'bad_request'}, 400, cors);
  const rec = await loadDay(env, kstDay());
  if (rec && rec.extra >= EXTRA_LIMIT) return json({error: 'limit', used: rec.turns, limit: turnLimit(env)}, 429, cors);
  const transcript = hist.map(h => (h.w === 'c' ? 'Child: ' : 'Tobi: ') + h.x).join('\n');
  const out = await askClaude(env, summarySystem(sceneId, lv), [{role: 'user', content: 'Transcript:\n' + transcript}], SUMMARY_SCHEMA, 2000);
  const r = {
    praise: str(out.praise, 300), tip: str(out.tip, 200),
    better: (out.better || []).filter(x => x && x.better).slice(0, 3).map(x => ({said: str(x.said, 200), better: str(x.better, 200), ko: str(x.ko, 80)})),
    words: (out.words || []).filter(x => x && x.en).slice(0, 4).map(x => ({en: str(x.en, 40), ko: str(x.ko, 40)}))
  };
  if (rec) {
    rec.extra++;
    const s = sessionOf(rec, b, sceneId, lv);
    if (hist.length >= s.lines.length) s.lines = hist;
    s.summary = r;
    await saveDay(env, rec);
  }
  return json(r, 200, cors);
}

async function examples(b, env, cors) {
  const words = cleanWords(b.words);
  if (!words.length) return json({items: []}, 200, cors);
  const rec = await loadDay(env, kstDay());
  if (rec && rec.extra >= EXTRA_LIMIT) return json({error: 'limit', used: rec.turns, limit: turnLimit(env)}, 429, cors);
  const out = await askClaude(env, EXAMPLES_SYSTEM, [{role: 'user', content: words.map(w => w.en + (w.ko ? ' = ' + w.ko : '')).join('\n')}], EXAMPLES_SCHEMA, 2000);
  if (rec) { rec.extra++; await saveDay(env, rec); }
  return json({items: (out.items || []).map(x => ({en: str(x.en, 40), ex: str(x.ex, 160), ex_ko: str(x.ex_ko, 160)})).filter(x => x.en && x.ex)}, 200, cors);
}

async function logs(b, env) {
  if (!env.BELLA_KV) return {kv: false, days: []};
  const n = Math.min(Math.max(parseInt(b.days, 10) || 7, 1), 30);
  const days = [];
  for (let i = 0; i < n; i++) {
    const rec = await env.BELLA_KV.get('day:' + kstDay(i), 'json');
    if (rec) days.push(rec);
  }
  return {kv: true, scenes: Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, v.ko])), days};
}

/* ---------- 부모용 대화 기록 화면 (/parent) ---------- */
const PARENT_HTML = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bella English · 부모용 대화 기록</title>
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
details summary{cursor:pointer}
</style></head><body><header>🦊 Bella English · 부모용 대화 기록</header><main>
<div class="card"><input id="code" type="password" placeholder="부모 코드" style="width:150px">
<select id="days"><option value="1">오늘</option><option value="3">3일</option><option value="7" selected>7일</option><option value="14">14일</option><option value="30">30일</option></select>
<button id="go">보기</button><div id="msg" class="t" style="margin-top:8px"></div></div><div id="out"></div></main>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LV={1:'🌱 초급',2:'🌿 중급',3:'🌳 고급'};
try{$('#code').value=localStorage.getItem('bellaParentCode')||'';}catch(e){}
$('#go').onclick=async()=>{
  $('#msg').textContent='불러오는 중...';
  try{
    const r=await fetch('logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('#code').value,days:$('#days').value})});
    const d=await r.json();
    if(!r.ok){$('#msg').textContent=d.error==='code'?'코드가 맞지 않아요.':'오류: '+(d.error||r.status);return;}
    try{localStorage.setItem('bellaParentCode',$('#code').value);}catch(e){}
    if(!d.kv){$('#msg').textContent='서버 기록 저장(KV)이 연결되지 않았어요. 기록은 탭의 앱 → 기록 탭에서 볼 수 있어요.';$('#out').innerHTML='';return;}
    $('#msg').textContent=d.days.length?'':'이 기간에 AI 토비 대화가 없어요.';
    $('#out').innerHTML=d.days.map(day=>{
      const ss=Object.values(day.sessions||{}).sort((a,b)=>b.t-a.t);
      return '<div class="day">'+esc(day.day)+' · 아이 대답 '+day.turns+'번</div><div class="card">'+ss.map(s=>{
        const tm=new Date(s.t);const kids=s.lines.filter(x=>x.w==='c').length;
        const sum=s.summary?'<div class="sum">🌟 '+esc(s.summary.praise)+(s.summary.better||[]).map(x=>'<div>✏️ '+esc(x.said)+' → <b>'+esc(x.better)+'</b> '+esc(x.ko)+'</div>').join('')+(s.summary.words&&s.summary.words.length?'<div>📒 '+s.summary.words.map(w=>esc(w.en)+'('+esc(w.ko)+')').join(', ')+'</div>':'')+'<div>👉 '+esc(s.summary.tip)+'</div></div>':'';
        const fx=(s.fixes||[]).map(x=>'<div class="fix">💡 '+esc(x.said)+' → <b>'+esc(x.better)+'</b> '+esc(x.ko)+'</div>').join('');
        return '<div class="s"><details><summary><b>'+esc(d.scenes[s.scene]||s.scene)+'</b> '+(LV[s.level]||'')+' <span class="t">'+tm.getHours()+':'+String(tm.getMinutes()).padStart(2,'0')+' · 대답 '+kids+'번</span></summary>'+
          s.lines.map(x=>'<div class="l'+(x.w==='c'?' c':'')+'">'+(x.w==='c'?'👧 ':'🦊 ')+esc(x.x)+'</div>').join('')+fx+'</details>'+sum+'</div>';
      }).join('')+'</div>';
    }).join('');
  }catch(e){$('#msg').textContent='연결 오류: '+e.message;}
};
</script></body></html>`;
