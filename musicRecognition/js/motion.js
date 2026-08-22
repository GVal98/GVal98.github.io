// Временный инструмент: запись акселерометра.
//
// Слух у приложения уже есть — оно само слышит, что заиграла музыка, и само
// решает, когда спрашивать AudD. Хочется второго выключателя, ногой: одна поза
// слушает, другая молчит. Написать такой выключатель не из чего, пока
// неизвестно, чем одна поза отличается от другой в цифрах: какая ось её
// замечает, насколько разрыв между позами больше собственной дрожи и сколько
// времени занимает переход. Эта страница снимает ровно это и уедет из проекта
// вместе с motion.html, как только пороги будут известны.
//
// Телефон при записи лежит в кармане, до экрана не дотянуться, поэтому разметка
// идёт не пальцем, а по расписанию: телефон сам командует вибрацией, какую позу
// занять, и сам подписывает этим кадры. Секунды сразу после команды в
// статистику не идут — это переход, а не поза.

const LS_SESSIONS = 'musicRecognition.motion';
const LS_CFG = 'musicRecognition.motionCfg';
const SESSIONS_KEPT = 10;

// Ноль и единица заняты служебными метками, позы начинаются с двойки.
const LBL_PREP = 0;
const LBL_TRANS = 1;
const LBL_FIRST = 2;

// Кадр записи. Хранится массивом, а не объектом: те же числа в JSON весят втрое
// меньше, а запись на минуту — это несколько тысяч кадров.
const FIELDS = ['t', 'ax', 'ay', 'az', 'lx', 'ly', 'lz', 'rx', 'ry', 'rz', 'beta', 'gamma', 'l'];

const DEFAULTS = {
  v: 2,          // версия набора настроек, см. loadCfg
  nameA: 'нога опущена',
  nameB: 'нога поднята',
  prep: 10,      // с на то, чтобы убрать телефон в карман и сесть как обычно
  settle: 2.5,   // с после команды — это движение, в статистику не идёт
  hold: 6,       // с удержания позы: вот они и есть данные
  cycles: 4,     // сколько раз повторить пару поз
  freeName: 'иду',
};

// Команды даёт вибрация: одна длинная — первая поза, две короткие — вторая.
// Считать на ощупь нечего, разница слышна рукой сразу.
const BUZZ = {
  tick: [70],
  A: [500],
  B: [180, 140, 180],
  end: [700, 200, 700],
};

// Сглаживание, на котором меряется рекомендация. Настоящий выключатель всё
// равно будет усреднять — мгновенное значение дрожит от каждого шага, — так что
// и порог честнее выбирать по сглаженному сигналу, а не по сырому.
const SMOOTH_SEC = 0.5;
const TRACE_SEC = 20;   // сколько секунд держит график живых значений

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (v) => Math.round((v || 0) * 1000) / 1000;
const r1 = (v) => Math.round((v || 0) * 10) / 10;

const el = {
  status: $('statusPill'), start: $('startBtn'), free: $('freeBtn'), stop: $('stopBtn'),
  perm: $('permNotice'), permBtn: $('permBtn'), error: $('errorBox'),
  cue: $('cueLine'), cueSub: $('cueSub'),
  trace: $('trace'), hz: $('liveHz'),
  vals: {
    ax: $('vAx'), ay: $('vAy'), az: $('vAz'),
    angX: $('vAngX'), angY: $('vAngY'), angZ: $('vAngZ'),
    rot: $('vRot'), beta: $('vBeta'), gamma: $('vGamma'),
  },
  recList: $('recList'), recEmpty: $('recEmpty'), clearAll: $('clearAllBtn'),
  planLine: $('planLine'),
};

let cfg = loadCfg();
let sessions = loadSessions();
let live = null;          // последний пришедший кадр — для живых значений
let orientation = null;   // beta/gamma приходят отдельным событием, храним последнее
let sensing = false;
let events = 0;           // сколько кадров пришло с начала счёта — частота на глаз
let eventsFrom = 0;
let rec = null;           // текущая запись
let curLabel = LBL_PREP;
let timer = 0;
let rafId = 0;
let wakeLock = null;
let audio = null;         // запасные сигналы там, где вибрации нет
const trace = [];

/* ------------------------------------------------------------------ хранилище */

function loadCfg() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_CFG) || '{}');
    // Названия поз сменили язык. Сохранённые с прошлой версии перебили бы новые
    // умолчания, и половина записей разошлась бы с другой половиной подписями.
    if (saved.v !== DEFAULTS.v) return { ...DEFAULTS };
    return { ...DEFAULTS, ...saved };
  } catch { return { ...DEFAULTS }; }
}
function saveCfg() {
  try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch { /* переживём */ }
}
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]'); }
  catch { return []; }
}

/**
 * Записи тяжёлые: минута — это несколько сотен килобайт JSON. Квота кончится
 * раньше, чем терпение, поэтому при переполнении жертвуем самой старой записью
 * и пробуем снова: свежая запись всегда важнее прошлой.
 */
function saveSessions() {
  for (;;) {
    try { localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions)); return true; }
    catch {
      if (sessions.length <= 1) {
        showError('Не влезло в браузер: скачайте запись и удалите старые.');
        return false;
      }
      sessions.pop();
    }
  }
}

/* --------------------------------------------------------------------- мелочи */

function showError(text) {
  el.error.textContent = text;
  el.error.hidden = !text;
}
function setStatus(kind, text) {
  el.status.className = `pill pill--${kind}`;
  el.status.textContent = text;
}
function when(iso) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Три формы, без которых счёт по-русски врёт: 1 кадр, 2 кадра, 5 кадров. */
function plural(n, one, few, many) {
  const ten = Math.abs(n) % 100;
  const last = ten % 10;
  if (ten > 10 && ten < 20) return many;
  if (last > 1 && last < 5) return few;
  return last === 1 ? one : many;
}
const frames = (n) => `${n} ${plural(n, 'кадр', 'кадра', 'кадров')}`;

/** Сигнал команды. Где вибрации нет (Safari), остаётся короткий писк. */
function buzz(pattern) {
  if (navigator.vibrate?.(pattern)) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    let at = audio.currentTime;
    for (let i = 0; i < pattern.length; i++) {
      if (i % 2) { at += pattern[i] / 1000; continue; }
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + pattern[i] / 1000);
      at += pattern[i] / 1000;
    }
  } catch { /* нет ни мотора, ни звука — остаётся экран */ }
}

/* -------------------------------------------------------------------- датчики */

const needsPermission = typeof DeviceMotionEvent !== 'undefined'
  && typeof DeviceMotionEvent.requestPermission === 'function';

async function askPermission() {
  try {
    const motion = await DeviceMotionEvent.requestPermission();
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    if (motion !== 'granted') return showError('Доступ к датчикам не разрешён.');
    el.perm.hidden = true;
    startSensors();
  } catch (e) {
    showError(e.message || 'Не удалось спросить доступ к датчикам.');
  }
}

function startSensors() {
  if (sensing) return;
  sensing = true;
  events = 0;
  eventsFrom = performance.now();
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrientation);
  rafId = requestAnimationFrame(drawLive);
  // Событий может не быть вовсе: на настольном браузере датчика нет, а телефон
  // мог отдать разрешение и промолчать. Молчащая страница выглядит сломанной —
  // скажем прямо, чего не хватает.
  setTimeout(() => {
    if (!live) showError('Датчик ничего не шлёт: нужен телефон и https.');
  }, 1500);
}

function onOrientation(e) {
  if (e.beta == null && e.gamma == null) return;
  orientation = { beta: e.beta || 0, gamma: e.gamma || 0 };
}

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const a = e.acceleration || {};
  const r = e.rotationRate || {};
  events++;
  live = {
    ax: g.x || 0, ay: g.y || 0, az: g.z || 0,
    lx: a.x || 0, ly: a.y || 0, lz: a.z || 0,
    rx: r.alpha || 0, ry: r.beta || 0, rz: r.gamma || 0,
    beta: orientation?.beta || 0, gamma: orientation?.gamma || 0,
  };

  const now = performance.now();
  trace.push({ t: now, ax: live.ax, ay: live.ay, az: live.az });
  while (trace.length && now - trace[0].t > TRACE_SEC * 1000) trace.shift();

  if (!rec) return;
  rec.samples.push([
    Math.round(now - rec.t0),
    r3(live.ax), r3(live.ay), r3(live.az),
    r3(live.lx), r3(live.ly), r3(live.lz),
    r1(live.rx), r1(live.ry), r1(live.rz),
    r1(live.beta), r1(live.gamma),
    curLabel,
  ]);
  rec.lastAt = now;
}

/* -------------------------------------------------------------- живые значения */

/** Угол между осью прибора и силой тяжести: 0° — ось смотрит туда же, куда она. */
function axisAngle(v, ax, ay, az) {
  const m = Math.hypot(ax, ay, az);
  return m < 0.5 ? 0 : Math.acos(clamp(v / m, -1, 1)) * 180 / Math.PI;
}

function drawLive() {
  rafId = requestAnimationFrame(drawLive);
  if (!live) return;
  const { ax, ay, az } = live;
  el.vals.ax.textContent = ax.toFixed(2);
  el.vals.ay.textContent = ay.toFixed(2);
  el.vals.az.textContent = az.toFixed(2);
  el.vals.angX.textContent = `${axisAngle(ax, ax, ay, az).toFixed(0)}°`;
  el.vals.angY.textContent = `${axisAngle(ay, ax, ay, az).toFixed(0)}°`;
  el.vals.angZ.textContent = `${axisAngle(az, ax, ay, az).toFixed(0)}°`;
  el.vals.rot.textContent = Math.hypot(live.rx, live.ry, live.rz).toFixed(0);
  el.vals.beta.textContent = `${live.beta.toFixed(0)}°`;
  el.vals.gamma.textContent = `${live.gamma.toFixed(0)}°`;
  const sec = (performance.now() - eventsFrom) / 1000;
  el.hz.textContent = sec > 1 ? `${Math.round(events / sec)} Гц` : '—';
  drawTrace();
}

// График отвечает на единственный вопрос, который решается до всякой статистики:
// видно ли вообще разницу между позами. Три линии — три оси; шкала прибита к
// ±12 м/с², чтобы соседние записи сравнивались глазом.
const TRACE_SCALE = 12;
const TRACE_COLORS = ['#6ee7a8', '#f6c358', '#f2685f'];

function drawTrace() {
  const c = el.trace;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#262c3a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  if (trace.length < 2) return;

  const now = performance.now();
  const keys = ['ax', 'ay', 'az'];
  for (let k = 0; k < keys.length; k++) {
    ctx.strokeStyle = TRACE_COLORS[k];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < trace.length; i++) {
      const p = trace[i];
      const x = w - (now - p.t) / (TRACE_SEC * 1000) * w;
      const y = h / 2 - clamp(p[keys[k]] / TRACE_SCALE, -1, 1) * (h / 2 - 3);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/* --------------------------------------------------------------------- запись */

function planOf(c) {
  const steps = [];
  let at = c.prep * 1000;
  for (let i = 0; i < c.cycles; i++) {
    for (const label of [LBL_FIRST, LBL_FIRST + 1]) {
      steps.push({ at, label });
      at += (c.settle + c.hold) * 1000;
    }
  }
  return { steps, total: at };
}

function planText() {
  const { total } = planOf(cfg);
  const n = cfg.cycles * 2;
  return `${n} ${plural(n, 'поза', 'позы', 'поз')}, ${Math.round(total / 1000)} с вместе с подготовкой.`;
}

function openRec(mode) {
  return {
    id: Date.now(),
    started: new Date().toISOString(),
    mode,
    ua: navigator.userAgent,
    cfg: { ...cfg },
    fields: FIELDS,
    samples: [],
    cues: [],
    gaps: [],
    t0: performance.now(),
    lastAt: performance.now(),
    at: null,     // какая команда уже отдана: чтобы не давать её дважды
  };
}

async function begin(mode) {
  if (rec) return;
  if (!live) return showError('Датчик ещё ничего не прислал: записывать нечего.');
  showError('');
  rec = openRec(mode);
  if (mode === 'series') {
    rec.labels = ['подготовка', 'переход', cfg.nameA, cfg.nameB];
    Object.assign(rec, planOf(cfg));
  } else {
    rec.labels = ['подготовка', 'переход', cfg.freeName || 'без имени'];
    rec.steps = null;
    rec.total = 0;
  }
  curLabel = LBL_PREP;
  recordingUI(true);
  await keepAwake();
  timer = setInterval(tick, 100);
  tick();
}

/**
 * Ход записи: раздать команды по расписанию, подписать кадры и заметить, если
 * датчик замолчал. Молчит он ровно по одной причине — экран всё-таки погас, —
 * и такую запись надо не разбирать, а переписать.
 */
function tick() {
  if (!rec) return;
  const now = performance.now() - rec.t0;
  watchGap(now);

  // Настройки берутся из записи, а не из ползунков: их могли тронуть
  // посреди серии, а расписание уже роздано и подписи уже стоят.
  const prep = rec.cfg.prep * 1000;
  if (now < prep) {
    curLabel = LBL_PREP;
    const left = Math.ceil((prep - now) / 1000);
    cueText('Приготовьтесь', `${left} с, чтобы убрать телефон в карман`);
    // Последние три секунды отсчитываются вибрацией: в кармане экрана не видно,
    // а первая команда не должна застать врасплох.
    if (left <= 3 && rec.at !== `prep${left}`) { rec.at = `prep${left}`; buzz(BUZZ.tick); }
    return;
  }

  // Свободная запись — одна длинная поза без расписания: она нужна не для
  // порога, а для проверки, не сработает ли он там, где никто ничего не просил.
  if (rec.mode === 'free') {
    if (curLabel !== LBL_FIRST) {
      curLabel = LBL_FIRST;
      rec.cues.push([Math.round(now), LBL_FIRST]);
      buzz(BUZZ.A);
    }
    cueText(rec.labels[LBL_FIRST], `записано ${Math.round((now - prep) / 1000)} с · «Стоп», когда хватит`);
    return;
  }

  if (now >= rec.total) return finish();

  let i = -1;
  for (let k = 0; k < rec.steps.length; k++) if (now >= rec.steps[k].at) i = k;
  const step = rec.steps[i];
  if (rec.at !== i) {
    rec.at = i;
    curLabel = LBL_TRANS;
    rec.cues.push([Math.round(step.at), step.label]);
    buzz(step.label === LBL_FIRST ? BUZZ.A : BUZZ.B);
  }
  const inStep = now - step.at;
  const settle = rec.cfg.settle * 1000;
  if (inStep >= settle) curLabel = step.label;
  cueText(rec.labels[step.label], inStep < settle
    ? `${i + 1} из ${rec.steps.length} · меняйте позу`
    : `${i + 1} из ${rec.steps.length} · ${Math.ceil((settle + rec.cfg.hold * 1000 - inStep) / 1000)} с не двигаться`);
}

/** Датчик молчит дольше секунды — это дырка в данных, и молча её оставлять нельзя. */
function watchGap(now) {
  const silent = performance.now() - rec.lastAt;
  if (silent <= 1000) return;
  const from = Math.round(now - silent);
  const last = rec.gaps[rec.gaps.length - 1];
  if (last && last[1] >= from - 200) last[1] = Math.round(now);
  else rec.gaps.push([from, Math.round(now)]);
}

function cueText(main, sub) {
  el.cue.textContent = main;
  el.cueSub.textContent = sub;
}

function finish() {
  if (!rec) return;
  clearInterval(timer);
  timer = 0;
  buzz(BUZZ.end);
  const seconds = (performance.now() - rec.t0) / 1000;
  const { t0, lastAt, steps, at, total, ...rest } = rec;
  const done = {
    ...rest,
    seconds: Math.round(seconds * 10) / 10,
    hz: rec.samples.length > 1 ? Math.round(rec.samples.length / seconds) : 0,
  };
  rec = null;
  curLabel = LBL_PREP;
  recordingUI(false);
  releaseWake();
  cueText('Запись закончена', `${frames(done.samples.length)} за ${done.seconds.toFixed(0)} с`);

  sessions.unshift(done);
  while (sessions.length > SESSIONS_KEPT) sessions.pop();
  saveSessions();
  renderSessions();
}

function recordingUI(on) {
  el.start.hidden = on;
  el.free.hidden = on;
  el.stop.hidden = !on;
  document.body.classList.toggle('is-recording', on);
  setStatus(on ? 'music' : 'idle', on ? 'Записываю' : 'Жду');
  if (on) cueText('…', '');
}

/* ------------------------------------------------------------ экран не гаснет */

// Погасший экран уносит с собой и датчик: события просто перестают приходить,
// и запись обрывается на середине без единой ошибки. Лок держит его до конца.
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* политика браузера — переживём, дырку в данных заметим сами */ }
}
function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && rec) keepAwake();
});

/* --------------------------------------------------------------------- разбор */

// Признаки, среди которых ищется выключатель. Сырые оси — то, что отдаёт
// датчик; углы к силе тяжести — то же самое, но без опоры на то, насколько
// сильно телефон разогнан: наклон оси считается от вертикали, а не от нуля
// прибора. Скорость вращения не поза вовсе — она здесь, чтобы стало видно,
// сколько дрожи вносит сама нога.
const FEATS = [
  { key: 'ax', name: 'ax', unit: 'м/с²', of: (s) => s[1] },
  { key: 'ay', name: 'ay', unit: 'м/с²', of: (s) => s[2] },
  { key: 'az', name: 'az', unit: 'м/с²', of: (s) => s[3] },
  { key: 'angX', name: '∠x', unit: '°', of: (s) => axisAngle(s[1], s[1], s[2], s[3]) },
  { key: 'angY', name: '∠y', unit: '°', of: (s) => axisAngle(s[2], s[1], s[2], s[3]) },
  { key: 'angZ', name: '∠z', unit: '°', of: (s) => axisAngle(s[3], s[1], s[2], s[3]) },
  { key: 'beta', name: 'beta', unit: '°', of: (s) => s[10] },
  { key: 'gamma', name: 'gamma', unit: '°', of: (s) => s[11] },
  { key: 'rot', name: 'вращ.', unit: '°/с', of: (s) => Math.hypot(s[7], s[8], s[9]) },
];

function stats(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, sd: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let acc = 0;
  for (const v of values) acc += (v - mean) ** 2;
  return { n, mean, sd: Math.sqrt(acc / n) };
}

/** Скользящее среднее по числу кадров: тот же сглаживатель, что будет в гейте. */
function smooth(values, w) {
  if (w < 2) return values.slice();
  const out = new Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

/**
 * Порог между двумя позами. Не посередине, а взвешен разбросом: сторона,
 * которая дрожит сильнее, получает меньше места.
 */
function split(a, b) {
  const gap = Math.abs(a.mean - b.mean);
  return {
    thr: (a.mean * b.sd + b.mean * a.sd) / (a.sd + b.sd || 1),
    lowFirst: a.mean < b.mean,
    gap,
    sep: gap / (a.sd + b.sd || 1e-6),
  };
}

function analyse(session) {
  const used = session.labels
    .map((_, i) => i)
    .filter((i) => i >= LBL_FIRST && session.samples.some((s) => s[12] === i));
  const w = Math.max(1, Math.round(SMOOTH_SEC * (session.hz || 60)));

  const rows = [];
  for (const f of FEATS) {
    const raw = session.samples.map(f.of);
    const sm = smooth(raw, w);
    const per = {};
    for (const li of used) {
      const pick = (arr) => arr.filter((_, i) => session.samples[i][12] === li);
      per[li] = { raw: stats(pick(raw)), sm: stats(pick(sm)) };
    }
    const row = { f, per, sm, split: null, errors: null };
    if (used.length === 2) {
      const [a, b] = used;
      const sp = split(per[a].sm, per[b].sm);
      let wrong = 0;
      let total = 0;
      for (let i = 0; i < sm.length; i++) {
        const li = session.samples[i][12];
        if (li !== a && li !== b) continue;
        total++;
        if ((sm[i] < sp.thr) !== ((li === a) === sp.lowFirst)) wrong++;
      }
      row.split = sp;
      row.errors = { wrong, total };
    }
    rows.push(row);
  }
  // Лучший — тот, что ошибается реже; при равенстве тот, у кого разрыв шире
  // относительно дрожи.
  const ranked = rows.filter((r) => r.split).sort((x, y) =>
    x.errors.wrong / (x.errors.total || 1) - y.errors.wrong / (y.errors.total || 1)
    || y.split.sep - x.split.sep);
  return { used, w, rows, best: ranked[0] || null };
}

/**
 * Сколько занимает переход. Меряется по лучшему признаку: от команды до первого
 * мгновения, после которого сигнал остаётся по нужную сторону порога до конца
 * позы. Это и есть нижняя граница задержки будущего выключателя.
 */
function transitions(session, best, w, used) {
  if (!best || !session.cues.length) return [];
  const sm = smooth(session.samples.map(best.f.of), w);
  const { thr, lowFirst } = best.split;
  const out = [];
  for (let c = 0; c < session.cues.length; c++) {
    const [at, label] = session.cues[c];
    const until = c + 1 < session.cues.length ? session.cues[c + 1][0] : Infinity;
    const below = (label === used[0]) === lowFirst;
    let ok = -1;
    for (let i = 0; i < sm.length; i++) {
      const t = session.samples[i][0];
      if (t < at) continue;
      if (t >= until) break;
      if ((sm[i] < thr) === below) { if (ok < 0) ok = t; }
      else ok = -1;
    }
    if (ok >= 0) out.push((ok - at) / 1000);
  }
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function summary(session) {
  const a = analyse(session);
  const L = [];
  L.push(`${session.mode === 'free' ? 'Свободная' : 'Серия'} · ${when(session.started)}`
    + ` · ${session.seconds.toFixed(0)} с · ${frames(session.samples.length)} · ${session.hz} Гц`);
  L.push(session.mode !== 'free'
    ? `Позы: ${session.labels[LBL_FIRST]} / ${session.labels[LBL_FIRST + 1]}`
      + ` · ${session.cfg.cycles} ${plural(session.cfg.cycles, 'цикл', 'цикла', 'циклов')}`
      + ` × ${session.cfg.hold} с (переход ${session.cfg.settle} с)`
    : `Метка: ${session.labels[LBL_FIRST]}`);
  if (session.gaps.length) {
    const worst = Math.max(...session.gaps.map(([s, e]) => e - s)) / 1000;
    L.push(`Внимание: датчик молчал ${session.gaps.length} `
      + `${plural(session.gaps.length, 'раз', 'раза', 'раз')}, дольше всего ${worst.toFixed(1)} с:`);
    L.push('экран погас, и в этой записи не хватает кусков.');
  }
  L.push('');

  L.push('сигнал'.padEnd(10)
    + a.used.map((i) => session.labels[i].slice(0, 15).padStart(16)).join('')
    + (a.used.length === 2 ? 'разрыв'.padStart(8) : ''));
  for (const row of a.rows) {
    let line = `${row.f.name} ${row.f.unit}`.padEnd(10);
    for (const li of a.used) {
      const s = row.per[li].raw;
      line += `${s.mean.toFixed(2)} ± ${s.sd.toFixed(2)}`.padStart(16);
    }
    if (row.split) line += row.split.sep.toFixed(1).padStart(8);
    L.push(line);
  }
  L.push('');
  L.push('Среднее ± разброс сырого сигнала.');
  if (a.used.length === 2) {
    L.push('«Разрыв» — расстояние между средними, делённое на оба');
    L.push('разброса, по сглаженному сигналу.');
  }

  if (a.best) {
    const { f, split: sp, errors, sm } = a.best;
    const low = session.labels[a.used[sp.lowFirst ? 0 : 1]];
    const band = sp.gap * 0.2;
    let inBand = 0;
    for (let i = 0; i < sm.length; i++) {
      if (session.samples[i][12] < LBL_FIRST) continue;
      if (Math.abs(sm[i] - sp.thr) < band / 2) inBand++;
    }
    const tr = transitions(session, a.best, a.w, a.used);
    L.push('');
    L.push(`Лучший сигнал: ${f.name}, сглаженный ${SMOOTH_SEC} с (${frames(a.w)})`);
    L.push(`  порог       ${sp.thr.toFixed(2)} ${f.unit} · «${low}» ниже порога`);
    L.push(`  гистерезис  ±${(band / 2).toFixed(2)} ${f.unit} · ${frames(inBand)} внутри полосы`);
    L.push(`  ошибки      ${errors.wrong} из ${errors.total}`
      + ` (${(errors.wrong / (errors.total || 1) * 100).toFixed(1)} %)`);
    if (tr.length) L.push(`  переход     ${median(tr).toFixed(1)} с медиана, ${Math.max(...tr).toFixed(1)} с худший`);
  }
  L.push('');
  L.push(session.ua);
  return L.join('\n');
}

/* ------------------------------------------------------------ список записей */

function renderSessions() {
  el.recEmpty.hidden = sessions.length > 0;
  el.recList.innerHTML = '';
  for (const s of sessions) {
    const box = document.createElement('div');
    box.className = 'rec';
    box.innerHTML = `
      <div class="rec-head">
        <b>${esc(s.mode === 'free' ? 'Свободная' : 'Серия')} · ${esc(when(s.started))}</b>
        <span>${frames(s.samples.length)} · ${s.seconds.toFixed(0)} с</span>
      </div>
      <pre class="rec-text"></pre>
      <div class="rec-actions">
        <button class="btn btn--ghost btn--sm" data-act="copy">Скопировать сводку</button>
        <button class="btn btn--ghost btn--sm" data-act="json">Скачать JSON</button>
        <button class="btn btn--ghost btn--sm" data-act="drop">Удалить</button>
      </div>`;
    const text = summary(s);
    box.querySelector('.rec-text').textContent = text;
    box.querySelector('[data-act="copy"]').onclick = () => copy(text, box);
    box.querySelector('[data-act="json"]').onclick = () => download(s);
    box.querySelector('[data-act="drop"]').onclick = () => {
      sessions = sessions.filter((x) => x.id !== s.id);
      saveSessions();
      renderSessions();
    };
    el.recList.append(box);
  }
}

async function copy(text, box) {
  const btn = box.querySelector('[data-act="copy"]');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Скопировано';
  } catch {
    // Буфер закрыт политикой браузера — выделяем текст, дальше руками.
    const range = document.createRange();
    range.selectNodeContents(box.querySelector('.rec-text'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    btn.textContent = 'Выделено, копируйте';
  }
  setTimeout(() => { btn.textContent = 'Скопировать сводку'; }, 2000);
}

function download(s) {
  const blob = new Blob([JSON.stringify(s)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `motion-${new Date(s.started).toISOString().slice(0, 16).replace(/[:T-]/g, '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/* ------------------------------------------------------------------ настройки */

function bindRange(id, key, fmt) {
  const input = $(id);
  const out = $(`${id}Val`);
  input.value = cfg[key];
  out.textContent = fmt(cfg[key]);
  input.addEventListener('input', () => {
    cfg[key] = Number(input.value);
    out.textContent = fmt(cfg[key]);
    saveCfg();
    el.planLine.textContent = planText();
  });
}
function bindText(id, key) {
  const input = $(id);
  input.value = cfg[key];
  input.addEventListener('input', () => {
    cfg[key] = input.value.trim() || DEFAULTS[key];
    saveCfg();
  });
}

/* --------------------------------------------------------------------- запуск */

bindText('setNameA', 'nameA');
bindText('setNameB', 'nameB');
bindText('setFreeName', 'freeName');
bindRange('setPrep', 'prep', (v) => `${v} с`);
bindRange('setSettle', 'settle', (v) => `${v.toFixed(1)} с`);
bindRange('setHold', 'hold', (v) => `${v} с`);
bindRange('setCycles', 'cycles', (v) => String(v));
el.planLine.textContent = planText();

el.start.onclick = () => begin('series');
el.free.onclick = () => begin('free');
el.stop.onclick = () => finish();
el.permBtn.onclick = askPermission;
el.clearAll.onclick = () => {
  if (!sessions.length) return;
  sessions = [];
  saveSessions();
  renderSessions();
};

renderSessions();
setStatus('idle', 'Жду');
if (needsPermission) el.perm.hidden = false;
else startSensors();
