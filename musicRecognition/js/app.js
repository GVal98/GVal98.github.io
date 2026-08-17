import { AudioCapture } from './audio.js';
import { MusicDetector, MusicGate } from './detector.js';
import { recognize, trackKey, artworkUrl, links, AudDError } from './audd.js';

const DEFAULTS = {
  token: '',         // пользователь вводит свой; хранится только в localStorage
  threshold: 0.35,  // середина коридора между тишиной и музыкой по замерам
  minMusic: 10,      // сколько музыки должно прозвучать, чтобы поверить (не меньше clip + LEAD_IN)
  clip: 12,          // длина фрагмента для AudD
  silence: 5,        // тишина, после которой трек считается законченным
  attack: 2.5,       // подтверждение начала музыки
};

// Первые такты трека — худший материал для отпечатка: интро разрежено (мало
// спектральных пиков → мало хешей), часто это одинокий инструмент или нарастание
// из тишины, да и плеер успевает добавить своё плавное включение. Поэтому первый
// фрагмент берём не от самого начала, а отступив немного вглубь трека.
const LEAD_IN = 3;

// Если совпадений нет — пробуем ещё несколько раз: начало могло попасть
// на интро или на разговор диджея.
const RETRY_DELAYS = [12, 22, 40];
const REQUEST_TIMEOUT = 30;
const BUFFER_SECONDS = 30;
const HISTORY_LIMIT = 100;
const LS_SETTINGS = 'musicRecognition.settings';
const LS_HISTORY = 'musicRecognition.history';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const el = {
  status: $('statusPill'), counter: $('requestCounter'),
  toggle: $('toggleBtn'),
  error: $('errorBox'), monitor: $('monitor'), phase: $('phaseLabel'),
  spectrum: $('spectrum'), scoreFill: $('scoreFill'), scoreMark: $('scoreMark'),
  scoreValue: $('scoreValue'), readout: $('readout'),
  factors: { level: $('fLevel'), tone: $('fTone'), bass: $('fBass'), flow: $('fFlow') },
  now: $('nowCard'), nowArt: $('nowArt'), nowArtEmpty: $('nowArtEmpty'), nowKicker: $('nowKicker'),
  nowTitle: $('nowTitle'), nowArtist: $('nowArtist'), nowMeta: $('nowMeta'), nowLinks: $('nowLinks'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistory: $('clearHistoryBtn'),
  log: $('logList'), tokenNotice: $('tokenNotice'),
};

let settings = loadSettings();
let history = loadHistory();
let capture = null;
let detector = null;
let gate = null;
let session = null;      // текущий непрерывный отрезок музыки
let current = null;      // запись, показанная в «Сейчас играет»
let features = null;
let inFlight = false;
let requests = 0;
let running = false;
let wakeLock = null;
let rafId = 0;
const spectrumBars = new Float32Array(72);

/* ------------------------------------------------------------------ хранилище */

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch { /* приватный режим */ }
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch { return []; }
}
function saveHistory() {
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(history.slice(0, HISTORY_LIMIT))); }
  catch { /* приватный режим */ }
}

/* ------------------------------------------------------------------- утилиты */

function clock(ms) {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function dur(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// Услышать, что именно ушло в AudD, — единственный способ отличить «плохо
// слышно» от «ушёл не тот кусок трека». Держим ссылки на последние клипы;
// больше нельзя — каждый висит в памяти вкладки, пока URL не отозван.
const CLIPS_KEPT = 5;
const clipLinks = [];

function clipLink(blob) {
  const a = document.createElement('a');
  a.className = 'log-clip';
  a.href = URL.createObjectURL(blob);
  a.download = `clip-${clock(Date.now()).replace(':', '')}.wav`;
  a.textContent = 'скачать';
  clipLinks.push(a);
  while (clipLinks.length > CLIPS_KEPT) {
    const old = clipLinks.shift();
    URL.revokeObjectURL(old.href);
    old.remove(); // ссылка уже мертва, оставлять её в журнале нечестно
  }
  return a;
}

function log(kind, text, clip) {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.innerHTML = `<b>${clock(Date.now())}</b><span>${esc(text)}</span>`;
  if (clip) li.querySelector('span').append(clipLink(clip));
  el.log.prepend(li);
  while (el.log.children.length > 200) el.log.lastChild.remove();
}
function showError(text) {
  el.error.textContent = text;
  el.error.hidden = !text;
}

/* --------------------------------------------------------------- статус в UI */

function setStatus(kind, text) {
  el.status.className = `pill pill--${kind}`;
  el.status.textContent = text;
}
function refreshStatus() {
  if (!running) return setStatus('idle', 'Остановлено');
  if (inFlight) return setStatus('busy', 'Распознаю…');
  if (gate?.playing) return setStatus('music', 'Играет музыка');
  setStatus('listen', 'Слушаю');
}

/* ------------------------------------------------------------- запуск / стоп */

/** Без ключа слушать бессмысленно — ведём к полю, а не молча падаем на первом запросе. */
function promptForToken() {
  showError('Сначала вставьте ключ AudD в настройках.');
  document.querySelector('.settings').open = true;
  const input = $('setToken');
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input.focus();
}

function updateTokenNotice() {
  el.tokenNotice.hidden = Boolean(settings.token);
}

async function start() {
  if (!settings.token) return promptForToken();
  showError('');
  el.toggle.disabled = true;
  // Пока браузер показывает запрос доступа, промис висит без единого признака
  // жизни в интерфейсе — говорим, чего ждём.
  setStatus('busy', 'Жду доступ к микрофону…');
  capture = new AudioCapture({ bufferSeconds: BUFFER_SECONDS, onFrame });
  capture.onTrackEnded = () => { log('warn', 'микрофон отключён'); stop(); };

  try {
    await capture.start();
  } catch (e) {
    // getUserMedia мог уже отдать поток, а упасть — AudioContext или ворклет.
    // Без остановки индикатор записи горит до закрытия вкладки, а следующее
    // нажатие «Начать» открывает второй поток поверх первого.
    try { await capture.stop(); } catch { /* останавливать нечего */ }
    capture = null;
    el.toggle.disabled = false;
    showError(
      e.name === 'NotAllowedError' ? 'Доступ к микрофону не разрешён. Разрешите его в адресной строке и попробуйте снова.'
      : e.name === 'NotFoundError' ? 'Не найден микрофон.'
      : e.message || 'Не удалось получить звук с микрофона.'
    );
    setStatus('error', 'Ошибка');
    return;
  }

  detector = new MusicDetector(capture.sampleRate, capture.analyser.fftSize);
  gate = new MusicGate({ threshold: settings.threshold, attackSec: settings.attack, releaseSec: settings.silence });
  session = null;
  running = true;

  document.body.classList.add('is-running');
  el.monitor.hidden = false;
  el.toggle.disabled = false;
  el.toggle.textContent = 'Остановить';
  el.toggle.classList.replace('btn--primary', 'btn--stop');
  refreshStatus();
  log('ok', `слушаю микрофон, ${capture.sampleRate} Гц`);

  requestWakeLock();
  rafId = requestAnimationFrame(render);
}

async function stop() {
  if (!running && !capture) return;
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (session) endSession();
  if (capture) { await capture.stop(); capture = null; }
  detector = null;
  gate = null;
  features = null;

  document.body.classList.remove('is-running', 'is-music');
  el.toggle.textContent = 'Начать слушать';
  el.toggle.classList.replace('btn--stop', 'btn--primary');
  el.toggle.disabled = false;
  el.phase.textContent = 'остановлено';
  refreshStatus();
  releaseWakeLock();
}

/* --------------------------------------------------- кадр анализа и состояния */

function onFrame({ analyser, samples }) {
  // Ворклет начинает слать звук ещё до того, как start() соберёт детектор.
  if (!detector || !gate) return;
  features = detector.step(analyser, samples / capture.sampleRate, gate.playing);
  const now = capture.audioTime;

  const event = gate.step(features.score, now);
  if (event === 'start') startSession();
  else if (event === 'stop') endSession();

  if (session && !inFlight && now >= session.nextCheckAt) {
    runRecognition();
  }
}

function startSession() {
  session = {
    startedAt: gate.startedAt,
    startedAtWall: Date.now(),
    attempts: 0,
    // Ждём не меньше, чем нужно, чтобы фрагмент целиком набрался музыкой уже
    // после интро. Иначе в AudD уходит начало трека вперемешку с комнатой —
    // ровно тот случай, когда первый запрос молчит, а повтор находит.
    nextCheckAt: gate.startedAt + Math.max(settings.minMusic, settings.clip + LEAD_IN),
    entry: null,
  };
  document.body.classList.add('is-music');
  refreshStatus();
  log('', `музыка началась, отправлю через ${Math.round(session.nextCheckAt - capture.audioTime)} с`);
}

function endSession() {
  if (session?.entry) closeEntry(session.entry);
  session = null;
  document.body.classList.remove('is-music');
  refreshStatus();
  renderNow();
  log('', 'музыка смолкла');
}

function closeEntry(entry) {
  if (!entry.endWall) {
    entry.endWall = Date.now();
    saveHistory();
    renderHistory();
  }
}

/* ------------------------------------------------------------- распознавание */

async function runRecognition() {
  if (inFlight || !capture || !session) return;

  const s = session;
  // Тишина до начала музыки в отпечатке — мёртвый груз: она отъедает секунды
  // у единственного фрагмента, который мы отправляем. Берём не больше, чем
  // музыки реально прозвучало.
  const seconds = Math.min(settings.clip, capture.audioTime - s.startedAt);

  const clip = capture.makeClip(seconds);
  if (!clip) return;

  inFlight = true;
  refreshStatus();
  log('', `отправляю ${clip.seconds.toFixed(1)} с (${Math.round(clip.blob.size / 1024)} КБ)`, clip.blob);

  try {
    // Без таймаута повисший fetch держит inFlight до собственного таймаута
    // браузера — это минуты, за которые трек успевает кончиться, а приложение
    // всё это время не делает ни одной проверки.
    const result = await recognize(clip.blob, settings.token, {
      signal: AbortSignal.timeout?.(REQUEST_TIMEOUT * 1000),
    });
    requests++;
    el.counter.textContent = `${requests} ${plural(requests, 'запрос', 'запроса', 'запросов')}`;
    if (result) handleMatch(result, s);
    else handleNoMatch(s);
  } catch (e) {
    log('err',
      e instanceof AudDError ? `AudD: ${e.message}`
      : e.name === 'TimeoutError' ? `AudD не ответил за ${REQUEST_TIMEOUT} с`
      : `Сеть: ${e.message}`);
    showError(e instanceof AudDError && (e.code === 900 || e.code === 901) ? e.message : '');
    if (s === session) s.nextCheckAt = capture.audioTime + 30;
  } finally {
    inFlight = false;
    refreshStatus();
  }
}

function handleMatch(result, s) {
  const key = trackKey(result);

  if (s?.entry && s.entry.key === key) {
    log('ok', `всё ещё «${result.title}»`);
  } else {
    if (s?.entry) closeEntry(s.entry);
    const entry = makeEntry(result, key, s);
    if (s) s.entry = entry;
    current = entry;
    history.unshift(entry);
    history = history.slice(0, HISTORY_LIMIT);
    saveHistory();
    renderHistory();
    renderNow(true);
    log('ok', `${result.artist} — ${result.title}`);
  }

  // Трек определён — до следующей паузы больше не спрашиваем.
  if (s && s === session) {
    s.attempts = 0;
    s.nextCheckAt = Infinity;
  }
}

function handleNoMatch(s) {
  if (s !== session) return log('warn', 'совпадений нет');
  const delay = RETRY_DELAYS[s.attempts];
  s.attempts++;
  if (delay == null) {
    s.nextCheckAt = Infinity;
    log('warn', 'совпадений нет, больше не пробую до следующего трека');
  } else {
    s.nextCheckAt = capture.audioTime + delay;
    log('warn', `совпадений нет, повтор через ${delay} с`);
  }
}

// Сессию берём параметром, а не из глобальной: пока запрос был в полёте,
// музыка могла смолкнуть и endSession успел её занулить — тогда начало трека
// в истории оказалось бы равно моменту распознавания, и длительность соврала бы.
function makeEntry(result, key, s) {
  return {
    id: `${Date.now()}-${Math.round(performance.now())}`,
    key,
    title: result.title || 'Без названия',
    artist: result.artist || '',
    album: result.album || '',
    label: result.label || '',
    releaseDate: result.release_date || '',
    art: artworkUrl(result, 300),
    links: links(result),
    startWall: s?.startedAtWall ?? Date.now(),
    recognizedWall: Date.now(),
    endWall: null,
  };
}

function plural(n, one, few, many) {
  const m = n % 100;
  if (m >= 11 && m <= 14) return many;
  const k = n % 10;
  return k === 1 ? one : k >= 2 && k <= 4 ? few : many;
}

/* ------------------------------------------------------------------- отрисовка */

function renderNow(fresh = false) {
  if (!current) { el.now.hidden = true; return; }
  el.now.hidden = false;

  const live = session?.entry?.id === current.id;
  el.nowKicker.textContent = live ? 'Сейчас играет' : 'Последний трек';

  if (current.art) {
    el.nowArt.src = current.art;
    el.nowArt.hidden = false;
    el.nowArtEmpty.hidden = true;
  } else {
    el.nowArt.hidden = true;
    el.nowArtEmpty.hidden = false;
  }

  el.nowTitle.textContent = current.title;
  el.nowArtist.textContent = current.artist;

  const bits = [];
  if (current.album && current.album !== current.title) bits.push(current.album);
  if (current.releaseDate) bits.push(current.releaseDate.slice(0, 4));
  if (current.label) bits.push(current.label);
  el.nowMeta.dataset.base = bits.join(' · ');
  updateNowTimer();

  el.nowLinks.innerHTML = (current.links || [])
    .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>`)
    .join('');

  if (fresh) {
    el.now.classList.remove('is-fresh');
    void el.now.offsetWidth; // перезапуск анимации
    el.now.classList.add('is-fresh');
  }
}

function updateNowTimer() {
  if (!current || el.now.hidden) return;
  const live = session?.entry?.id === current.id;
  const end = live ? Date.now() : (current.endWall ?? current.recognizedWall);
  const played = (end - current.startWall) / 1000;
  const tail = live ? `играет ${dur(played)}` : `${clock(current.startWall)} · ${dur(played)}`;
  const base = el.nowMeta.dataset.base;
  el.nowMeta.textContent = base ? `${base} · ${tail}` : tail;
}

function renderHistory() {
  el.historyEmpty.hidden = history.length > 0;
  el.historyList.innerHTML = history.map((h) => {
    const played = ((h.endWall ?? Date.now()) - h.startWall) / 1000;
    const link = h.links?.[0];
    const time = link
      ? `<a href="${esc(link.url)}" target="_blank" rel="noopener">${clock(h.startWall)}</a>`
      : clock(h.startWall);
    const art = h.art
      ? `<img src="${esc(h.art)}" alt="" loading="lazy">`
      : '<span class="h-art-empty">♪</span>';
    return `<li>${art}
      <div class="h-body">
        <div class="h-title">${esc(h.title)}</div>
        <div class="h-artist">${esc(h.artist)}</div>
      </div>
      <div class="h-time">${time}<br>${dur(played)}</div>
    </li>`;
  }).join('');
}

function render() {
  if (!running) { rafId = 0; return; }
  rafId = requestAnimationFrame(render);
  if (document.hidden || !features || !detector) return;

  const pct = Math.round(features.score * 100);
  el.scoreFill.style.width = `${pct}%`;
  el.scoreValue.textContent = `${pct}%`;
  el.scoreMark.style.left = `${settings.threshold * 100}%`;

  for (const [name, node] of Object.entries(el.factors)) {
    node.style.width = `${features[name] * 100}%`;
    node.style.background = features[name] > 0.6 ? 'var(--accent)' : 'var(--muted)';
  }

  el.phase.textContent = features.warmingUp
    ? 'меряю фон комнаты'
    : session
      ? (session.entry ? 'трек определён' : 'музыка играет, собираю фрагмент')
      : 'жду музыку';

  el.readout.textContent =
    `уровень ${features.rmsDb.toFixed(0)} дБ · фон ${features.floorDb.toFixed(0)} дБ · ` +
    `превышение ${features.snr.toFixed(0)} дБ · плоскостность ${features.flatness.toFixed(3)} · ` +
    `бас ${(features.bassRatio * 100).toFixed(0)}%` +
    (session && Number.isFinite(session.nextCheckAt)
      ? ` · след. проверка через ${Math.max(0, Math.round(session.nextCheckAt - capture.audioTime))} с`
      : '');

  drawSpectrum();
  updateNowTimer();
}

function drawSpectrum() {
  const canvas = el.spectrum;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  detector.spectrum(spectrumBars);
  const n = spectrumBars.length;
  const gap = 2;
  const bw = (w - gap * (n - 1)) / n;
  const hot = features && features.score >= settings.threshold;

  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, spectrumBars[i] * (h - 6));
    ctx.fillStyle = hot
      ? `hsl(${152 - i * 0.5} 70% ${34 + spectrumBars[i] * 26}%)`
      : `rgba(141, 151, 171, ${0.25 + spectrumBars[i] * 0.4})`;
    ctx.fillRect(i * (bw + gap), h - bh - 3, bw, bh);
  }
}

/* ------------------------------------------------------------- энергосбережение */

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // Уходя в фон, браузер отпускает лок сам. Без этой подписки переменная
    // осталась бы занята отпущенным сентинелом, проверка на пустоту больше
    // никогда бы не прошла — и после первого же сворачивания экран гас бы
    // по таймауту, а вместе с ним на телефоне умирает и захват звука.
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* батарея, политика браузера — не критично */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && running) {
    requestWakeLock();
    // rAF в скрытой вкладке не отменяется, а откладывается: отложенный колбэк
    // сработает при возврате. Планировать ещё один, не сняв прежний, — значит
    // завести второй параллельный цикл отрисовки, и так на каждое сворачивание.
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
  }
});

/* --------------------------------------------------------------- настройки UI */

function bindRange(id, key, format, onApply) {
  const input = $(id);
  const out = $(`${id}Val`);
  const sync = () => { out.textContent = format(settings[key]); };
  input.value = settings[key];
  sync();
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    sync();
    saveSettings();
    onApply?.();
  });
}

function applyGate() {
  gate?.configure({ threshold: settings.threshold, releaseSec: settings.silence });
}

function initSettings() {
  const token = $('setToken');
  token.value = settings.token;
  // input, а не change: иначе на телефоне ключ не сохранится, пока поле не потеряет фокус.
  token.addEventListener('input', () => {
    settings.token = token.value.trim();
    saveSettings();
    updateTokenNotice();
    if (settings.token) showError('');
  });

  bindRange('setThreshold', 'threshold', (v) => `${Math.round(v * 100)}%`, applyGate);
  bindRange('setMinMusic', 'minMusic', (v) => `${v} с`);
  bindRange('setClip', 'clip', (v) => `${v} с`);
  bindRange('setSilence', 'silence', (v) => `${v} с`, applyGate);

  $('resetSettingsBtn').addEventListener('click', () => {
    settings = { ...DEFAULTS, token: settings.token }; // ключ сбрасывать не за что
    saveSettings();
    location.reload();
  });
}

/* --------------------------------------------------------------------- запуск */

el.toggle.addEventListener('click', () => (running ? stop() : start()));
el.clearHistory.addEventListener('click', () => {
  history = [];
  current = null;
  saveHistory();
  renderHistory();
  renderNow();
});
window.addEventListener('pagehide', () => { if (running) stop(); });

initSettings();
renderHistory();
updateTokenNotice();
// Первый заход: поле ключа спрятано в свёрнутом блоке, разворачиваем сразу.
if (!settings.token) document.querySelector('.settings').open = true;
if (!navigator.mediaDevices?.getUserMedia) {
  showError('Браузер не умеет захватывать звук. Нужен современный Chrome, Firefox, Edge или Safari по HTTPS.');
  el.toggle.disabled = true;
}
