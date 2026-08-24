import { AudioCapture } from './audio.js';
import { PoseGate, PoseSensor } from './pose.js';
import { recognize, trackKey, artworkUrl, links, AudDError } from './audd.js';
import { ask, SYSTEM, OLD_SYSTEM, AskError } from './openrouter.js';
import * as morse from './morse.js';
import { ARTISTS } from './artists.js';

// Приложение рассчитано на короткий трек-вопрос: 10–20 секунд музыки, потом
// пауза на ответ, потом следующий вопрос. Вопрос открывает и закрывает нога:
// пока она поднята, идёт запись, и фрагмент длится ровно столько, сколько
// длился сам вопрос.
const DEFAULTS = {
  v: 5,              // версия набора настроек, см. loadSettings
  // О чём вопрос. Трек-вопрос узнаёт AudD по отпечатку; вопрос, который не про
  // музыку — «в каком году», «кто написал», «сколько лун», — отпечатком не
  // берётся вовсе, и на него отвечает модель, которой тот же клип уходит
  // целиком. Всё остальное от этого не меняется: нога так же открывает и
  // закрывает вопрос, фрагмент так же режется из буфера, ответ так же уходит
  // в мотор морзянкой. Меняется ровно то, кому уходит клип и что приходит
  // обратно — трек или текст.
  ask: 'song',       // 'song' | 'question'
  token: '',         // пользователь вводит свой; хранится только в localStorage
  orToken: '',       // ключ OpenRouter, там же и так же
  // Что просят у модели. В настройках, а не в клиенте, ровно из-за мотора:
  // до него доходят первые morseLetters букв ответа, и «Париж» помещается
  // целиком, а «Столица Франции — Париж» приходит как STOLI. Значит, длину
  // ответа задаёт эта строка, а не ползунок, — и раз она решает, читается
  // ответ на ощупь или нет, ей место среди настроек.
  system: SYSTEM,
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
  // Метка начала: перед именем стучится всегда одна и та же буква, T — одно
  // тире. Ответ приходит без предупреждения, и пока рука сообразила, что телефон
  // вибрирует, первая буква имени уже прошла; метка забирает этот момент себе —
  // теряется она, а не начало ответа. Буквой имени она не считается и в
  // отмеренную пятёрку не входит. Включена, потому что делает работу второго
  // прохода — бережёт начало — почти впятеро дешевле его: 2.3 секунды против 11.
  morseMark: true,
  // Повтор удваивает и без того немалое время: среднее имя канона — 9 секунд
  // одним проходом и 20 двумя, дольше самого трека-вопроса. Начало теперь
  // бережёт метка, и по умолчанию повтор выключен. Остаётся он для тех, кому
  // нужен второй шанс на всё имя, а не только на его начало.
  morseTwice: false,
  // Включение ногой: одна поза слушает, другая молчит. Ось снимается
  // калибровкой и живёт здесь же: без неё гейт видит движение, но не знает,
  // в какую сторону оно значит «слушай».
  poseAxis: null,
  poseStep: 3.5,     // ° набега вращения, ниже которых движение позой не считается
  // Скрытый экран: страницы не видно, приложение слушает и стучит дальше.
  blankWhite: false,  // чёрный или белый — на сам звук это не влияет никак
  blankHold: 1.5,     // сколько держать палец, чтобы вернуть интерфейс
};

// Первые такты — худший материал для отпечатка: интро разрежено (мало
// спектральных пиков → мало хешей), да и плеер успевает добавить своё плавное
// включение. Раньше отступ был 3 секунды, но на десятисекундном треке это треть
// всего, что у нас есть. Секунда снимает щелчок включения и на этом всё.
const LEAD_IN = 1;

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
  error: $('errorBox'),
  now: $('nowCard'), nowArt: $('nowArt'), nowArtEmpty: $('nowArtEmpty'), nowKicker: $('nowKicker'),
  nowTitle: $('nowTitle'), nowArtist: $('nowArtist'), nowMeta: $('nowMeta'), nowLinks: $('nowLinks'),
  historyList: $('historyList'), historyEmpty: $('historyEmpty'), clearHistory: $('clearHistoryBtn'),
  log: $('logList'), tokenNotice: $('tokenNotice'), orTokenNotice: $('orTokenNotice'),
  blankBtn: $('blankBtn'), blank: $('blank'), blankState: $('blankState'), blankBar: $('blankBar'),
};

// Цвет системной строки браузера. На скрытом экране она — последнее, что от
// интерфейса остаётся, если полноэкранного режима в этом браузере нет.
const themeMeta = document.querySelector('meta[name="theme-color"]');
const THEME_COLOR = themeMeta?.content || '#0b0d12';

let settings = loadSettings();
let history = loadHistory();
let capture = null;
let poseGate = null;     // включение ногой; null — датчик не поднимали
let poseSensor = null;
let session = null;      // текущий непрерывный отрезок музыки
let current = null;      // запись, показанная в «Сейчас играет»
let inFlight = false;
let requests = 0;
let running = false;
// Пока мотор стучит морзянку, микрофон слушает мотор, а не комнату (см. «глухота»).
let deafUntil = 0;       // до какого момента аудиочасов не слушаем
let deafFrom = 0;        // и с какого: кусок, записанный до вибрации, ею не испорчен
let deafSec = 0;         // сколько всего не слушали — на это отстают часы приложения
let wakeLock = null;
let rafId = 0;
let blank = false;       // экран скрыт, приложение работает

/* ------------------------------------------------------------------ хранилище */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    // Набор настроек менялся вместе с кодом, и сохранённые с прошлой версии
    // значения перебили бы новые умолчания: на своём же устройстве было бы не
    // понять, почему ничего не изменилось. Ключи и ось при этом теряются зря —
    // они не настройки, а то, что добыто отдельно: первые выданы сервисом,
    // вторая снята с телефона, и умолчания у них не существует.
    if (saved.v !== DEFAULTS.v) {
      return {
        ...DEFAULTS,
        token: saved.token || '',
        orToken: saved.orToken || '',
        // Ось не настройка и смену версий переживает — но не пятую: до неё это
        // было направление сдвига тяжести, теперь ось вращения гироскопа, и это
        // разные векторы про одно движение. Старая ось новому гейту не годится
        // ничем, а честная перекалибровка лучше гейта, молчащего с виду исправно.
        poseAxis: (saved.v >= 5 && saved.poseAxis) || null,
      };
    }
    const merged = { ...DEFAULTS, ...saved };
    // Подсказку модели, которую не трогали руками, обновляем вместе с кодом:
    // список прежних умолчаний ведёт сам клиент, см. OLD_SYSTEM.
    if (OLD_SYSTEM.includes(merged.system)) merged.system = DEFAULTS.system;
    return merged;
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

/* ------------------------------------------------------- режим активации */

// Нога работает выключателем только тогда, когда известно, в какую сторону она
// поворачивает телефон: без оси гейт на любое движение отвечает «не знаю».
// Отсюда и проверка — и отсюда же требование откалиброваться до первого пуска:
// некалиброванной ногой вопрос не открыть ничем, а другого выключателя нет.
const poseReady = () => Boolean(settings.poseAxis);

// Вопрос не про музыку: отвечает не AudD, а модель. Проверка нужна во многих
// местах и всегда об одном — кому уходит клип и чем считать то, что вернулось.
const asksQuestion = () => settings.ask === 'question';

/** Ключ того сервиса, который сейчас отвечает: их два, а нужен всегда один. */
const activeToken = () => (asksQuestion() ? settings.orToken : settings.token);

// Один идентификатор на запись: часы стены плюс монотонные. Два ответа,
// пришедшие в одну миллисекунду, разойдутся вторым слагаемым.
const entryId = () => `${Date.now()}-${Math.round(performance.now())}`;

// Что из записи уходит в мотор: у песни — имя исполнителя, у обычного вопроса
// — сам ответ. Название трека мотору не достаётся: имена исполнителей в квизе
// спрашивают чаще, а на ощупь помещается только одно из двух.
const buzzable = (entry) => (entry?.kind === 'answer' ? entry.title : entry?.artist);

// Запись одной строкой — для журнала и скрытого экрана. У ответа исполнителя
// нет, и приписывать к нему пустое место через тире нечестно.
const entryLine = (entry) => (entry?.kind === 'answer' ? entry.title : `${entry.artist} — ${entry.title}`);

/* --------------------------------------------------------------- статус в UI */

function setStatus(kind, text) {
  el.status.className = `pill pill--${kind}`;
  el.status.textContent = text;
}
function refreshStatus() {
  if (!running) return setStatus('idle', 'Detenido');
  if (inFlight) return setStatus('busy', asksQuestion() ? 'Preguntando…' : 'Reconociendo…');
  // «Suena música» здесь ничего не значило бы: музыка играет и всю паузу между
  // вопросами. Значение имеет нога, её и показываем.
  if (poseGate?.up) return setStatus('music', 'Pierna arriba');
  setStatus('listen', 'Pierna abajo');
}

/* ------------------------------------------------------------- запуск / стоп */

/** Без ключа слушать бессмысленно — ведём к полю, а не молча падаем на первом запросе. */
function promptForToken() {
  showError(asksQuestion()
    ? 'Primero pegue la clave de OpenRouter en los ajustes.'
    : 'Primero pegue la clave de AudD en los ajustes.');
  document.querySelector('.settings').open = true;
  const input = $(asksQuestion() ? 'setOrToken' : 'setToken');
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input.focus();
}

// Ключей два, и не хватать может любого. Показываем тот, без которого нечего
// делать сейчас: второй сервис в этом режиме не спрашивают вовсе, и требовать
// его ключ значит просить то, что ни на что не влияет.
function updateTokenNotice() {
  el.tokenNotice.hidden = asksQuestion() || Boolean(settings.token);
  el.orTokenNotice.hidden = !asksQuestion() || Boolean(settings.orToken);
}

async function start() {
  if (!activeToken()) return promptForToken();
  showError('');
  // Датчик поднимается раньше микрофона: на iOS разрешение на движение дают
  // только из жеста, а к концу запроса микрофона жест уже протух.
  if (!poseReady()) return promptForCalibration();
  if (!await ensurePose()) return;
  poseGate.configure({ axis: settings.poseAxis, minAngle: settings.poseStep });
  poseGate.arm();
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

  session = null;
  running = true;
  // Аудиочасы у нового захвата начинаются с нуля — вместе с ними обнуляется
  // и всё, что от них отсчитывается.
  deafUntil = 0;
  deafFrom = 0;
  deafSec = 0;

  document.body.classList.add('is-running');
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
  if (session) endSession('se ha dejado de escuchar');
  if (capture) { await capture.stop(); capture = null; }
  // Датчик остаётся поднятым только ради калибровки: она идёт при выключенном
  // микрофоне и своим ходом. Всё остальное время он стоит денег батареи и не
  // включает ничего.
  if (!poseGate?.calibrating) stopPose();

  document.body.classList.remove('is-running', 'is-music');
  el.toggle.textContent = 'Empezar a escuchar';
  el.toggle.classList.replace('btn--stop', 'btn--primary');
  el.toggle.disabled = false;
  el.blankBtn.disabled = false;
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

// Мотор трясёт корпус, а микрофон — часть корпуса, и слышно его так, что
// морзянка прошлого ответа заглушает начало следующего вопроса. Поэтому на
// время морзянки приложение глохнет: этих секунд для него не было вовсе, и
// кусок, записанный под вибрацию, в отпечаток не идёт.
//
// Хвост нужен потому, что мотор останавливается не мгновенно: корпус ещё
// звенит после последнего импульса шаблона.
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
  // Начало глухоты держим отдельно от конца, потому что «до deafUntil всё
  // грязное» — неправда. Подтверждение опущенной ноги стучит уже после конца
  // вопроса: сам вопрос записан до него и вибрации не слышал. Продлеваем
  // начало только если оно уже идёт — вторая вибрация внутри первой это та же
  // самая полоса грязи.
  if (!deaf()) deafFrom = capture.audioTime;
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

// Кадр звука. Решать здесь нечего: вопрос открывает и закрывает нога. Кадр
// ведёт часы приложения и, когда подходит срок, отправляет накопленное —
// а срок назначает только повтор сорвавшегося запроса: своих часов у ноги нет.
function onFrame({ samples }) {
  // Ворклет начинает слать звук ещё до того, как start() дойдёт до конца.
  if (!capture) return;
  const dt = samples / capture.sampleRate;

  // В буфер кадр всё равно попал — его туда положил ворклет, до нас. Здесь он
  // просто никого не касается: ни часов, ни расписания.
  if (deaf()) {
    deafSec += dt;
    return;
  }

  if (session && !inFlight && heard() >= session.nextCheckAt) {
    runRecognition();
  } else if (session?.closedAt && !inFlight && !Number.isFinite(session.nextCheckAt)) {
    // Нога опущена, ответ получен или спрашивать больше нечем. Сессия дожила
    // ровно до этого: дальше ей нечего принимать, и закрывать её надо здесь,
    // а не в ответе, — до сюда доходят и промах, и отказ AudD, и пустой клип.
    endSession('');
  }
}

/**
 * Начало вопроса. `at` — момент, когда началось движение ноги, а не когда гейт
 * в нём убедился. Это раньше, чем мы о вопросе узнали, и отступ с длиной
 * фрагмента отмеряются именно оттуда.
 */
function startSession(at, why) {
  // entry живёт на всю сессию, а не на кусок: по нему сверяется, тот же трек
  // ответил или уже другой, и разрыв внутри одного трека не должен плодить
  // в истории вторую запись о нём же.
  session = { entry: null };
  beginSegment(at);
  document.body.classList.add('is-music');
  refreshStatus();
  log('', `${why}, grabando`);
}

/**
 * Новый кусок внутри сессии. Всё, что отсчитывается от начала вопроса,
 * отсчитывается отсюда: и отступ фрагмента, и время начала записи в истории.
 */
function beginSegment(at) {
  const late = Math.max(0, heard() - at);
  session.segmentAt = at;
  // Часы стены по аудиочасам, а не Date.now(): кусок начался раньше, чем мы
  // это подтвердили, и в истории должно стоять его настоящее начало.
  session.segmentAtWall = Date.now() - late * 1000;
  // Третьи часы того же мгновения — аудиочасы. Ими размечен кольцевой буфер,
  // и вырезать из него кусок надо ими: часы приложения отстают от них на всю
  // глухоту, а в буфер морзянка легла наравне со всем остальным.
  session.segmentAtAudio = capture.audioTime - late;
  session.closedAt = null;   // нога ещё не опущена
  session.closeWhy = '';
  session.closeWall = 0;
  session.errors = 0;
  // Часов у вопроса нет: пока нога поднята, он идёт, а отправку назначит её же
  // движение вниз.
  session.nextCheckAt = Infinity;
}

/**
 * Нога опущена: вопрос кончился. Запись на этом заканчивается, а сессия живёт
 * до ответа — ей ещё принимать его, а при сорвавшемся запросе и повторять,
 * причём тем же самым куском: он никуда из буфера не делся.
 *
 * `at` — момент, когда нога пошла вниз, а не когда гейт в этом убедился. Те
 * полторы секунды разницы вопросу уже не принадлежат.
 */
function closeSegment(at, why) {
  const s = session;
  const late = Math.max(0, heard() - at);
  s.closedAt = capture.audioTime - late;
  s.closeWall = Date.now() - late * 1000;
  s.closeWhy = why;
  s.nextCheckAt = heard();   // следующий же кадр и отправит
  document.body.classList.remove('is-music');
  refreshStatus();
  log('', `${why}, pregunta de ${(s.closedAt - s.segmentAtAudio).toFixed(1)} s`);
}

// Промахнулись или узнали — на этом вопрос кончен. Переспрашивать нечем и
// незачем: границу провела нога, кусок в буфере тот же самый, и второй запрос
// ушёл бы за тем же ответом, заплатив за него ещё раз.
function finish(s) {
  s.nextCheckAt = Infinity;
}

function endSession(why = 'la pregunta ha terminado') {
  // Вопрос, закрытый ногой, кончился тогда, когда она опустилась, а не когда
  // пришёл ответ: иначе в историю попала бы и пауза, пока летел запрос.
  if (session?.entry) closeEntry(session.entry, session.closeWall || Date.now());
  session = null;
  document.body.classList.remove('is-music');
  refreshStatus();
  renderNow();
  if (why) log('', why);
}

function closeEntry(entry, at = Date.now()) {
  if (!entry.endWall) {
    entry.endWall = at;
    saveHistory();
    renderHistory();
  }
}

/* ----------------------------------------------------------------------- нога */

// Выключатель у приложения один: нога. Раньше начало вопроса оно искало само,
// по звуку, — и в зале это не работает: между вопросами играет фон, ведущий
// говорит под музыку, и распознавание открывалось там, где спрашивать нечего.
//
// Почему гейт ловит не позу, а переход между позами, откуда взялись пороги и
// зачем калибровка — всё в js/pose.js. Здесь только проводка: датчик, ответы
// гейта и то, во что они превращаются. Микрофон при этом просто пишет: нога
// решает, какой вопрос спрашивать, а фрагмент берётся из буфера.

// Подтверждения ноги. Телефон в кармане, смотреть на экран нельзя — значит,
// сказать «принято» можно только мотором. В работе молчание тоже ответ:
// движение, не прошедшее пороги, не подтверждается ничем, и трясти ногу на
// каждую возню в кармане было бы хуже, чем промолчать.
//
// В калибровке наоборот. Там человек ждёт ответа на каждое движение, и
// молчание неотличимо от «датчик не работает»: он повторяет одно и то же, не
// зная, что именно не так. Поэтому там есть и третий ответ — «не в счёт».
const POSE_BUZZ = {
  step: [120],            // калибровка: движение принято, давай следующее
  done: [400, 150, 400],  // калибровка: ось снята
  // Калибровка: движение разобрано и отброшено. Короче и чаще всего
  // остального: отказ должен читаться как отказ, а не как ещё одно «принято».
  retry: [60, 90, 60, 90, 60],
  up: [120],              // квиз: пишем вопрос
  down: [120, 120, 120],  // квиз: вопрос ушёл в AudD — два коротких против одного
};

// Калибровка ждёт человека, а не наоборот: пока он усаживается и прилаживает
// телефон, минута проходит легко. Но и висеть вечно ей нельзя: брошенная, она
// держит датчик поднятым и жжёт батарею, а на экране остаётся надпись, будто
// чего-то всё ещё ждут. Счёт идёт от последнего разобранного движения, а не от
// нажатия: кто пробует снова и снова, тот калибрует, а не бросил.
const CAL_TIMEOUT_SEC = 120;
let calTimer = 0;

const setPoseCal = (text, tone = '') => {
  const el = $('setPoseCalHint');
  el.textContent = text;
  el.classList.toggle('is-warn', tone === 'warn');
  el.classList.toggle('is-ok', tone === 'ok');
};

/**
 * Какого движения ждут сейчас: 1 — поднять ногу, 2 — опустить, 0 — калибровка
 * не идёт. Сам список висит всегда: его читают до того, как телефон уедет в
 * карман. Подсветка — тем, кто калибрует, глядя на экран.
 *
 * В списке только движения, и потому пройденным помечается лишь то, что телефон
 * подтвердил вибрацией. Укладка в карман не движение: ему её не подтвердить, а
 * гасить строку, которую человек в эту секунду и выполняет, — врать.
 */
function setPoseCalStep(n) {
  const items = $('poseCalSteps').children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('is-now', n > 0 && i === n - 1);
    items[i].classList.toggle('is-done', n > 0 && i < n - 1);
  }
}

/** Без оси гейт видит движение, но не знает, что оно значит. Ведём к кнопке. */
function promptForCalibration() {
  showError('Primero calibre la pierna en los ajustes: sin saber hacia dónde gira el teléfono, '
    + 'levantarla y bajarla son para él el mismo movimiento.');
  document.querySelector('.settings').open = true;
  $('calibratePoseBtn').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Поднять датчик, если он ещё не поднят. Спрашивать разрешение можно из жеста. */
async function ensurePose() {
  if (poseSensor) return true;
  let granted = false;
  try { granted = await PoseSensor.ask(); }
  catch (e) { showError(e.message || 'No se ha podido pedir el acceso a los sensores de movimiento.'); return false; }
  if (!granted) {
    showError('No se ha permitido el acceso a los sensores de movimiento.');
    return false;
  }
  poseGate = new PoseGate({ axis: settings.poseAxis, minAngle: settings.poseStep });
  poseSensor = new PoseSensor((...frame) => {
    const e = poseGate.push(...frame);
    if (e) onPoseStep(e);
  });
  poseSensor.start();
  // Датчика может не быть вовсе, а может не быть только гироскопа — и второе
  // хуже первого, потому что выглядит как рабочий выключатель, который молчит.
  setTimeout(() => {
    if (!poseSensor) return;
    if (!poseSensor.frames) showError('El sensor de movimiento no envía nada: hace falta un teléfono y una conexión https.');
    else if (!poseSensor.hasRotation) showError('Este navegador no da la velocidad de giro: aquí la pierna no puede servir de interruptor.');
  }, 2000);
  return true;
}

function stopPose() {
  poseSensor?.stop();
  poseSensor = null;
  poseGate = null;
  // Датчика больше нет, значит и калибровки нет — как бы она ни кончилась.
  // Оставить кнопку в положении «Cancelar» значило бы обещать движение,
  // которое некому принять.
  endCal();
}

/** Вернуть блок к виду «калибровка не идёт»: кнопка, шаги, общая подсказка. */
function endCal() {
  clearTimeout(calTimer);
  calTimer = 0;
  $('calibratePoseBtn').textContent = 'Calibrar';
  setPoseCalStep(0);
  refreshPoseHint();
}

/** Часы пошли заново: каждое разобранное движение — признак, что калибруют. */
function armCalTimeout() {
  clearTimeout(calTimer);
  calTimer = setTimeout(() => cancelCalibration('se ha agotado el tiempo de espera',
    'Calibración interrumpida: dos minutos sin un solo movimiento. Vuelva a empezar con «Calibrar».'),
    CAL_TIMEOUT_SEC * 1000);
}

/** Свернуть калибровку, не сняв оси. Прежняя, если была, остаётся в силе. */
function cancelCalibration(why, note = '') {
  poseGate?.stopCalibration();
  log('', `calibración de la pierna: ${why}`);
  // При выключенном микрофоне датчик держался только ради калибровки.
  if (running) endCal();
  else stopPose();
  // После endCal, иначе refreshPoseHint затрёт: там своя строка на этот случай.
  if (note) setPoseCal(note, 'warn');
}

async function startCalibration() {
  showError('');
  // Кнопка одна на оба действия: пока калибровка идёт, «Calibrar» уже нажато,
  // и нужно ей ровно противоположное.
  if (poseGate?.calibrating) return cancelCalibration('cancelada');
  if (!await ensurePose()) return;
  poseGate.calibrate();
  armCalTimeout();
  setPoseCalStep(1);
  $('calibratePoseBtn').textContent = 'Cancelar';
  setPoseCal('Ahora guarde el teléfono donde vaya a estar y siéntese como en el concurso; tómese '
    + 'el tiempo que necesite. Ya sentado: quieto un segundo, suba la pierna, quieto otro segundo. '
    + 'El aviso tarda segundo y medio en llegar.');
  log('', 'calibración de la pierna: esperando el primer movimiento');
}

/** Ответ гейта: смена позы, шаг калибровки или причина, по которой не считается. */
function onPoseStep(e) {
  const deg = (v) => `${Math.abs(v).toFixed(1)}°`;

  if (e.verdict === 'calibrating') {
    armCalTimeout();
    poseBuzz(POSE_BUZZ.step);
    setPoseCalStep(2);
    setPoseCal(`Movimiento tomado (${deg(e.along)}). Ahora baje la pierna: quieto un segundo antes `
      + 'y otro después.', 'ok');
    log('', `calibración: pierna levantada, ${deg(e.along)}`);
    return;
  }
  if (e.verdict === 'calibrated') {
    settings.poseAxis = poseGate.axis;
    saveSettings();
    poseBuzz(POSE_BUZZ.done);
    endCal();
    refreshStatus();
    log('ok', `pierna calibrada: al cambiar de postura el teléfono gira ${deg(e.along)}`);
    // Калибруют и при выключенном приложении. Дальше датчику делать нечего:
    // пока никто не слушает, включать ногой нечего.
    if (!running) stopPose();
    return;
  }
  // Отказ в калибровке — половина разговора, и он идёт раньше всего прочего.
  // Калибруют при выключенном микрофоне, а всё, что ниже, отсекается проверкой
  // на `capture`: попади эта ветка туда, движение отбрасывалось бы совсем
  // молча. Сюда доходят только `long` и `small` — остальные вердикты гейт
  // выносит уже после калибровочной ветки.
  if (poseGate?.calibrating) {
    armCalTimeout();
    // Первое длинное движение после нажатия — это укладка в карман: её только
    // что и велели сделать. Ругаться на исполненное указание нельзя, а мотор
    // тут вдобавок стучал бы человеку в руку, пока телефон ещё в ней. Отказом
    // это станет позже: к тому времени карман уже позади.
    if (e.verdict === 'long' && !poseGate.calSteps) {
      setPoseCal('Teléfono guardado. Ahora quédese quieto un segundo y suba la pierna.');
      log('', `calibración: teléfono guardado (${e.moveSec.toFixed(1)} s)`);
      return;
    }
    poseBuzz(POSE_BUZZ.retry);
    setPoseCal(e.verdict === 'long'
      ? `No cuenta: el movimiento ha durado ${e.moveSec.toFixed(1)} s, demasiado para un cambio `
        + 'de postura. Guardar el teléfono en el bolsillo dura eso; la pierna, menos de un segundo. '
        + 'Repítalo, y quédese quieto antes de empezar.'
      : `No cuenta: el teléfono ha girado ${deg(e.angle)} y hacen falta `
        + `${settings.poseStep.toFixed(1)}°. Suba la pierna del todo, o baje el umbral aquí abajo.`,
      'warn');
    log('warn', `calibración: movimiento no contado (${e.verdict}, ${deg(e.angle)}, ${e.moveSec.toFixed(1)} s)`);
    return;
  }
  // Датчик переживает выключенный микрофон: калибруют и при остановленном
  // приложении. Открывать вопрос тогда не на чем — нет ни аудиочасов, ни буфера.
  if (!capture) return;

  // Нога пошла из-под работающего мотора: морзянка прошлого ответа обрывается
  // на полуслове. Иначе её нечем догнать — пока мотор стучит, приложение глухо,
  // и новый вопрос писался бы в тишину. Дослушивать имя незачем: спрашивают уже
  // следующее, а ответ на прошлое и так лежит в журнале.
  if (e.underMotor) {
    stopBuzz();
    log('', `vibración cortada: la pierna se ha movido durante la respuesta (${deg(e.along)})`);
  }

  if (e.verdict === 'up' || e.verdict === 'down') {
    // Ось уточнилась на этой же ступеньке — пусть переживёт вкладку.
    settings.poseAxis = poseGate.axis;
    saveSettings();
  }
  if (e.verdict === 'up') {
    // Прошлый вопрос ещё ждёт ответа — новый его вытесняет. Ответ на старый
    // всё равно дойдёт и попадёт в историю: он ушёл со своим куском, и текущей
    // сессии не касается.
    if (session?.closedAt) endSession('');
    // Вопрос начался тогда, когда нога пошла, а не когда гейт в этом убедился:
    // полторы секунды разницы — это полторы секунды музыки во фрагменте.
    if (!session) {
      startSession(Math.max(0, heard() - e.age), `pierna levantada (${deg(e.along)})`);
      // Подтверждение приходит не в начале вопроса, а тогда, когда гейт разобрал
      // движение, — через 1.3-1.6 с, — и глушит микрофон ещё на 0.62 с. Кусок
      // после этого может начаться только с двух секунд вопроса вместо одной:
      // лишняя секунда с головы, и это самая дешёвая секунда, какая есть. Начало
      // и так худший материал для отпечатка — на то и отступ, — а вопрос теперь
      // уходит целиком, и двадцать секунд превращаются в девятнадцать.
      poseBuzz(POSE_BUZZ.up);
    }
    return;
  }
  if (e.verdict === 'down') {
    // Опускание — это и есть отправка: запись кончилась, кусок целиком лежит
    // в буфере, и уходит он весь, а не отмеренные восемь секунд.
    if (session && !session.closedAt) {
      closeSegment(Math.max(0, heard() - e.age), `pierna bajada (${deg(e.along)})`);
      // Отправляем не дожидаясь кадра: подтверждение сейчас оглушит микрофон
      // почти на секунду, а глухой кадр до планировщика не доходит — ответ
      // опоздал бы ровно на длину собственного подтверждения. Куску это уже
      // безразлично, он весь в буфере и записан до вибрации.
      runRecognition();
      poseBuzz(POSE_BUZZ.down);
    } else log('', 'pierna bajada');
    return;
  }
  // Остальное — в журнал, кроме `small`: это дрожь, и строк от неё было бы
  // больше, чем от всего прочего вместе.
  if (e.verdict === 'across') log('', `giro de ${deg(e.angle)} en otra dirección: la postura no ha cambiado`);
  else if (e.verdict === 'same') log('', `la pierna ya estaba ${poseGate.up ? 'arriba' : 'abajo'}`);
  else if (e.verdict === 'long') log('', `movimiento de ${e.moveSec.toFixed(1)} s: demasiado largo para ser un cambio de postura`);
}

/**
 * Вибрация подтверждения. Мотор трясёт корпус, и для гейта ноги это движение,
 * ничем не хуже настоящего: на время сигнала он слепнет, как микрофон глохнет
 * на морзянку.
 */
function poseBuzz(pattern) {
  if (!navigator.vibrate?.(pattern)) return;
  const ms = pattern.reduce((sum, v) => sum + v, 0);
  poseGate?.blind(ms / 1000 + BUZZ_TAIL_SEC);
  deafen(ms);
}

/* ------------------------------------------------------------- распознавание */

async function runRecognition() {
  if (inFlight || !capture || !session) return;

  // Слепок куска на момент отправки. Пока запрос в полёте, музыка успевает и
  // смолкнуть, и прерваться на секунду: в первом случае сессии больше нет, во
  // втором расписание уже переставлено под следующий вопрос. Ответ и там и там
  // относится к прошлому куску, и трогать по нему текущее расписание нельзя.
  const s = session;
  // Режим тоже снимается слепком: переключатель щёлкают и посреди полёта, а
  // ответ AudD, разобранный как ответ модели, лёг бы в историю записью не того
  // вида.
  const req = { s, seg: s.segmentAt, segWall: s.segmentAtWall, question: asksQuestion() };
  req.live = () => s === session && s.segmentAt === req.seg;

  // Окно фрагмента — по аудиочасам: ими размечен кольцевой буфер.
  //
  // Конец — то мгновение, когда нога пошла вниз; пауза после вопроса в
  // отпечаток не идёт.
  const to = s.closedAt;
  // Начало. Отступ от начала куска — всегда: первые такты худший материал для
  // отпечатка.
  let from = s.segmentAtAudio + LEAD_IN;

  // Ждать нечего: вопрос кончился, и всё, что от него было, уже записано.
  // Значит не ждём, а отрезаем — начало вопроса, если морзянка прошлого ответа
  // ещё стучала поверх него.
  // Дно — начало самого буфера, а не начало куска: в кольце лежат последние
  // BUFFER_SECONDS от «сейчас», и хвост, который мы потом отрежем, место в нём
  // занимает наравне с куском.
  // Отрезаем по вибрации только ту, что попала внутрь куска: морзянка прошлого
  // ответа могла стучать поверх его начала. Подтверждение опускания ноги
  // начинается позже конца вопроса, и резать по нему нечего — иначе от каждого
  // вопроса не оставалось бы ничего.
  const dirtyUntil = deafFrom < to ? deafUntil : 0;
  from = Math.max(from, dirtyUntil, capture.audioTime - BUFFER_SECONDS);

  const seconds = to - from;
  // Хвост, который в кусок не входит: те полторы секунды, за которые гейт
  // убедился, что нога опустилась.
  const clip = seconds >= 1 ? capture.makeClip(seconds, capture.audioTime - to) : null;
  if (!clip) {
    // Второй попытки не будет: кусок в буфере тот же самый и короче не станет.
    // Сказать, что от вопроса ничего не осталось, и закрыть, иначе он так и
    // будет пытаться.
    log('warn', 'la pregunta ha salido demasiado corta o se ha grabado bajo la vibración: no hay nada que enviar');
    finish(s);
    return;
  }

  inFlight = true;
  refreshStatus();
  log('', `enviando ${clip.seconds.toFixed(1)} s (${Math.round(clip.blob.size / 1024)} kB)`, clip.blob);

  try {
    // Без таймаута повисший fetch держит inFlight до собственного таймаута
    // браузера — это минуты, за которые трек успевает кончиться, а приложение
    // всё это время не делает ни одной проверки. Обеим веткам он один и тот же:
    // ждать модель дольше, чем базу отпечатков, незачем — вопрос за это время
    // кончится и там и там.
    const signal = AbortSignal.timeout?.(REQUEST_TIMEOUT * 1000);
    // Клип уходит один и тот же; различается только, кто отвечает и чем —
    // треком или текстом.
    const answer = req.question
      ? await ask(clip.blob, settings.orToken, { signal, system: settings.system })
      : await recognize(clip.blob, settings.token, { signal });
    requests++;
    el.counter.textContent = `${requests} ${plural(requests, 'solicitud', 'solicitudes')}`;
    if (!answer) handleNoMatch(req);
    else if (req.question) handleAnswer(answer, req);
    else handleMatch(answer, req);
  } catch (e) {
    const who = req.question ? 'OpenRouter' : 'AudD';
    log('err',
      e instanceof AudDError || e instanceof AskError ? `${who}: ${e.message}`
      : e.name === 'TimeoutError' ? `${who} no ha respondido en ${REQUEST_TIMEOUT} s`
      : `Red: ${e.message}`);
    // Неверный ключ и исчерпанный лимит сами не рассосутся — повторять их
    // значит просто выкидывать клипы в пустоту до конца раунда. Какие коды
    // такие, знает клиент сервиса: у AudD и у OpenRouter они свои.
    const fatal = e.fatal === true;
    showError(fatal ? e.message : '');
    // Ключ не работает или лимит выбран: запросов больше не будет, а на скрытом
    // экране это неотличимо от тишины в зале. Показываем, в чём дело.
    if (fatal) exitBlank(`${who} ha rechazado la solicitud: pantalla restaurada`);
    if (req.live()) {
      if (fatal) {
        s.nextCheckAt = Infinity;
      } else if (s.errors < ERROR_RETRIES) {
        s.errors++;
        s.nextCheckAt = heard() + ERROR_RETRY_SEC;
        log('warn', `reintento dentro de ${ERROR_RETRY_SEC} s`);
      } else {
        finish(s);
      }
    }
  } finally {
    inFlight = false;
    refreshStatus();
  }
}

function handleMatch(result, req) {
  const key = trackKey(result);
  deliver(req, key, () => makeEntry(result, key, req),
    `sigue siendo «${result.title}»`,
    `${result.artist} — ${result.title}`);
}

/**
 * Ответ модели. Ключ — сам текст: другого признака «тот же ответ или уже
 * другой» у него нет, а он и есть весь ответ целиком.
 */
function handleAnswer(text, req) {
  const key = text.toLowerCase();
  deliver(req, key, () => makeAnswer(text, key, req), 'la misma respuesta', text);
}

/**
 * Что делать с пришедшим ответом — одинаково для песни и для обычного вопроса:
 * тот же он, что и прошлый, или новый; что закрыть в истории; что показать и
 * что отстучать. Различается только то, чем набита запись, — это делает `make`,
 * — и ключ, по которому она сверяется с прошлой: у песни это исполнитель
 * с названием, у ответа сам ответ.
 */
function deliver(req, key, make, sameLog, freshLog) {
  const { s } = req;

  // Сравниваем с последним ответом сессии, а не куска: разрыв мог случиться и
  // внутри трека — на тихом проигрыше, на смене части. Тогда ответ придёт тот
  // же самый, и заводить на него вторую запись в истории не за что.
  if (s.entry && s.entry.key === key) {
    log('ok', sameLog);
  } else {
    // Прошлый трек кончился на границе куска, а не сейчас: иначе его
    // длительность вобрала бы и паузу, и начало этого.
    if (s.entry) closeEntry(s.entry, req.segWall);
    const entry = make();
    s.entry = entry;
    current = entry;
    history.unshift(entry);
    history = history.slice(0, HISTORY_LIMIT);
    saveHistory();
    // Кусок, к которому относится ответ, мог кончиться, пока запрос был в
    // полёте: закрыть запись потом будет уже некому, и в истории она осталась
    // бы играющей вечно. Закрываем сразу — по границе, а не по «сейчас».
    // Ногой конец известен точно — это её движение вниз. У слуха точного нет:
    // берём начало следующего куска, если он уже есть, и «сейчас», если сессии
    // не стало вовсе.
    if (!req.live()) closeEntry(entry, s.closeWall || (s === session ? s.segmentAtWall : Date.now()));
    renderHistory();
    renderNow(true);
    log('ok', freshLog);
    buzzAnswer(buzzable(entry));
    refreshMorseHint(); // в подсказке настроек разбирается последнее имя, а не «Queen»
  }

  if (req.live()) finish(s);
}

/**
 * Ответа нет: у AudD трека не нашлось в базе, у модели вернулся пустой текст.
 * Повторять нечем — вопрос кончился, и второй запрос ушёл бы тем же куском.
 */
function handleNoMatch(req) {
  log('warn', req.question ? 'el modelo no ha contestado nada' : 'sin coincidencias');
  if (req.live()) finish(req.s);
}

// Начало берём из слепка запроса, а не из текущего состояния: пока запрос был
// в полёте, музыка могла смолкнуть или прерваться, и начало трека в истории
// оказалось бы равно моменту распознавания либо началу уже следующего вопроса.
function makeEntry(result, key, req) {
  return {
    id: entryId(),
    kind: 'song',
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

/**
 * Ответ модели — та же запись истории, только пустая почти во всём: ни
 * обложки, ни ссылок, ни исполнителя. Заголовком идёт сам ответ, он же уходит
 * в мотор.
 */
function makeAnswer(text, key, req) {
  return {
    id: entryId(),
    kind: 'answer',
    key,
    title: text,
    artist: '',
    startWall: req.segWall,
    recognizedWall: Date.now(),
    endWall: null,
  };
}

/* -------------------------------------------------------------------- морзе */

// Ответ приходит ровно тогда, когда смотреть на экран нельзя: вопрос ещё идёт,
// телефон лежит экраном вниз или в кармане. Ответ стучится морзянкой и
// узнаётся, не доставая телефон: у трека-вопроса это имя исполнителя, у
// обычного — то, что ответила модель.
//
// Мотор слышно микрофоном, и слышно сильно: на время морзянки приложение
// глохнет целиком, см. «глухота» выше.
let vibrationWarned = false;

// `secret` — тренировка: имя загадано, и в журнале ему не место. Сама строка
// там всё равно нужна, иначе молчащий мотор не отличить от шаблона, который
// браузер не пропустил.
function buzzAnswer(text, { secret = false } = {}) {
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

  const letters = spell(text);
  if (!letters.length) {
    log('', secret ? 'no hay nada que marcar del nombre pensado'
      : text ? `«${text}» no tiene nada que marcar` : 'no hay respuesta que marcar');
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
  // Гейт ноги слепнет на то же самое и по той же причине: десять секунд тряски
  // он прочитал бы как десяток движений, и вопрос закрылся бы сам собой посреди
  // собственного ответа.
  if (sent) poseGate?.blind(ms / 1000 + BUZZ_TAIL_SEC);
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
  poseGate?.see();
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
  return buzzable(current) || buzzable(history[0]) || 'Queen';
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
  buzzAnswer(training.name, { secret: !training.shown });
}

function trainNext() {
  trainPick();
  renderTraining();
  buzzAnswer(training.name, { secret: true });
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
  const answer = current.kind === 'answer';
  el.nowKicker.textContent = answer
    ? (live ? 'Respuesta' : 'Última respuesta')
    : (live ? 'Sonando ahora' : 'Última canción');

  if (current.art) {
    el.nowArt.src = current.art;
    el.nowArt.hidden = false;
    el.nowArtEmpty.hidden = true;
  } else {
    el.nowArt.hidden = true;
    el.nowArtEmpty.hidden = false;
    // Заглушка обложки говорит, чего не хватает. У ответа обложки не бывает
    // вовсе, и нота на её месте обещала бы песню.
    el.nowArtEmpty.textContent = answer ? '?' : '♪';
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
  // Ответ не играет. Счётчик у него остановлен на длине вопроса — на том,
  // сколько его читали, — а бегущее «sonando» значило бы, что вопрос всё ещё
  // идёт, хотя кончился он ровно тогда, когда ушёл на распознавание.
  const ticking = live && current.kind !== 'answer';
  const end = ticking ? Date.now() : (current.endWall ?? current.recognizedWall);
  const played = (end - current.startWall) / 1000;
  const tail = ticking ? `sonando ${dur(played)}` : `${clock(current.startWall)} · ${dur(played)}`;
  const base = el.nowMeta.dataset.base;
  el.nowMeta.textContent = base ? `${base} · ${tail}` : tail;
}

function renderHistory() {
  el.historyEmpty.hidden = history.length > 0;
  el.historyList.innerHTML = history.map((h) => {
    const answer = h.kind === 'answer';
    const played = ((h.endWall ?? (answer ? h.recognizedWall : Date.now())) - h.startWall) / 1000;
    const link = h.links?.[0];
    const time = link
      ? `<a href="${esc(link.url)}" target="_blank" rel="noopener">${clock(h.startWall)}</a>`
      : clock(h.startWall);
    const art = h.art
      ? `<img src="${esc(h.art)}" alt="" loading="lazy">`
      : `<span class="h-art-empty">${answer ? '?' : '♪'}</span>`;
    return `<li${answer ? ' class="is-answer"' : ''}>${art}
      <div class="h-body">
        <div class="h-title">${esc(h.title)}</div>
        ${h.artist ? `<div class="h-artist">${esc(h.artist)}</div>` : ''}
      </div>
      <div class="h-time">${time}<br>${dur(played)}</div>
    </li>`;
  }).join('');
}

// Единственное, что здесь тикает, — счётчик длительности в «Сейчас играет»:
// вопрос идёт, пока нога поднята, и цифра под названием должна идти вместе
// с ним. Всё остальное на экране меняется от событий, а не от кадра.
function render() {
  if (!running) { rafId = 0; return; }
  rafId = requestAnimationFrame(render);
  if (document.hidden || blank) return;
  updateNowTimer();
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
    : inFlight ? (asksQuestion() ? 'preguntando' : 'reconociendo')
    : poseGate?.up ? 'pierna arriba'
    : 'pierna abajo';
  const last = current ? entryLine(current) : 'todavía no se ha reconocido nada';
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

/**
 * Переключатель того, о чём вопрос: два радио, у каждого свой ключ и свои поля.
 * Приложение от него меняется ровно в одном месте — кому уходит клип, — а вся
 * проводка вокруг остаётся той же самой.
 */
function bindAsk() {
  const inputs = [[$('setAskSong'), 'song'], [$('setAskQuestion'), 'question']];
  for (const [input, kind] of inputs) {
    input.checked = settings.ask === kind;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings.ask = kind;
      saveSettings();
      applyAsk();
    });
  }
}

// Ключ второго сервиса и подсказка модели при выбранной песне не значат
// ничего, и наоборот. Оставленные на виду, они читались бы ручками, которые
// почему-то ни на что не влияют.
function refreshAskUI() {
  $('songSettings').hidden = asksQuestion();
  $('questionSettings').hidden = !asksQuestion();
}

/**
 * Сменили, о чём спрашивать. Открытый вопрос уходит вместе с прежним сервисом:
 * клип у него тот же, но отвечать на него теперь некому — и в историю он лёг бы
 * записью не того вида, чем сломал бы и сравнение «тот же ответ или другой».
 */
async function applyAsk() {
  refreshAskUI();
  refreshAskHint();
  updateTokenNotice();
  refreshStatus();
  if (!running) return;
  if (session) endSession('ha cambiado qué se pregunta: pregunta cerrada');
  // Ключа второго сервиса может не быть вовсе. Слушать тогда не за чем: каждый
  // вопрос кончался бы отказом, а на скрытом экране это выглядит тишиной.
  if (!activeToken()) { await stop(); promptForToken(); }
}

// Что выбрано и что из этого следует: меняется только то, кому уходит
// фрагмент и что приходит обратно.
function refreshAskHint() {
  $('setAskHint').textContent = asksQuestion()
    ? 'La pregunta no es una canción: el fragmento se manda entero a un modelo y lo que vuelve es texto. '
      + 'Sirve justo para lo que el reconocimiento de música no puede ni intentar —fechas, nombres, '
      + 'capitales—, porque ahí no hay huella que buscar. Se paga por pregunta, no por cuota.'
    : 'La pregunta es una canción y la reconoce AudD por su huella: de unos segundos de música saca el '
      + 'título y el intérprete. Con las preguntas que no son de música no puede hacer nada —ahí no hay '
      + 'huella que buscar—, y para esas está el otro modo.';
}

// Что сейчас с ногой и что из этого следует. Без калибровки она не решает
// ничего, и молчать об этом нельзя: со стороны это выглядит сломанным
// выключателем, а не невыполненным условием.
function refreshPoseHint() {
  const ready = poseReady();
  $('setPoseHint').textContent = ready
    ? 'Levante la pierna cuando empiece la pregunta: se graba mientras la tenga arriba. Al bajarla, '
      + 'lo grabado se manda a reconocer entero, dure lo que dure — así cada ronda del concurso puede '
      + 'llevar su propio tiempo sin tocar nada. El teléfono lo confirma sin sacarlo del bolsillo: una '
      + 'vibración corta al empezar a grabar, dos al enviar. Si no vibra, el movimiento no ha contado '
      + 'y hay que repetirlo. Si la respuesta anterior todavía está marcándose en morse, levantar la '
      + 'pierna la corta a media palabra: empieza la pregunta nueva.'
    : 'Falta calibrar: sin saber hacia dónde gira el teléfono al levantar la pierna, para él levantarla '
      + 'y bajarla son el mismo movimiento. Hasta entonces no hay con qué abrir una pregunta y la '
      + 'aplicación no llega ni a encender el micrófono.';

  // Пока калибровка идёт, эту строку ведёт она сама: там по шагам сказано,
  // что делать ногой, и затирать это общим описанием нельзя.
  if (!poseGate?.calibrating) {
    setPoseCal(ready
      ? 'Calibrado. Vuelva a hacerlo si cambia de bolsillo o de sitio para el teléfono: lo que se guarda '
        + 'es la dirección del giro, y depende de cómo quede ahí dentro. Con cada cambio de postura '
        + 'la dirección se afina sola, así que una calibración vieja se corrige a los pocos movimientos.'
      : 'Sin calibrar. Léase los dos pasos antes de guardarse el teléfono, porque a partir de '
        + 'ahí la pantalla ya no se ve y todo lo dice el motor.');
  }
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
  // Цена многословия у модели считается в буквах, а буквы отмеряет этот же
  // блок настроек: подсказка под полем должна меняться вместе с ползунком.
  refreshSystemHint();
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
    `Solo alfabeto latino: el cirílico se translitera, cada cifra pasa a ser la letra que le toca por orden en el alfabeto (1 es A, 2 es B, 9 es I; la 3 es S y el 0, O), ` +
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
    `Las cifras se quedan fuera de todo esto: recorren las reglas como cifras y solo al final se vuelven letras, ` +
    `así que ni se colapsan entre sí ni las tocan las demás reglas — 1900 se marca AIOO y no AIO, y 55 sigue siendo EE y no I. ` +
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
    `Se ha elegido la T, una raya sola: quien avisa no es la marca sino la pausa que viene tras ella, así que alargarla no compra nada. ` +
    `Y una marca delante de un nombre que empieza por esa misma letra da dos códigos iguales seguidos: de los 250 del canon empiezan ` +
    `por T siete y por S treinta y dos, así que la T sale tan segura como la O y mucho más corta. ` +
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

// Пара из самой подсказки по умолчанию: тот же вопрос, отвеченный словом и
// отвеченный фразой. Взята оттуда нарочно — читатель увидит её в поле выше
// ровно в этом виде, и разбирать в примере что-то третье значило бы объяснять
// не то, что там написано.
const EG_SHORT = 'París';
const EG_LONG = 'La capital de Francia es París';

// Подсказка модели решает не «как красиво ответить», а поместится ли ответ
// в мотор: до него доходят первые morseLetters букв, и всё, что модель скажет
// до сути, эти буквы и займёт. Поэтому под полем стоит не совет о вежливости,
// а цена многословия, посчитанная на нынешнем числе букв.
function refreshSystemHint() {
  const n = settings.morseLetters;
  // Примеры считаются азбукой, а не переписаны словами: ползунки и галочка над
  // ними меняют ровно то, о чём тут речь, и списанный однажды «ELPLA» разошёлся
  // бы с мотором на первой же правке настроек.
  $('setSystemHint').textContent =
    `Va como system prompt, delante del audio. Aquí se decide si la respuesta se puede leer al tacto: `
    + `al motor solo llegan las ${n} primeras ${plural(n, 'letra', 'letras')} de lo que conteste el modelo. `
    + `«${EG_SHORT}» se marca entero —${morse.word(spell(EG_SHORT))}—; «${EG_LONG}» llega como `
    + `${morse.word(spell(EG_LONG))} y no dice nada. Pedir una respuesta de una `
    + `sola palabra, sin frase alrededor, es lo que hace que quepa: eso es justo lo que pide la indicación `
    + `por defecto, y por eso trae ejemplos en vez de solo pedir brevedad —a secas, el modelo la entiende `
    + `como «una frase corta» y repite la pregunta antes de contestar. Dejar el campo en blanco devuelve `
    + `esa indicación por defecto. `
    + `Los números llegan enteros, pero hay que descifrarlos: cada cifra se marca con la letra que le toca `
    + `por orden en el alfabeto —1 es A, 2 es B, 9 es I; la 3 es S y el 0, O—, y así 1989 llega como `
    + `${morse.word(spell('1989'))} y 1945, como ${morse.word(spell('1945'))}. Al tacto se leen, pero contando `
    + `letras del alfabeto mientras suena la siguiente pregunta: una palabra sigue siendo más barata que un año.`;
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

  const orToken = $('setOrToken');
  orToken.value = settings.orToken;
  orToken.addEventListener('input', () => {
    settings.orToken = orToken.value.trim();
    saveSettings();
    updateTokenNotice();
    if (settings.orToken) showError('');
  });

  const system = $('setSystem');
  system.value = settings.system;
  system.addEventListener('input', () => {
    // Пустое поле — не «без подсказки», а «модель не знает, чего от неё хотят»:
    // в запрос уходит умолчание. Стирать написанное поверх пустоты не за что,
    // здесь так и остаётся пусто — подставляет клиент, при самой отправке.
    settings.system = system.value;
    saveSettings();
    refreshSystemHint();
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
  bindCheck('setMorseMark', 'morseMark', () => { refreshMorseHint(); buzzAnswer(buzzSample()); });
  bindCheck('setMorseTwice', 'morseTwice', () => { refreshMorseHint(); buzzAnswer(buzzSample()); });
  bindCheck('setMorseSimple', 'morseSimple', () => { refreshMorseHint(); buzzAnswer(buzzSample()); });
  for (const id of ['setMorse', 'setMorseLetters', 'setMorseDash', 'setMorseGapSym',
                    'setMorseGapLetter', 'setMorseGapRepeat']) {
    $(id).addEventListener('change', () => buzzAnswer(buzzSample()));
  }
  // Цвет виден сразу, а не со следующего скрытия: галочку щёлкают, чтобы
  // посмотреть, каким экран будет.
  bindCheck('setBlankWhite', 'blankWhite', () => {
    el.blank.classList.toggle('is-white', settings.blankWhite);
    if (blank) setThemeColor(settings.blankWhite ? '#ffffff' : '#000000');
  });
  bindRange('setBlankHold', 'blankHold', (v) => `${v} s`);

  bindAsk();
  bindRange('setPoseStep', 'poseStep', (v) => `${v.toFixed(1)}°`, () => {
    poseGate?.configure({ minAngle: settings.poseStep });
  });
  $('calibratePoseBtn').addEventListener('click', startCalibration);

  refreshMorseHint();
  refreshPoseHint();
  refreshAskUI();
  refreshAskHint();
  refreshSystemHint();

  // Единственный способ узнать, доходит ли вибрация до этого телефона, — не
  // дожидаться трека. Стучит то же, что придёт на распознавание, и на том же
  // имени, что показано в подсказке.
  $('testMorseBtn').addEventListener('click', () => buzzAnswer(buzzSample()));

  $('trainBuzzBtn').addEventListener('click', trainBuzz);
  $('trainShowBtn').addEventListener('click', trainShow);
  $('trainNextBtn').addEventListener('click', trainNext);

  $('resetSettingsBtn').addEventListener('click', () => {
    // Ключ и ось — не настройки, а то, что добыто отдельно: первый выдан
    // сервисом, вторая снята с телефона. Умолчания для них не существует.
    settings = { ...DEFAULTS, token: settings.token, orToken: settings.orToken, poseAxis: settings.poseAxis };
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
if (!activeToken()) document.querySelector('.settings').open = true;
if (!navigator.mediaDevices?.getUserMedia) {
  showError('El navegador no admite la captura de sonido. Hace falta un Chrome, Firefox, Edge o Safari moderno a través de HTTPS.');
  el.toggle.disabled = true;
  el.blankBtn.disabled = true; // прятать нечего: слушать этот браузер всё равно не будет
}
