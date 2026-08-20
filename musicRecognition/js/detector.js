// Определение «играет ли музыка» по признакам спектра — без нейросетей.
//
// Пять признаков, каждый закрывает свой класс ложных срабатываний:
//   level — громкость над шумовым полом комнаты (отсекает тишину);
//   tone  — спектральная плоскостность (отсекает шипение, вентилятор, дорогу),
//           входит и слагаемым, и множителем-вето: слагаемого мало, см. ниже;
//   bass  — доля энергии в низах (у музыки бас есть почти всегда, у речи нет);
//   flow  — непрерывность (в речи паузы между фразами, в музыке их нет);
//   dyn   — размах громкости (у музыки он есть всегда, у гула — нет),
//           только множитель-вето, слагаемым не входит.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const INITIAL_FLOOR_DB = -75;  // только до первого честного замера комнаты
const MIN_FLOOR_DB = -95;      // ниже — цифровая тишина, это не измерение
// Вверх фон идёт быстро, потому что расти ему всё равно некуда выше windowMin —
// самого тихого, что мы слышали за минуту. Ограничитель тут именно этот минимум,
// а не скорость. Прежние 0.05 дБ/с ничего дополнительно не защищали, зато делали
// любую ошибку замера вечной: с занижения на 20 дБ фон выбирался бы 7 минут,
// и всё это время превышение было бы завышено ровно на те же 20 дБ.
const FLOOR_RISE_DB_PER_SEC = 3;
const FLOOR_WINDOW_SEC = 60;   // окно скользящего минимума для подъёма фона
// Первые кадры потока — не комната. Микрофон телефона выходит на режим не
// мгновенно, а палец в момент нажатия «Начать» добавляет низкочастотный стук
// в корпус. И то и другое попадает ровно в замер фона и уводит его на десятки
// децибел. Дешевле выкинуть начало потока, чем потом угадывать, что это было.
const SETTLE_SEC = 0.6;
const WARMUP_SEC = 2;          // слушаем комнату молча, прежде чем что-то решать
const WARMUP_QUANTILE = 0.25;  // квантиль вместо минимума — устойчиво к выбросам

// Приложение могли включить, когда музыка уже играет. Тогда прогрев примет её
// за фон комнаты, сядет на её уровень — и музыка не будет слышна никогда.
// Такой кадр опознаётся по трём приметам сразу: он громкий, спектр тональный
// и в нём есть верх. Тихая комната тоже бывает «тональной» (почти весь спектр
// лежит на нижней границе анализатора), поэтому громкость в условии обязательна.
//
// Третьим условием раньше был бас — и это открывало дверь ровно тому, от чего
// защищаемся. Стук по корпусу, ветер, шаги, гул вентиляции — всё это низ и
// только низ: громко, «тонально» и басовито, то есть музыка по всем трём
// приметам. Верх подделать нечем: у замеренной ночной комнаты выше килогерца
// лежит 1.4% энергии, у музыки с телефонного микрофона — 32–84%.
const LOUD_START_DB = -50;
const LOUD_START_FLATNESS = 0.12;
const LOUD_START_HIGH = 0.10;
const LOUD_START_MARGIN_DB = 22;  // на столько ниже сигнала ставим фон в этом случае
const FLOOR_HOLD_LIMIT_SEC = 600; // предохранитель: фон не морозим навсегда

// Спектр описывает, ЧТО звучит, и осмысленен, только если что-то звучит.
// Не порог, а плавный переход: у музыки размах громкости десятки децибел,
// и жёсткая отсечка обнуляла бы оценку на каждом тихом такте.
const PRESENCE_LO_DB = 3;
const PRESENCE_HI_DB = 9;

// Размах громкости за последние секунды. Музыка дышит: доли, паузы, затухания.
// Гул не дышит вовсе — по замерам ночной комнаты с телефона размах держится
// 1.4–2.8 дБ за любое четырёхсекундное окно, у музыки в тех же окнах 2.5–13 дБ.
// Это единственный признак, который не зависит от оценки шумового пола, и
// потому единственный, который остаётся верным, когда пол занижен.
const DYN_WINDOW_SEC = 4;
const DYN_LO_DB = 2;
const DYN_HI_DB = 5;

/** q-квантиль по копии массива; массив короткий (~50 значений за прогрев). */
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Размах между 10-м и 90-м процентилями — устойчив к одиночному щелчку. */
function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return at(0.9) - at(0.1);
}

export const DEFAULT_TUNING = {
  minSnrDb: 8,        // на сколько дБ сигнал должен превышать шумовой пол
  snrRangeDb: 14,     // при таком превышении level = 1
  flatnessLow: 0.05,  // плоскостность музыки
  flatnessHigh: 0.40, // плоскостность шума
  flatnessVeto: 0.55, // выше этого оценка гасится вовсе: это широкополосный шум
  bassLow: 0.03,
  bassHigh: 0.18,
  weights: { level: 0.40, flow: 0.25, tone: 0.20, bass: 0.15 },
};

export class MusicDetector {
  constructor(sampleRate, fftSize, tuning = {}) {
    this.sr = sampleRate;
    this.bins = fftSize / 2;
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
    this.freq = new Float32Array(this.bins);
    this.time = new Float32Array(fftSize);

    const hz = (f) => Math.max(1, Math.min(this.bins - 1, Math.round((f / (sampleRate / 2)) * this.bins)));
    this.band = {
      bassLo: hz(50), bassHi: hz(250),
      toneLo: hz(100), toneHi: hz(6000),
      fullLo: hz(50), fullHi: hz(6000),
      highLo: hz(1000),
    };

    this.floorDb = INITIAL_FLOOR_DB;
    this.settleLeft = SETTLE_SEC;
    this.warmupLeft = WARMUP_SEC;
    this.warmupRms = [];   // кадры, похожие на фон
    this.warmupAll = [];   // все кадры прогрева
    this.startedInMusic = false; // прогрев не нашёл ни одного немузыкального кадра
    this.holdSec = 0;
    this.secMin = Infinity;   // минимум текущей секунды
    this.secLeft = 1;
    this.minWindow = [];      // посекундные минимумы за FLOOR_WINDOW_SEC
    this.activity = [];         // история «кадр активен?» для непрерывности
    this.activityCapacity = 70; // ~3 c
    this.levels = [];           // история rmsDb за DYN_WINDOW_SEC
    this.dynamicsDb = 0;
    this.score = 0;
  }

  /**
   * Один кадр анализа.
   * @param {AnalyserNode} analyser
   * @param {number} dt   длительность кадра в секундах
   * @param {boolean} holdFloor  музыка уже идёт — фон не пересчитывать
   */
  step(analyser, dt = 0.043, holdFloor = false) {
    analyser.getFloatTimeDomainData(this.time);
    analyser.getFloatFrequencyData(this.freq);

    let sumSq = 0;
    for (let i = 0; i < this.time.length; i++) sumSq += this.time[i] * this.time[i];
    const rms = Math.sqrt(sumSq / this.time.length);
    const rmsDb = 20 * Math.log10(rms + 1e-10);

    const { band } = this;
    let logSum = 0, toneSum = 0, toneN = 0;
    for (let i = band.toneLo; i <= band.toneHi; i++) {
      const p = Math.pow(10, this.freq[i] / 10) + 1e-12;
      logSum += Math.log(p);
      toneSum += p;
      toneN++;
    }
    const flatness = Math.exp(logSum / toneN) / (toneSum / toneN);

    let bassE = 0, highE = 0, fullE = 0;
    for (let i = band.fullLo; i <= band.fullHi; i++) {
      const p = Math.pow(10, this.freq[i] / 10);
      fullE += p;
      if (i >= band.bassLo && i <= band.bassHi) bassE += p;
      if (i >= band.highLo) highE += p;
    }
    const bassRatio = fullE > 0 ? bassE / fullE : 0;
    const highRatio = fullE > 0 ? highE / fullE : 0;

    // Кадры установления в историю не идут: стук по корпусу — это всплеск,
    // и он завысил бы размах ровно там, где размах служит защитой.
    const settling = this.settleLeft > 0;
    if (!settling) {
      const capacity = Math.max(8, Math.round(DYN_WINDOW_SEC / dt));
      this.levels.push(rmsDb);
      while (this.levels.length > capacity) this.levels.shift();
      // На неполном окне размах занижен просто потому, что данных мало; пока
      // окно не набрано хотя бы наполовину, честнее считать его нулевым —
      // оценка всё равно обнулена прогревом.
      this.dynamicsDb = this.levels.length >= capacity / 2 ? spread(this.levels) : 0;
    }

    this._updateFloor(rmsDb, dt, holdFloor, flatness, highRatio);

    const t = this.tuning;
    const snr = rmsDb - this.floorDb;
    const level = clamp01((snr - t.minSnrDb) / t.snrRangeDb);
    const tone = clamp01((t.flatnessHigh - flatness) / (t.flatnessHigh - t.flatnessLow));
    const bass = clamp01((bassRatio - t.bassLow) / (t.bassHigh - t.bassLow));

    this.activity.push(snr > t.minSnrDb * 0.6 ? 1 : 0);
    if (this.activity.length > this.activityCapacity) this.activity.shift();
    const flow = this.activity.reduce((a, b) => a + b, 0) / this.activity.length;

    const w = t.weights;
    // Спектральные признаки описывают, ЧТО звучит, и осмысленны, только если
    // вообще что-то звучит. Тихая комната сама по себе «тональна» (почти весь
    // спектр лежит на нижней границе анализатора, торчат пара бугров от гула)
    // и «басовита» — вместе это 0.35 веса ни за что. Отсюда множитель присутствия.
    const warmingUp = settling || this.warmupLeft > 0;
    const presence = clamp01((snr - PRESENCE_LO_DB) / (PRESENCE_HI_DB - PRESENCE_LO_DB));
    // Тональность обязана быть вето, а не слагаемым. Слагаемым она бессильна:
    // у устойчивого шума flow насыщается в единицу, а если в шуме есть низы
    // (кондиционер, вытяжка, дорога за окном) — то и bass. Вместе это 0.25 + 0.15,
    // уже выше порога 0.35, и tone = 0 ничего не решает: гейт защёлкивается
    // на вентиляторе, фон замерзает и статус «играет музыка» висит минутами.
    // Множителем та же величина работает: у музыки плоскостность 0.02–0.12,
    // вето равно единице и на замеренные сценарии не влияет.
    const toneVeto = clamp01((t.flatnessVeto - flatness) / (t.flatnessVeto - t.flatnessHigh));
    // Второе вето — по размаху громкости. Присутствие держится на оценке
    // шумового пола, а пол — единственное, что можно измерить неправильно:
    // хватит стука в момент старта или микрофона, выходящего на режим, и
    // комната объявляется на 20 дБ громче себя. Тогда level, flow и presence
    // разом уходят в единицу, а tone и bass у тихой комнаты и без того единица —
    // оценка 100% на пустом месте. Размах громкости этой ошибке не подвержен:
    // он считается по разности уровней, и общий сдвиг пола из него сокращается.
    const dyn = clamp01((this.dynamicsDb - DYN_LO_DB) / (DYN_HI_DB - DYN_LO_DB));
    const raw = warmingUp
      ? 0
      : presence * toneVeto * dyn * (w.level * level + w.flow * flow + w.tone * tone + w.bass * bass);
    // Сглаживание: у музыки размах громкости десятки децибел, и на отдельных
    // тихих долях оценка проваливается. Гейту нужны 2.5 с подряд выше порога —
    // один провал сбрасывает отсчёт, поэтому усредняем примерно за треть секунды.
    this.score += (raw - this.score) * 0.12;

    return {
      score: this.score, level, tone, bass, flow, dyn,
      rmsDb, floorDb: this.floorDb, snr, flatness, bassRatio, highRatio,
      dynamicsDb: this.dynamicsDb, warmingUp, startedInMusic: this.startedInMusic,
    };
  }

  /**
   * Оценка шумового фона по принципу минимальной статистики: вниз следуем
   * за сигналом, вверх — только до самого тихого, что слышали за минуту,
   * и только пока музыка не играет.
   *
   * Симметричное окно тут не работает: за минуту непрерывного трека фон
   * дорос бы до уровня самой музыки, превышение упало бы до нуля и детектор
   * потерял бы песню на середине. По той же причине нельзя пересчитывать фон
   * во время воспроизведения — он должен описывать комнату, а не сигнал.
   *
   * Но и стартовать с константы нельзя: пока фон ползёт к реальной комнате,
   * превышение завышено на все 15–20 дБ, и гейт защёлкивается на тишине за
   * 2.5 с — а дальше фон уже заморожен воспроизведением. Поэтому первые
   * секунды фон именно измеряется, а не угадывается.
   *
   * И всё же замер может выйти неверным — микрофон в этот момент только
   * выходит на режим. Поэтому у ошибки должен быть выход: подъём быстрый
   * (ограничитель тут windowMin, а не скорость), а заморозка снимается,
   * как только сигнал перестаёт быть похожим на живой звук.
   */
  _updateFloor(rmsDb, dt, holdFloor, flatness, highRatio) {
    // Пока поток не пошёл, приходят кадры цифровой тишины — это не комната.
    if (rmsDb <= MIN_FLOOR_DB) return;

    // Микрофон ещё выходит на режим, а по корпусу только что стукнули пальцем.
    if (this.settleLeft > 0) {
      this.settleLeft -= dt;
      return;
    }

    if (this.warmupLeft > 0) {
      this.warmupLeft -= dt;
      this.warmupAll.push(rmsDb);
      const musical = rmsDb > LOUD_START_DB
        && flatness < LOUD_START_FLATNESS
        && highRatio > LOUD_START_HIGH;
      if (!musical) this.warmupRms.push(rmsDb);
      // Если за весь прогрев не нашлось ни одного немузыкального кадра —
      // музыка играла ещё до запуска. Фон тогда не измерить, ставим его
      // заведомо ниже сигнала, иначе он навсегда останется глух к этому треку.
      this.startedInMusic = this.warmupRms.length === 0;
      this.floorDb = this.startedInMusic
        ? quantile(this.warmupAll, WARMUP_QUANTILE) - LOUD_START_MARGIN_DB
        : quantile(this.warmupRms, WARMUP_QUANTILE);
      return;
    }

    // Заморозка фона нужна, только пока звучит что-то живое. Стоячий сигнал
    // музыкой не бывает, а если гейт на нём всё-таки защёлкнулся, заморозка
    // замыкает ошибку на себя: фон занижен → «играет музыка» → фон заморожен
    // → фон занижен, и так до конца сессии. Размах громкости эту петлю рвёт.
    const alive = this.dynamicsDb >= DYN_LO_DB;
    this.holdSec = holdFloor && alive ? this.holdSec + dt : 0;
    const frozen = holdFloor && alive && this.holdSec <= FLOOR_HOLD_LIMIT_SEC;

    // Скользящий минимум за минуту. Подниматься фон может только к самому
    // тихому, что мы слышали недавно, а не к текущему уровню: иначе непрерывная
    // музыка постепенно объявляет фоном сама себя и становится не слышна.
    this.secMin = Math.min(this.secMin, rmsDb);
    this.secLeft -= dt;
    if (this.secLeft <= 0) {
      this.minWindow.push(this.secMin);
      if (this.minWindow.length > FLOOR_WINDOW_SEC) this.minWindow.shift();
      this.secMin = Infinity;
      this.secLeft = 1;
    }
    const windowMin = Math.min(this.secMin, ...this.minWindow);

    if (rmsDb < this.floorDb) {
      this.floorDb += (rmsDb - this.floorDb) * 0.15;
    } else if (!frozen) {
      this.floorDb = Math.min(this.floorDb + FLOOR_RISE_DB_PER_SEC * dt, windowMin);
    }
  }

  /** Значения спектра 0..1 для рисования — logarithmic по частоте. */
  spectrum(out) {
    const n = out.length;
    for (let i = 0; i < n; i++) {
      // Логарифмическая раскладка: низы не сжимаются в пару пикселей.
      const lo = Math.floor(Math.pow(this.bins, i / n));
      const hi = Math.max(lo + 1, Math.floor(Math.pow(this.bins, (i + 1) / n)));
      let max = -140;
      for (let j = lo; j < hi && j < this.bins; j++) if (this.freq[j] > max) max = this.freq[j];
      out[i] = clamp01((max + 100) / 70);
    }
    return out;
  }
}

/**
 * Гистерезис вокруг порога: вход в состояние «музыка» требует attackSec
 * подряд выше порога, выход — releaseSec подряд ниже. Без этого пауза
 * между куплетами обрывала бы сессию, а случайный шум начинал новую.
 */
export class MusicGate {
  constructor({ threshold = 0.55, attackSec = 2.5, releaseSec = 5, dipSec = 1.5 } = {}) {
    Object.assign(this, { threshold, attackSec, releaseSec, dipSec });
    this.playing = false;
    this.aboveSince = null;
    this.belowSince = null;
    this.startedAt = null;
    // Начало текущего непрерывного куска музыки. От startedAt отличается тем,
    // что переставляется и внутри сессии — на каждом провале длиннее dipSec.
    // Нужно для случая, когда сессия не кончается там, где кончается трек:
    // в паузе между вопросами играет фон, оценка проваливается на пару секунд,
    // но до releaseSec не дотягивает, и гейт держит одну сессию на весь раунд.
    // Провал при этом виден, и следующий кусок музыки — уже другой трек.
    this.segmentAt = null;
  }

  configure(opts) { Object.assign(this, opts); }

  /**
   * @param {number} score оценка кадра
   * @param {number} now   время по аудиочасам, секунды
   * @returns {'start'|'stop'|null}
   */
  step(score, now) {
    const above = score >= this.threshold;

    if (above) {
      // Провал короче dipSec — тихий такт, затакт, вдох между куплетами:
      // кусок музыки продолжается. Длиннее — считаем, что это уже другая музыка.
      if (this.belowSince !== null && now - this.belowSince >= this.dipSec) this.segmentAt = null;
      this.belowSince = null;
      if (this.aboveSince === null) this.aboveSince = now;
      if (this.segmentAt === null) this.segmentAt = this.aboveSince;
      if (!this.playing && now - this.aboveSince >= this.attackSec) {
        this.playing = true;
        // Начало трека — момент, когда уровень пошёл вверх, а не когда
        // мы это подтвердили. Клип потом берём с запасом назад.
        this.startedAt = this.aboveSince;
        return 'start';
      }
    } else {
      this.aboveSince = null;
      if (this.belowSince === null) this.belowSince = now;
      if (this.playing && now - this.belowSince >= this.releaseSec) {
        this.playing = false;
        this.startedAt = null;
        this.segmentAt = null;
        return 'stop';
      }
    }
    return null;
  }

  reset() {
    this.playing = false;
    this.aboveSince = this.belowSince = this.startedAt = this.segmentAt = null;
  }
}
