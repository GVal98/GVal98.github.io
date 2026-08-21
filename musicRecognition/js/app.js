import { AudioCapture } from './audio.js';
import { MusicDetector, MusicGate } from './detector.js';
import { recognize, trackKey, artworkUrl, links, AudDError } from './audd.js';
import * as morse from './morse.js';
import { ARTISTS } from './artists.js';

// Приложение рассчитано на короткий трек-вопрос: 10–20 секунд музыки, потом
// пауза на ответ, потом следующий вопрос. Отсюда все значения ниже — фрагмент
// обязан целиком уместиться внутри самого короткого трека, иначе в отпечаток
// попадёт пауза и начало следующего.
const DEFAULTS = {
  v: 3,              // версия набора настроек, см. loadSettings
  token: '',         // пользователь вводит свой; хранится только в localStorage
  threshold: 0.35,   // середина коридора между тишиной и музыкой по замерам
  // Отправка приходит на (clip + LEAD_IN) секунде. На треке в 10 секунд это
  // 9-я — то есть секунда запаса на то, что начало музыки замечено не мгновенно:
  // оценка сглажена, и момент пересечения порога отстаёт от реального начала
  // на треть секунды с небольшим. Длиннее фрагмент брать нечем.
  clip: 8,
  // Строго короче паузы между вопросами. Условие размыкания гейта —
  // `>= releaseSec`, поэтому равенство проигрывает гонку следующему треку.
  silence: 2,
  attack: 2.5,       // подтверждение начала музыки
  // Как часто переспрашивать, пока музыка не прерывалась. Нужно ровно для
  // одного случая, но в квизе он самый обычный: в паузе между вопросами играет
  // фоновая музыка, оценка не проваливается ни разу, гейт не размыкается — и
  // весь раунд из шести вопросов выглядит одним бесконечным треком. Ни конца
  // сессии, ни разрыва внутри неё не наступает, и заметить смену вопроса
  // больше нечем: остаются только часы.
  recheck: 20,
  // Морзянка имени исполнителя. Длина точки в миллисекундах, 0 — не вибрировать;
  // всё остальное кратно ей, так что этот один ползунок меняет общую скорость.
  // Мотор телефона раскручивается и тормозит десятки миллисекунд: 120 мс — низ
  // того, что ещё различается на ощупь.
  morse: 120,
  morseLetters: 5,     // сколько букв имени стучим
  // Упрощённая азбука: шесть букв без собственного звука уходят из неё, пары EE
  // и EA читаются как I, TH — как T, PH — как F, а сдвоенные схлопываются
  // в одну. Считается всё это по каждому слову имени отдельно: на стыке двух
  // слов правила чтения врут. Пять букв заменяются созвучными (Q → K, Y → I,
  // J → G, Z → S, V → W), шестая, C, читается по соседу, как в английском:
  // SITI, но KOLDPLAI. Включена, потому что на ощупь считают знаки, а не буквы:
  // все шесть кодов четырёхзначные и отличаются друг от друга одним знаком
  // из четырёх, а сдвоенную букву от одиночной отличает только длина паузы.
  morseSimple: true,
  morseDash: 3,        // тире, в точках — как в самой азбуке
  // Паузы против канонических 1 и 3 растянуты втрое и почти втрое. Причина одна
  // и та же: мотор к концу сигнала ещё дотряхивает корпус, и на канонической
  // паузе точка с тире смазываются в один сигнал, а буквы — друг в друга.
  // Подбиралось на ощупь, поэтому и вынесено в настройки: у каждого мотора
  // и каждого кармана эта граница своя.
  morseGapSym: 3,      // между точками и тире внутри буквы
  morseGapLetter: 8,   // между буквами; обязан быть заметно больше предыдущего
  morseGapRepeat: 16,  // на стыке: после метки и между проходами
  // Метка начала: перед именем стучится всегда одна и та же буква, O. Ответ
  // приходит без предупреждения, и пока рука сообразила, что телефон вибрирует,
  // первая буква имени уже прошла; метка забирает этот момент себе — теряется
  // она, а не начало ответа. Буквой имени она не считается и в отмеренную
  // пятёрку не входит. Включена, потому что делает работу второго прохода —
  // бережёт начало — втрое дешевле его: 3.7 секунды против 11.
  morseMark: true,
  // Повтор удваивает и без того немалое время: среднее имя канона — 9 секунд
  // одним проходом и 20 двумя, дольше самого трека-вопроса. Начало теперь
  // бережёт метка, и по умолчанию повтор выключен. Остаётся он для тех, кому
  // нужен второй шанс на всё имя, а не только на его начало.
  morseTwice: false,
  // Скрытый экран: страницы не видно, приложение слушает и стучит дальше.
  blankWhite: false,  // чёрный или белый — на сам звук это не влияет никак
  blankHold: 1.5,     // сколько держать палец, чтобы вернуть интерфейс
};

// Первые такты — худший материал для отпечатка: интро разрежено (мало
// спектральных пиков → мало хешей), да и плеер успевает добавить своё плавное
// включение. Раньше отступ был 3 секунды, но на десятисекундном треке это треть
// всего, что у нас есть. Секунда снимает щелчок включения и на этом всё.
const LEAD_IN = 1;

// Провал оценки, после которого следующий кусок музыки считается новым треком,
// даже если гейт так и не разомкнулся. Смысл имеет ровно один диапазон —
// от этого числа до настройки «Пауза = трек закончился»: провалы длиннее её
// разбирает сам гейт, обычной сменой сессии. Отсюда и значение: чем оно ниже,
// тем шире полоса, которую гейт пропускает, а мы ловим. Ниже секунды опускать
// нечего — оценка сглажена с постоянной около трети секунды, и на 1 с приходится
// три её постоянные: тихий такт столько не держится, конец трека держится.
// Ошибка в эту сторону дешёвая: лишний запрос, ответ на который совпадёт с
// прошлым по ключу, и второй записи в истории не появится.
const SEGMENT_DIP_SEC = 1;

// Промах — ещё не приговор треку. Первый фрагмент это интро: пиков в спектре
// мало, отпечаток жидкий, и «совпадений нет» приходит чаще всего именно на
// него. Дальше в треке материал лучше, так что пара повторов окупается.
// Раньше повторов не было вовсе, и после единственного промаха приложение
// замолкало до конца раунда — если гейт при этом не размыкался, то навсегда.
const MISS_RETRY_SEC = 12;
const MISS_RETRIES = 2;

// Сорвавшийся запрос — другое дело: ответа не было вообще, и повторить его
// стоит сразу, пока трек ещё звучит.
const ERROR_RETRY_SEC = 3;
const ERROR_RETRIES = 1;
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
  factors: { level: $('fLevel'), tone: $('fTone'), bass: $('fBass'), flow: $('fFlow'), dyn: $('fDyn') },
  now: $('nowCard'), nowArt: $('nowArt'), nowArtEmpty: $('nowArtEmpty'), nowKicker: $('nowKicker'),
  nowTitle: $('nowTitle'), nowArtist: $('nowArtist'), nowMeta: $('nowMeta'), nowLinks: $('nowLinks'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistory: $('clearHistoryBtn'),
  log: $('logList'), tokenNotice: $('tokenNotice'),
  blankBtn: $('blankBtn'), blank: $('blank'), blankState: $('blankState'), blankBar: $('blankBar'),
};

// Цвет системной строки браузера. На скрытом экране она — последнее, что от
// интерфейса остаётся, если полноэкранного режима в этом браузере нет.
const themeMeta = document.querySelector('meta[name="theme-color"]');
const THEME_COLOR = themeMeta?.content || '#0b0d12';

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
let wasWarmingUp = true;  // чтобы сообщить о замере фона ровно один раз
// Пока мотор стучит морзянку, микрофон слушает мотор, а не комнату (см. «глухота»).
let deafUntil = 0;       // до какого момента аудиочасов не слушаем
let deafSec = 0;         // сколько всего не слушали — на это отстают часы приложения
let wakeLock = null;
let rafId = 0;
let blank = false;       // экран скрыт, приложение работает
const spectrumBars = new Float32Array(72);

/* ------------------------------------------------------------------ хранилище */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    // Длина фрагмента и порог паузы сменили смысл — они подобраны под короткий
    // трек-вопрос. Сохранённые с прошлой версии значения перебили бы новые
    // умолчания, и на своём же устройстве было бы не понять, почему ничего не
    // изменилось. Ключ при этом терять не за что.
    if (saved.v !== DEFAULTS.v) return { ...DEFAULTS, token: saved.token || '' };
    return { ...DEFAULTS, ...saved };
  } catch { return { ...DEFAULTS }; }
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
  return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
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
  a.textContent = 'descargar';
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
  if (!running) return setStatus('idle', 'Detenido');
  if (inFlight) return setStatus('busy', 'Reconociendo…');
  if (gate?.playing) return setStatus('music', 'Suena música');
  setStatus('listen', 'Escuchando');
}

/* ------------------------------------------------------------- запуск / стоп */

/** Без ключа слушать бессмысленно — ведём к полю, а не молча падаем на первом запросе. */
function promptForToken() {
  showError('Primero pegue la clave de AudD en los ajustes.');
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
  el.blankBtn.disabled = true;
  // Пока браузер показывает запрос доступа, промис висит без единого признака
  // жизни в интерфейсе — говорим, чего ждём.
  setStatus('busy', 'Esperando acceso al micrófono…');
  capture = new AudioCapture({ bufferSeconds: BUFFER_SECONDS, onFrame });
  capture.onTrackEnded = () => { log('warn', 'micrófono desconectado'); stop(); };

  try {
    await capture.start();
  } catch (e) {
    // getUserMedia мог уже отдать поток, а упасть — AudioContext или ворклет.
    // Без остановки индикатор записи горит до закрытия вкладки, а следующее
    // нажатие «Начать» открывает второй поток поверх первого.
    try { await capture.stop(); } catch { /* останавливать нечего */ }
    capture = null;
    el.toggle.disabled = false;
    el.blankBtn.disabled = false;
    showError(
      e.name === 'NotAllowedError' ? 'No se ha permitido el acceso al micrófono. Concédalo en la barra de direcciones y vuelva a intentarlo.'
      : e.name === 'NotFoundError' ? 'No se ha encontrado ningún micrófono.'
      : e.message || 'No se ha podido obtener el sonido del micrófono.'
    );
    setStatus('error', 'Error');
    return;
  }

  detector = new MusicDetector(capture.sampleRate, capture.analyser.fftSize);
  gate = new MusicGate({
    threshold: settings.threshold,
    attackSec: settings.attack,
    releaseSec: settings.silence,
    dipSec: SEGMENT_DIP_SEC,
  });
  session = null;
  running = true;
  wasWarmingUp = true;
  // Аудиочасы у нового захвата начинаются с нуля — вместе с ними обнуляется
  // и всё, что от них отсчитывается.
  deafUntil = 0;
  deafSec = 0;

  document.body.classList.add('is-running');
  el.monitor.hidden = false;
  el.toggle.disabled = false;
  el.blankBtn.disabled = false;
  el.toggle.textContent = 'Detener';
  el.toggle.classList.replace('btn--primary', 'btn--stop');
  refreshStatus();
  log('ok', `escuchando el micrófono, ${capture.sampleRate} Hz`);

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
  el.toggle.textContent = 'Empezar a escuchar';
  el.toggle.classList.replace('btn--stop', 'btn--primary');
  el.toggle.disabled = false;
  el.blankBtn.disabled = false;
  el.phase.textContent = 'detenido';
  refreshStatus();
  releaseWakeLock();
  // Скрытый экран пустой ровно потому, что за ним всё работает. Когда работать
  // перестало — от микрофона до самой вкладки, — держать заливку значит показывать
  // ровно то же самое чёрное поле вместо причины, по которой всё смолкло.
  exitBlank('se ha dejado de escuchar: pantalla restaurada');
  // Нажали «Остановить» посреди морзянки — дослушивать её незачем, распознавание
  // уже выключено. Тем более при уходе со страницы: там шаблон пережил бы саму
  // вкладку и телефон продолжил бы стучать в пустоту.
  stopBuzz();
}

/* ------------------------------------------------------------------- глухота */

// Мотор трясёт корпус, а микрофон — часть корпуса. Задумывалось, что вредить
// этим нечему: детектор широкополосный дребезг за музыку не примет. На живом
// телефоне вышло иначе — мотор слышно так, что мимо детектора он не проходит
// вовсе, и оценка на нём не гасится, а скачет. Дальше уже неважно, в какую
// сторону: скакнула вверх — гейт держит несуществующую музыку и морозит фон;
// вниз — сессия рвётся посреди трека, а через пару секунд после морзянки
// заводится новая, и тот же трек уходит в AudD ещё раз, отдельной записью
// в истории. Порог паузы по умолчанию 2 секунды, морзянка идёт двенадцать.
//
// Поэтому на время морзянки приложение глохнет: кадр не доходит ни до
// детектора, ни до гейта — ни как музыка, ни как тишина. Ничего не случилось,
// просто этих секунд не было.
//
// Хвост нужен потому, что мотор останавливается не мгновенно: корпус ещё
// звенит, а в окне анализатора лежат последние 2048 сэмплов — сорок с лишним
// миллисекунд уже отзвучавшего.
const BUZZ_TAIL_SEC = 0.5;

/**
 * Часы, по которым живут гейт и расписание запросов. От аудиочасов отличаются
 * на всё время, что мы не слушали: иначе двенадцать секунд глухоты гейт
 * прочитал бы как двенадцать секунд ровно того, что было перед ними, и
 * размыкание — или, наоборот, начало сессии — наступило бы само собой, без
 * единого честного кадра.
 */
function heard() {
  return capture ? capture.audioTime - deafSec : 0;
}

/**
 * Не слушать `ms` миллисекунд — столько, сколько стучит мотор. Возвращает,
 * оглохли ли: когда микрофона нет вовсе, глохнуть не от чего и нечему.
 */
function deafen(ms) {
  if (!capture) return false;
  // Не max: navigator.vibrate обрывает прежний шаблон и начинает новый,
  // так что глухота отсчитывается от этого мгновения, а не от старого конца.
  deafUntil = capture.audioTime + ms / 1000 + BUZZ_TAIL_SEC;
  return true;
}

/** Мотор смолк — дальше слушаем, дав корпусу дозвенеть. */
function hearAgain() {
  deafUntil = capture ? Math.min(deafUntil, capture.audioTime + BUZZ_TAIL_SEC) : 0;
}

function deaf() {
  return Boolean(capture) && capture.audioTime < deafUntil;
}

/* --------------------------------------------------- кадр анализа и состояния */

function onFrame({ analyser, samples }) {
  // Ворклет начинает слать звук ещё до того, как start() соберёт детектор.
  if (!detector || !gate) return;
  const dt = samples / capture.sampleRate;

  // В буфер кадр всё равно попал — его туда положил ворклет, до нас. Здесь он
  // просто никого не касается: ни оценки, ни фона, ни расписания.
  if (deaf()) {
    deafSec += dt;
    return;
  }

  features = detector.step(analyser, dt, gate.playing);
  const now = heard();

  // Замер фона — исходная точка всей оценки: если он врёт, врёт и всё
  // остальное. В журнале должно быть видно, чем он кончился.
  if (wasWarmingUp && !features.warmingUp) {
    wasWarmingUp = false;
    if (features.startedInMusic) {
      log('warn', `al arrancar ya sonaba algo: el fondo no se ha medido, se toma ${features.floorDb.toFixed(0)} dB`);
    } else {
      log('', `ruido de fondo de la sala ${features.floorDb.toFixed(0)} dB`);
    }
  }

  const event = gate.step(features.score, now);
  if (event === 'start') startSession();
  else if (event === 'stop') endSession();
  // Музыка на секунду-другую прервалась и пошла снова, а гейт этого не заметил.
  // Для нас это конец одного вопроса и начало следующего: сессия та же, а трек
  // уже другой, и спрашивать про него надо заново.
  else if (session && gate.segmentAt !== null && gate.segmentAt !== session.segmentAt) {
    beginSegment(gate.segmentAt);
    log('', `la música se ha cortado y ha vuelto, envío dentro de ${untilCheck()} s`);
  }

  if (session && !inFlight && now >= session.nextCheckAt) {
    runRecognition();
  }
}

function untilCheck() {
  return Math.max(0, Math.round(session.nextCheckAt - heard()));
}

function startSession() {
  // entry живёт на всю сессию, а не на кусок: по нему сверяется, тот же трек
  // ответил или уже другой, и разрыв внутри одного трека не должен плодить
  // в истории вторую запись о нём же.
  session = { entry: null };
  beginSegment(gate.segmentAt ?? gate.startedAt);
  document.body.classList.add('is-music');
  refreshStatus();
  log('', `ha empezado la música, envío dentro de ${untilCheck()} s`);
}

/**
 * Новый непрерывный кусок музыки внутри сессии. В размыкающемся гейте это
 * просто начало сессии, а в склеенном фоновой музыкой — следующий вопрос.
 * Всё, что отсчитывается от начала трека, отсчитывается отсюда: и момент
 * отправки, и длина фрагмента, и время начала записи в истории.
 */
function beginSegment(at) {
  session.segmentAt = at;
  // Часы стены по аудиочасам, а не Date.now(): кусок начался раньше, чем мы
  // это подтвердили, и в истории должно стоять его настоящее начало.
  session.segmentAtWall = Date.now() - Math.max(0, heard() - at) * 1000;
  session.solved = false;
  session.misses = 0;
  session.errors = 0;
  // Отправка приходит ровно в тот момент, когда фрагмент целиком набрался
  // музыкой после отступа. Ждать дольше нечего: добавочные секунды в отпечаток
  // уже не попадут, а риск захватить паузу растёт с каждой.
  session.nextCheckAt = at + settings.clip + LEAD_IN;
}

// Промахнулись или узнали — дальше ждём либо разрыва в музыке, либо часов.
// Бесконечность остаётся только там, где повторять нечего в принципе.
function scheduleRecheck(s) {
  s.nextCheckAt = settings.recheck ? heard() + settings.recheck : Infinity;
}

function endSession() {
  if (session?.entry) closeEntry(session.entry);
  session = null;
  document.body.classList.remove('is-music');
  refreshStatus();
  renderNow();
  log('', 'la música ha cesado');
}

function closeEntry(entry, at = Date.now()) {
  if (!entry.endWall) {
    entry.endWall = at;
    saveHistory();
    renderHistory();
  }
}

/* ------------------------------------------------------------- распознавание */

async function runRecognition() {
  if (inFlight || !capture || !session) return;

  // Слепок куска на момент отправки. Пока запрос в полёте, музыка успевает и
  // смолкнуть, и прерваться на секунду: в первом случае сессии больше нет, во
  // втором расписание уже переставлено под следующий вопрос. Ответ и там и там
  // относится к прошлому куску, и трогать по нему текущее расписание нельзя.
  const s = session;
  const req = { s, seg: s.segmentAt, segWall: s.segmentAtWall };
  req.live = () => s === session && s.segmentAt === req.seg;

  // Считаем от начала куска, а не сессии: в склеенной сессии до него лежат
  // пауза и конец предыдущего вопроса, и в отпечатке им делать нечего.
  // На первых секундах куска берём только то, что успело прозвучать.
  const seconds = Math.min(settings.clip, heard() - req.seg);

  // Глухота спасает детектор, но не буфер: морзянку ворклет положил в него, как
  // и всё остальное, и клип берётся с хвоста. Пока мотор из хвоста не вытек,
  // отправлять нечего — ждём ровно столько, сколько его там осталось. Случай
  // не теоретический: переспрос можно поставить на 5 секунд при фрагменте в 15.
  const clean = capture.audioTime - deafUntil;
  if (clean < seconds) {
    s.nextCheckAt = heard() + (seconds - clean);
    log('', `todavía hay vibración en el búfer, envío dentro de ${Math.ceil(seconds - clean)} s`);
    return;
  }

  const clip = capture.makeClip(seconds);
  if (!clip) return;

  inFlight = true;
  refreshStatus();
  log('', `enviando ${clip.seconds.toFixed(1)} s (${Math.round(clip.blob.size / 1024)} kB)`, clip.blob);

  try {
    // Без таймаута повисший fetch держит inFlight до собственного таймаута
    // браузера — это минуты, за которые трек успевает кончиться, а приложение
    // всё это время не делает ни одной проверки.
    const result = await recognize(clip.blob, settings.token, {
      signal: AbortSignal.timeout?.(REQUEST_TIMEOUT * 1000),
    });
    requests++;
    el.counter.textContent = `${requests} ${plural(requests, 'solicitud', 'solicitudes')}`;
    if (result) handleMatch(result, req);
    else handleNoMatch(req);
  } catch (e) {
    log('err',
      e instanceof AudDError ? `AudD: ${e.message}`
      : e.name === 'TimeoutError' ? `AudD no ha respondido en ${REQUEST_TIMEOUT} s`
      : `Red: ${e.message}`);
    // Неверный ключ и исчерпанный лимит сами не рассосутся — повторять их
    // значит просто выкидывать клипы в пустоту до конца раунда.
    const fatal = e instanceof AudDError && (e.code === 900 || e.code === 901);
    showError(fatal ? e.message : '');
    // Ключ не работает или лимит выбран: запросов больше не будет, а на скрытом
    // экране это неотличимо от тишины в зале. Показываем, в чём дело.
    if (fatal) exitBlank('AudD ha rechazado la solicitud: pantalla restaurada');
    if (req.live()) {
      if (fatal) {
        s.nextCheckAt = Infinity;
      } else if (s.errors < ERROR_RETRIES) {
        s.errors++;
        s.nextCheckAt = heard() + ERROR_RETRY_SEC;
        log('warn', `reintento dentro de ${ERROR_RETRY_SEC} s`);
      } else {
        scheduleRecheck(s);
      }
    }
  } finally {
    inFlight = false;
    refreshStatus();
  }
}

function handleMatch(result, req) {
  const { s } = req;
  const key = trackKey(result);

  // Сравниваем с последним треком сессии, а не куска: разрыв мог случиться и
  // внутри трека — на тихом проигрыше, на смене части. Тогда ответ придёт тот
  // же самый, и заводить на него вторую запись в истории не за что.
  if (s.entry && s.entry.key === key) {
    log('ok', `sigue siendo «${result.title}»`);
  } else {
    // Прошлый трек кончился на границе куска, а не сейчас: иначе его
    // длительность вобрала бы и паузу, и начало этого.
    if (s.entry) closeEntry(s.entry, req.segWall);
    const entry = makeEntry(result, key, req);
    s.entry = entry;
    current = entry;
    history.unshift(entry);
    history = history.slice(0, HISTORY_LIMIT);
    saveHistory();
    // Кусок, к которому относится ответ, мог кончиться, пока запрос был в
    // полёте: закрыть запись потом будет уже некому, и в истории она осталась
    // бы играющей вечно. Закрываем сразу — по границе, а не по «сейчас».
    if (!req.live()) closeEntry(entry, s === session ? s.segmentAtWall : Date.now());
    renderHistory();
    renderNow(true);
    log('ok', `${result.artist} — ${result.title}`);
    buzzArtist(entry.artist);
    refreshMorseHint(); // в подсказке настроек разбирается последнее имя, а не «Queen»
  }

  if (req.live()) {
    s.solved = true;
    scheduleRecheck(s);
  }
}

function handleNoMatch(req) {
  log('warn', 'sin coincidencias');
  if (!req.live()) return;
  const { s } = req;
  if (s.misses < MISS_RETRIES) {
    s.misses++;
    s.nextCheckAt = heard() + MISS_RETRY_SEC;
    log('', `probaré con otro fragmento dentro de ${MISS_RETRY_SEC} s`);
  } else {
    // Три промаха подряд по разным фрагментам — это уже не «взяли не тот
    // кусок», а трек, которого в базе AudD нет. Дальше только по часам.
    scheduleRecheck(s);
  }
}

// Начало берём из слепка запроса, а не из текущего состояния: пока запрос был
// в полёте, музыка могла смолкнуть или прерваться, и начало трека в истории
// оказалось бы равно моменту распознавания либо началу уже следующего вопроса.
function makeEntry(result, key, req) {
  return {
    id: `${Date.now()}-${Math.round(performance.now())}`,
    key,
    title: result.title || 'Sin título',
    artist: result.artist || '',
    album: result.album || '',
    label: result.label || '',
    releaseDate: result.release_date || '',
    art: artworkUrl(result, 300),
    links: links(result),
    startWall: req.segWall,
    recognizedWall: Date.now(),
    endWall: null,
  };
}

/* -------------------------------------------------------------------- морзе */

// Ответ приходит ровно тогда, когда смотреть на экран нельзя: вопрос ещё идёт,
// телефон лежит экраном вниз или в кармане. Имя исполнителя стучится морзянкой,
// и ответ узнаётся, не доставая телефон.
//
// Мотор слышно микрофоном, и слышно сильно: на время морзянки приложение
// глохнет целиком, см. «глухота» выше.
let vibrationWarned = false;

// `secret` — тренировка: имя загадано, и в журнале ему не место. Сама строка
// там всё равно нужна, иначе молчащий мотор не отличить от шаблона, который
// браузер не пропустил.
function buzzArtist(artist, { secret = false } = {}) {
  if (!settings.morse) return;
  if (typeof navigator.vibrate !== 'function') {
    // Один раз за сессию: телефон от этого вибрировать не начнёт, а журнал
    // забился бы одинаковыми строками на каждый трек.
    if (!vibrationWarned) {
      vibrationWarned = true;
      log('warn', 'el navegador no admite la vibración; en el iPhone no existe en absoluto');
    }
    return;
  }

  const letters = spell(artist);
  if (!letters.length) {
    log('', secret ? 'no hay nada que marcar del nombre pensado'
      : artist ? `«${artist}» no tiene nada que marcar` : 'artista desconocido, no habrá vibración');
    return;
  }

  // Вибрация в скрытой вкладке отбрасывается — это не наша ошибка, но и не
  // «всё сработало»: без строки в журнале молчащий телефон не объяснить.
  const buzz = morse.pattern(letters, timing());
  const ms = buzz.reduce((sum, v) => sum + v, 0);
  const sent = navigator.vibrate(buzz);
  // Глохнем ровно на то, что мотор действительно стучит: шаблон, который
  // браузер не пропустил, корпус не трясёт, и глохнуть на него не за что.
  const wentDeaf = sent && deafen(ms);
  const what = secret
    ? `a ciegas, ${letters.length} ${plural(letters.length, 'letra', 'letras')}`
    : readout(letters);
  // Глухота стоит распознавания и потому попадает в журнал: замерший монитор
  // и отложенная проверка иначе выглядят сбоем, а не платой за ответ на ощупь.
  const tail = !sent ? ' — el navegador no la ha dejado pasar'
    : wentDeaf ? `, sin escuchar durante ${(ms / 1000).toFixed(1)} s`
    : '';
  log('', `vibración ${what}${tail}`);
}

function stopBuzz() {
  navigator.vibrate?.(0);
  hearAgain();
}

// Из настроек морзянка берёт не только длительности, но и саму азбуку: сколько
// букв стучать и какими. Один разбор на всех, чтобы вибрация, подсказка и цена
// буквы не разъехались, когда добавится ещё что-нибудь.
function spell(name = buzzSample()) {
  return morse.spell(name, settings.morseLetters, settings.morseSimple);
}

// Что уйдёт в мотор — буквами и знаками, одной строкой: «KUIN · −·− ··− ·· −·».
// Метка, если включена, стоит впереди через косую черту: буквой имени она
// не является, и приписанная вплотную читалась бы как ещё одна.
function readout(letters) {
  return `${morse.word(letters, settings.morseMark)} · ${morse.dashes(letters, settings.morseMark)}`;
}

// Настройки хранятся плоско — иначе новый ключ, добавленный к уже сохранённому
// объекту, не получил бы значения по умолчанию при слиянии. Морзянке нужен
// объект, здесь их и собираем.
function timing(twice = settings.morseTwice) {
  return {
    dot: settings.morse,
    dash: settings.morseDash,
    gapSymbol: settings.morseGapSym,
    gapLetter: settings.morseGapLetter,
    gapRepeat: settings.morseGapRepeat,
    mark: settings.morseMark,
    twice,
  };
}

// На чём показывать и проверять вибрацию. Имя, которое только что играло,
// на ощупь разбирается вернее выдуманного — его уже знаешь, и остаётся понять
// не «что это», а «те ли это буквы». Своей истории нет — берём образец.
function buzzSample() {
  return current?.artist || history[0]?.artist || 'Queen';
}

/* ------------------------------------------------------------------ тренировка */

// Азбуку не выучить по таблице: на ощупь считывается не точка с тире, а форма
// всей буквы, и форма эта у каждого мотора и каждого кармана своя. Поэтому
// тренажёр стучит теми же настройками, какими придёт настоящий ответ, — иначе
// натренируется то, чего в квизе не будет.
//
// Имена берутся из списка известных, а не собираются из случайных букв: на ощупь
// половину имени достраивает догадка, и тренировать надо в том числе её.
let training = { name: '', shown: false };

function trainPick() {
  // Подряд одно и то же имя не загадываем: второй такой же проход читается как
  // «угадал», хотя это просто тот же ответ ещё раз.
  let next = training.name;
  while (ARTISTS.length > 1 && next === training.name) {
    next = ARTISTS[Math.floor(Math.random() * ARTISTS.length)];
  }
  training = { name: next, shown: false };
}

function trainBuzz() {
  if (!training.name) trainPick();
  renderTraining();
  buzzArtist(training.name, { secret: !training.shown });
}

function trainNext() {
  trainPick();
  renderTraining();
  buzzArtist(training.name, { secret: true });
}

function trainShow() {
  if (!training.name) return;
  training.shown = true;
  renderTraining();
}

function renderTraining() {
  const off = !settings.morse;
  for (const id of ['trainBuzzBtn', 'trainNextBtn']) $(id).disabled = off;
  // Показывать нечего, пока имя не загадано, и незачем, когда уже показано.
  $('trainShowBtn').disabled = off || !training.name || training.shown;

  const answer = $('trainAnswer'), code = $('trainCode');
  answer.classList.toggle('is-waiting', !training.shown);
  code.textContent = '';

  if (off) { answer.textContent = 'La vibración está desactivada: no hay nada que entrenar.'; return; }
  if (!training.name) { answer.textContent = 'Todavía no se ha pensado ningún nombre.'; return; }
  if (!training.shown) { answer.textContent = 'Nombre pensado. Puede marcarlo tantas veces como quiera.'; return; }

  // Показываем и имя целиком, и то, что от него дошло до мотора: разошлись они
  // ещё до вибрации — артикль снят, буквы упрощены, лишнее отрезано, — и без
  // второй строки «не угадал» выглядит ошибкой слуха, а не работой азбуки.
  const letters = spell(training.name);
  answer.textContent = training.name;
  code.textContent = letters.length ? readout(letters) : '';
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/* ------------------------------------------------------------------- отрисовка */

function renderNow(fresh = false) {
  if (!current) { el.now.hidden = true; return; }
  el.now.hidden = false;

  const live = session?.entry?.id === current.id;
  el.nowKicker.textContent = live ? 'Sonando ahora' : 'Última canción';

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
  const tail = live ? `sonando ${dur(played)}` : `${clock(current.startWall)} · ${dur(played)}`;
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
  if (document.hidden || blank || !features || !detector) return;

  // Фаза стоит в шапке спойлера и видна, даже когда монитор свёрнут, — считаем
  // её первой и всегда.
  //
  // Пока стучит мотор, полоски и цифры под ними стоят на последнем услышанном
  // кадре. Без строки об этом замерший монитор читается как зависший.
  el.phase.textContent = deaf()
    ? 'vibración: el micrófono no cuenta'
    : features.warmingUp
      ? 'midiendo el ruido de la sala'
      : session
        ? (session.solved ? 'canción identificada' : 'suena música, reuniendo el fragmento')
        : 'esperando música';

  updateNowTimer();

  // Под свёрнутым спойлером не видно ни полосок, ни спектра, ни строки приборов.
  // Считать и рисовать их каждый кадр — та же работа впустую, что и отрисовка
  // под чёрным экраном, и стоит она столько же.
  if (!el.monitor.open) return;

  const pct = Math.round(features.score * 100);
  el.scoreFill.style.width = `${pct}%`;
  el.scoreValue.textContent = `${pct}%`;
  el.scoreMark.style.left = `${settings.threshold * 100}%`;

  for (const [name, node] of Object.entries(el.factors)) {
    node.style.width = `${features[name] * 100}%`;
    node.style.background = features[name] > 0.6 ? 'var(--accent)' : 'var(--muted)';
  }

  el.readout.textContent =
    `nivel ${features.rmsDb.toFixed(0)} dB · fondo ${features.floorDb.toFixed(0)} dB · ` +
    `exceso ${features.snr.toFixed(0)} dB · rango ${features.dynamicsDb.toFixed(1)} dB · ` +
    `planitud ${features.flatness.toFixed(3)} · ` +
    `graves ${(features.bassRatio * 100).toFixed(0)}% · agudos ${(features.highRatio * 100).toFixed(0)}%` +
    (session && Number.isFinite(session.nextCheckAt)
      ? ` · próxima comprobación en ${Math.max(0, Math.round(session.nextCheckAt - heard()))} s`
      : '');

  drawSpectrum();
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
  if (document.hidden || !running) return;
  // Лок возвращается в любом случае: на скрытом экране он и держит всё
  // остальное — погасший экран на телефоне уносит с собой и захват звука.
  requestWakeLock();
  if (blank) return;
  // rAF в скрытой вкладке не отменяется, а откладывается: отложенный колбэк
  // сработает при возврате. Планировать ещё один, не сняв прежний, — значит
  // завести второй параллельный цикл отрисовки, и так на каждое сворачивание.
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(render);
});

/* ---------------------------------------------------------------- пустой экран */

// Смотреть на страницу незачем: ответ приходит вибрацией, а светящийся экран
// в зале виден соседям и съедает батарею быстрее всего остального. Поэтому
// интерфейс не сворачивается, а закрывается целиком — сплошной заливкой поверх
// всего. Под ней ничего не меняется: звук снимает ворклет, а не отрисовка,
// и распознавание с морзянкой идут своим чередом на уже выставленных
// настройках. Отрисовка при этом останавливается совсем — рисовать под
// заливкой некому и не для кого.

const HOLD_MOVE_LIMIT = 24; // px, после которых нажатие считается движением
let holdRaf = 0;
let holdFrom = null;

async function enterBlank() {
  // disabled — это ещё и «микрофон уже запрашивается»: второе нажатие открыло бы
  // второй захват поверх первого.
  if (blank || el.blankBtn.disabled) return;
  // Прятать нечего, пока не слушаем. Разрешение на микрофон спрашивается
  // до заливки: отказ должен быть виден, а не спрятан под чёрным экраном.
  if (!running) {
    await start();
    if (!running) return;
  }
  blank = true;
  el.blank.hidden = false;
  el.blank.classList.toggle('is-white', settings.blankWhite);
  document.body.classList.add('is-blank');
  setThemeColor(settings.blankWhite ? '#ffffff' : '#000000');
  cancelAnimationFrame(rafId);
  rafId = 0;
  // Адресная строка — тоже интерфейс. Где полноэкранного режима нет
  // (iOS Safari) или где жест уже протух после запроса микрофона, остаётся
  // просто пустая страница — ради неё всё и затевалось.
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); }
  catch { /* отказ полноэкранного режима заливке не мешает */ }
  log('', 'pantalla oculta: sigo escuchando');
}

function exitBlank(why = 'pantalla restaurada') {
  if (!blank) return;
  blank = false;
  cancelHold();
  el.blank.hidden = true;
  document.body.classList.remove('is-blank');
  setThemeColor(THEME_COLOR);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (running) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
  }
  log('', why);
}

function setThemeColor(color) {
  if (themeMeta) themeMeta.content = color;
}

// Пока держат палец — показываем, чем приложение занято. Это единственный
// способ отличить работающий чёрный экран от погасшего телефона, не выходя
// из режима: коснулся, прочитал, отпустил.
function blankStatus() {
  const state = !running ? 'detenido'
    : inFlight ? 'reconociendo'
    : gate?.playing ? 'suena música'
    : 'escuchando';
  const last = current ? `${current.artist} — ${current.title}` : 'todavía no se ha reconocido nada';
  return `${state} · ${last}`;
}

function beginHold(e) {
  if (!blank) return;
  cancelHold();
  holdFrom = { x: e.clientX, y: e.clientY };
  // Захват указателя: без него отпускание за краем окна до нас не дойдёт,
  // и отсчёт добежал бы до конца уже после того, как палец убрали.
  try { el.blank.setPointerCapture(e.pointerId); } catch { /* мышь без id */ }
  el.blankState.textContent = blankStatus();
  el.blank.classList.add('is-holding');
  // Отсчёт от кадра, а не от таймера: полоска и выход должны кончиться
  // одновременно, иначе она либо не доходит до края, либо стоит полной.
  const started = performance.now();
  const step = () => {
    const done = (performance.now() - started) / (settings.blankHold * 1000);
    el.blankBar.style.width = `${Math.min(1, done) * 100}%`;
    if (done >= 1) exitBlank();
    else holdRaf = requestAnimationFrame(step);
  };
  holdRaf = requestAnimationFrame(step);
}

function cancelHold() {
  cancelAnimationFrame(holdRaf);
  holdRaf = 0;
  holdFrom = null;
  el.blank.classList.remove('is-holding');
  el.blankBar.style.width = '0';
}

el.blank.addEventListener('pointerdown', beginHold);
el.blank.addEventListener('pointerup', () => cancelHold());
el.blank.addEventListener('pointercancel', () => cancelHold());
// Телефон в кармане нажимается сам, но он же там и ездит. Сдвиг пальца
// сбрасывает отсчёт — случайное нажатие почти всегда со сдвигом, нарочное
// почти всегда без.
el.blank.addEventListener('pointermove', (e) => {
  if (!holdFrom) return;
  if (Math.hypot(e.clientX - holdFrom.x, e.clientY - holdFrom.y) > HOLD_MOVE_LIMIT) cancelHold();
});
// С клавиатуры держать нечего. В полноэкранном режиме первый Escape забирает
// себе браузер — тогда экран вернётся со второго.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') exitBlank(); });

/* --------------------------------------------------------------- настройки UI */

function bindCheck(id, key, onApply) {
  const input = $(id);
  input.checked = settings[key];
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    saveSettings();
    onApply?.();
  });
}

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
  return sync;  // подписи морзянки считаются от точки и меняются вместе с ней
}

function applyGate() {
  gate?.configure({ threshold: settings.threshold, releaseSec: settings.silence });
}

// Длина фрагмента задаёт и момент отправки, и минимальную длину трека, который
// вообще может быть распознан. Из подписи «8 с» не следует ни то, ни другое,
// поэтому последствие считается и показывается прямо под ползунком.
function refreshClipHint() {
  const at = settings.clip + LEAD_IN;
  $('setClipHint').textContent =
    `El envío se hace en el segundo ${at} de la canción; el fragmento va del segundo ${LEAD_IN} al ${at}. ` +
    `Si la canción dura menos de ${at} s, en la huella entrará la pausa que viene después. ` +
    `AudD trabaja con más seguridad a partir de 10 s, pero no toda canción los tiene.`;
}

// Ползунков у морзянки шесть, и почти все считаются друг от друга: паузы кратны
// точке, а между собой связаны отношением, которое и решает, разбирается имя на
// ощупь или сливается. Поэтому подписи и подсказки перерисовываются все разом
// и на живом имени — на последнем распознанном, пока его нет, на «Queen».
let morseSyncs = [];

function refreshMorseHint() {
  const dot = settings.morse;
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const letters = spell();
  const off = !dot;

  for (const sync of morseSyncs) sync();
  for (const id of ['testMorseBtn', 'setMorseLetters', 'setMorseSimple', 'setMorseDash', 'setMorseGapSym',
                    'setMorseGapLetter', 'setMorseMark', 'setMorseTwice', 'setMorseGapRepeat']) {
    $(id).disabled = off;
  }
  // Пауза стыка стоит и после метки, и перед повтором: снять её можно только
  // вместе с обоими.
  $('setMorseGapRepeat').disabled = off || !(settings.morseMark || settings.morseTwice);
  renderTraining();

  if (off) {
    $('setMorseHint').textContent = 'El teléfono calla: la respuesta solo se ve en la pantalla.';
    $('setMorseTwiceHint').textContent = 'No hay nada que repetir: la vibración está desactivada.';
    for (const id of ['setMorseLettersHint', 'setMorseSimpleHint', 'setMorseGapSymHint',
                      'setMorseGapLetterHint', 'setMorseMarkHint', 'setMorseGapRepeatHint']) {
      $(id).textContent = '';
    }
    stopBuzz(); // выключили посреди морзянки — она не должна доиграть
    return;
  }

  const once = morse.totalMs(letters, timing(false));
  const twice = morse.totalMs(letters, timing(true));
  // Цена метки и цена повтора — на этом самом имени и этих настройках. Обе
  // сравниваются в подсказках друг с другом, и обе зависят от всех ползунков
  // сразу, так что считаются, а не берутся из таблицы.
  const markMs = morse.totalMs(letters, { ...timing(false), mark: true })
               - morse.totalMs(letters, { ...timing(false), mark: false });
  const repeatMs = twice - once;
  const shown = letters.length
    ? `«${morse.word(letters, settings.morseMark)}» → ${morse.dashes(letters, settings.morseMark)}, ` +
      `son ${secs(settings.morseTwice ? twice : once)}. `
    : '';

  $('setMorseHint').textContent =
    `${shown}Desde el punto se calcula todo lo demás —la raya y las pausas—, así que este control cambia la velocidad general. ` +
    `Por debajo de 60 ms el motor no llega a arrancar y detenerse, y el punto y la raya se funden. ` +
    `Además, la pestaña debe estar abierta en pantalla: ningún navegador deja pasar la vibración desde segundo plano, y el iPhone no la admite en absoluto.`;

  $('setMorseLettersHint').textContent =
    `Solo alfabeto latino: el cirílico se translitera, cada cifra pasa a ser la primera letra de su nombre en inglés (2 → T), ` +
    `los espacios y los signos se descartan, y el artículo The al principio del nombre no se marca en absoluto: se llevaría ` +
    `tres de las cinco letras sin distinguir nada con ellas. Cada letra de más son ${secs(perLetterMs())} más de vibración.`;

  // Что именно упрощение сделало с этим именем, видно только рядом с полной
  // азбукой: «KUIN» сам по себе выглядит опечаткой, а не заменой.
  const full = morse.spell(buzzSample(), settings.morseLetters);
  const pairs = morse.simplePairs().map(({ from, to }) => `${from.join(' y ')} → ${to}`).join(', ');
  // Короче — почти всегда, но не по определению: тире и пауза внутри буквы
  // задаются отдельно, и на длинном тире с короткой паузой ·−− (W) успевает
  // обогнать ···− (V). Поэтому не обещаем, а считаем.
  const saved = morse.totalMs(full, timing()) - morse.totalMs(letters, timing());
  const delta = Math.abs(saved) < 50 ? '' : `, ${secs(Math.abs(saved))} más ${saved > 0 ? 'corto' : 'largo'}`;
  $('setMorseSimpleHint').textContent =
    `Las cinco letras que no tienen sonido propio se sustituyen por las que suenan en su lugar: ${pairs}. ` +
    `La sexta, la C, se lee según su vecina, como en inglés: ante E, I e Y es S («City» → SITI) ` +
    `y, si no, K («Coldplay» → KOLDPLAI); CH es SH. ` +
    `Las letras dobles se colapsan en una: en el motor son dos códigos iguales seguidos, y distinguirlos ` +
    `de uno solo depende únicamente de la duración de la pausa entre ambos — «Iggy» → IGI, «Black» → BLAK. ` +
    `El par EE es I, sin excepciones: «Queen» → KUIN, «Green Day» → GRIND. ` +
    `El par EA es también I («The Beatles» → BITLE), salvo en EAR, EAD y EATH: «Pearl Jam» se queda como está. ` +
    `El par TH es T: su sonido es uno solo y en los nombres casi siempre sordo («Thunder» → TUNDE, «Anthrax» → ANTRA), ` +
    `y la H es el signo más caro que se puede quitar: cuatro puntos y tres pausas dentro de la letra. ` +
    `El par PH es F: el mismo sonido, con un código dos puntos más corto que el de la P («Phish» → FISH, «Aphex Twin» → AFEXT). ` +
    `Ninguna regla cruza el límite de palabra, porque lo que se lee es la palabra y no el nombre entero: «Hip Hop» sale tal cual HIPHO, ` +
    `y «Eric Clapton», ERIKK, con dos K de palabras distintas. ` +
    `Quedan veinte códigos en vez de veintiséis, y los seis que se van eran de cuatro signos: ` +
    `el nombre queda mal escrito, pero al tacto tiene menos signos que se puedan perder. ` +
    `Y no siempre sale más corto: el hueco que se libera pasa al sonido siguiente, y las cinco letras llegan más adentro del nombre. ` +
    (!settings.morseSimple
      ? 'Ahora el nombre se envía con el alfabeto completo, con los veintiséis códigos.'
      : !letters.length
        ? ''
        : morse.word(full) !== morse.word(letters)
          ? `«${morse.word(full)}» llega al motor como «${morse.word(letters)}»${delta}.`
          : `En «${morse.word(letters)}» no hay nada que sustituir: al tacto no cambia nada.`);

  $('setMorseMarkHint').textContent =
    `Antes del nombre se marca siempre la misma letra —${morse.MARK.char}, es decir ${morse.dashes([morse.MARK])}— ` +
    `y tras ella la pausa de separación. La respuesta llega sin avisar: para cuando la mano se da cuenta de que el teléfono vibra, ` +
    `la primera letra del nombre ya ha pasado. La marca se queda con ese momento: lo que se pierde es ella y no el principio de la respuesta. ` +
    `Además no cuenta como letra del nombre y no entra en las ${settings.morseLetters} ` +
    `${plural(settings.morseLetters, 'letra', 'letras')} previstas. ` +
    `Se ha elegido la O aunque la S sea cuatro puntos más corta: una marca delante de un nombre que empieza por esa misma letra ` +
    `da dos códigos iguales seguidos, y de los doscientos del canon 22 empiezan por S y cinco por O. ` +
    `Cuesta ${secs(markMs)} en cada pasada, frente a ${secs(repeatMs)} de una segunda pasada del mismo nombre.` +
    (settings.morseMark ? '' : ' Ahora el nombre empieza directamente por su primera letra.');

  $('setMorseGapSymHint').textContent =
    `Entre los puntos y las rayas de una misma letra. En el propio alfabeto equivale a un punto, pero al final de cada señal ` +
    `el motor sigue sacudiendo la carcasa y, con una pausa así, el punto y la raya se emborronan en una sola señal.`;

  // Отношение двух пауз — единственное, что здесь можно сломать молча: буквы
  // делятся только тем, что между ними тише дольше. Показываем во сколько раз.
  const ratio = settings.morseGapLetter / settings.morseGapSym;
  $('setMorseGapLetterHint').textContent =
    `Ahora es ${ratio.toFixed(1)} veces más larga que la pausa dentro de la letra. ` +
    (ratio >= 2
      ? 'Es el único rasgo por el que las letras llegan a separarse.'
      : 'Poco: las letras se fundirán en un único flujo de puntos y rayas y no habrá con qué separarlas.');

  // Пауза стыка отделяет метку от имени и первый проход от второго — задача
  // у неё в обоих местах одна, и ползунок поэтому один. А вот сломать её можно
  // по-разному, и подсказка говорит ровно о том, что сейчас включено.
  const name = morse.word(letters);
  $('setMorseGapRepeatHint').textContent =
    !settings.morseMark && !settings.morseTwice
      ? 'Solo actúa con la marca o con la repetición.'
      : settings.morseMark && settings.morseTwice
        ? `Separa la marca del nombre y la primera pasada de la segunda. No puede ser igual que la pausa entre letras: ` +
          `la marca se leería como la primera letra del nombre, y la repetición, como su continuación, y «${name}» resultaría ` +
          `el doble de largo al tacto.`
        : settings.morseMark
          ? `Separa la marca del nombre. No puede ser igual que la pausa entre letras: la marca se leería como la primera ` +
            `letra del nombre y, en vez de «${name}», al tacto saldría «${morse.MARK.char}${name}».`
          : `Entre la primera y la segunda pasada. No puede ser igual que la pausa entre letras: la repetición se leería ` +
            `como continuación del nombre y «${name}» resultaría el doble de largo al tacto.`;

  $('setMorseTwiceHint').textContent =
    'La segunda pasada es el mismo nombre desde el principio: una segunda oportunidad no solo para el comienzo, sino también para el medio. ' +
    (settings.morseMark
      ? `El comienzo ya lo protege la marca, y esta cuesta ${secs(markMs)} frente a ${secs(repeatMs)}. `
      : 'Sin la marca es el único seguro: la respuesta llega sin avisar y, para cuando la mano se da ' +
        'cuenta de que el teléfono vibra, las primeras letras ya han pasado. ') +
    (letters.length ? `Con repetición son ${secs(twice)}; sin ella, ${secs(once)}.` : 'Cuesta exactamente el doble.');
}

// Цена одной буквы — не константа: она зависит и от кода буквы, и от всех пауз.
// Берём среднее по тому, что стучится сейчас, — врать оно может только в мелочи.
function perLetterMs() {
  const letters = spell();
  if (!letters.length) return 0;
  // Без метки: она стоит одинаково при любом числе букв, и в цену буквы её доля
  // не входит — иначе четыре буквы выглядели бы дороже, чем стоят.
  return morse.totalMs(letters, { ...timing(), mark: false }) / letters.length;
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
  bindRange('setClip', 'clip', (v) => `${v} s`, refreshClipHint);
  bindRange('setSilence', 'silence', (v) => `${v} s`, applyGate);
  // Пересчёт на месте: сессия, которой уже нечего делать, стоит на
  // бесконечности, и без него включённый переспрос подействовал бы только
  // со следующего трека — то есть ровно тогда, когда он и не нужен.
  bindRange('setRecheck', 'recheck', (v) => (v ? `cada ${v} s` : 'no volver a preguntar'), () => {
    if (session && (session.solved || !Number.isFinite(session.nextCheckAt))) scheduleRecheck(session);
  });
  // Паузы задаются в точках, а прикладывается всё в миллисекундах: подписи
  // показывают и то и другое, иначе «8» под ползунком не значит ничего.
  const dots = (v) => `${v} ${plural(v, 'punto', 'puntos')} · ${v * settings.morse} ms`;
  morseSyncs = [
    bindRange('setMorse', 'morse', (v) => (v ? `${v} ms` : 'desactivada'), refreshMorseHint),
    bindRange('setMorseLetters', 'morseLetters', (v) => `${v}`, refreshMorseHint),
    bindRange('setMorseDash', 'morseDash', dots, refreshMorseHint),
    bindRange('setMorseGapSym', 'morseGapSym', dots, refreshMorseHint),
    bindRange('setMorseGapLetter', 'morseGapLetter', dots, refreshMorseHint),
    bindRange('setMorseGapRepeat', 'morseGapRepeat', dots, refreshMorseHint),
  ];
  // Галочку и ползунки морзянки двигают, чтобы почувствовать разницу, а не чтобы
  // посмотреть на цифру. Отстукиваем новый вариант сразу — но на change, а не на
  // input: во время перетаскивания каждое движение обрывало бы предыдущий шаблон,
  // и под пальцем была бы не морзянка, а дребезг.
  bindCheck('setMorseMark', 'morseMark', () => { refreshMorseHint(); buzzArtist(buzzSample()); });
  bindCheck('setMorseTwice', 'morseTwice', () => { refreshMorseHint(); buzzArtist(buzzSample()); });
  bindCheck('setMorseSimple', 'morseSimple', () => { refreshMorseHint(); buzzArtist(buzzSample()); });
  for (const id of ['setMorse', 'setMorseLetters', 'setMorseDash', 'setMorseGapSym',
                    'setMorseGapLetter', 'setMorseGapRepeat']) {
    $(id).addEventListener('change', () => buzzArtist(buzzSample()));
  }
  // Цвет виден сразу, а не со следующего скрытия: галочку щёлкают, чтобы
  // посмотреть, каким экран будет.
  bindCheck('setBlankWhite', 'blankWhite', () => {
    el.blank.classList.toggle('is-white', settings.blankWhite);
    if (blank) setThemeColor(settings.blankWhite ? '#ffffff' : '#000000');
  });
  bindRange('setBlankHold', 'blankHold', (v) => `${v} s`);

  refreshClipHint();
  refreshMorseHint();

  // Единственный способ узнать, доходит ли вибрация до этого телефона, — не
  // дожидаться трека. Стучит то же, что придёт на распознавание, и на том же
  // имени, что показано в подсказке.
  $('testMorseBtn').addEventListener('click', () => buzzArtist(buzzSample()));

  $('trainBuzzBtn').addEventListener('click', trainBuzz);
  $('trainShowBtn').addEventListener('click', trainShow);
  $('trainNextBtn').addEventListener('click', trainNext);

  $('resetSettingsBtn').addEventListener('click', () => {
    settings = { ...DEFAULTS, token: settings.token }; // ключ сбрасывать не за что
    saveSettings();
    location.reload();
  });
}

/* --------------------------------------------------------------------- запуск */

el.toggle.addEventListener('click', () => (running ? stop() : start()));
el.blankBtn.addEventListener('click', enterBlank);
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
  showError('El navegador no admite la captura de sonido. Hace falta un Chrome, Firefox, Edge o Safari moderno a través de HTTPS.');
  el.toggle.disabled = true;
  el.blankBtn.disabled = true; // прятать нечего: слушать этот браузер всё равно не будет
}
