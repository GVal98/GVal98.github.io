// Определение «играет ли музыка» по признакам спектра — без нейросетей.
//
// Четыре признака, каждый закрывает свой класс ложных срабатываний:
//   level — громкость над шумовым полом комнаты (отсекает тишину);
//   tone  — спектральная плоскостность (отсекает шипение, вентилятор, дорогу),
//           входит и слагаемым, и множителем-вето: слагаемого мало, см. ниже;
//   bass  — доля энергии в низах (у музыки бас есть почти всегда, у речи нет);
//   flow  — непрерывность (в речи паузы между фразами, в музыке их нет).

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const INITIAL_FLOOR_DB = -75;  // только до первого честного замера комнаты
const MIN_FLOOR_DB = -95;      // ниже — цифровая тишина, это не измерение
const FLOOR_RISE_DB_PER_SEC = 0.05;
const FLOOR_WINDOW_SEC = 60;   // окно скользящего минимума для подъёма фона
const WARMUP_SEC = 1.5;        // слушаем комнату молча, прежде чем что-то решать
const WARMUP_QUANTILE = 0.25;  // квантиль вместо минимума — устойчиво к выбросам

// Приложение могли включить, когда музыка уже играет. Тогда прогрев примет её
// за фон комнаты, сядет на её уровень — и музыка не будет слышна никогда.
// Такой кадр опознаётся по трём приметам сразу: он громкий, спектр тональный
// и басовитый. Тихая комната тоже бывает «тональной» (почти весь спектр лежит
// на нижней границе анализатора), поэтому громкость в условии обязательна.
const LOUD_START_DB = -50;
const LOUD_START_FLATNESS = 0.12;
const LOUD_START_BASS = 0.10;
const LOUD_START_MARGIN_DB = 22;  // на столько ниже сигнала ставим фон в этом случае
const FLOOR_HOLD_LIMIT_SEC = 600; // предохранитель: фон не морозим навсегда

// Спектр описывает, ЧТО звучит, и осмысленен, только если что-то звучит.
// Не порог, а плавный переход: у музыки размах громкости десятки децибел,
// и жёсткая отсечка обнуляла бы оценку на каждом тихом такте.
const PRESENCE_LO_DB = 3;
const PRESENCE_HI_DB = 9;

/** q-квантиль по копии массива; массив короткий (~35 значений за прогрев). */
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
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
    };

    this.floorDb = INITIAL_FLOOR_DB;
    this.warmupLeft = WARMUP_SEC;
    this.warmupRms = [];   // кадры, похожие на фон
    this.warmupAll = [];   // все кадры прогрева
    this.holdSec = 0;
    this.secMin = Infinity;   // минимум текущей секунды
    this.secLeft = 1;
    this.minWindow = [];      // посекундные минимумы за FLOOR_WINDOW_SEC
    this.activity = [];         // история «кадр активен?» для непрерывности
    this.activityCapacity = 70; // ~3 c
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

    let bassE = 0, fullE = 0;
    for (let i = band.fullLo; i <= band.fullHi; i++) {
      const p = Math.pow(10, this.freq[i] / 10);
      fullE += p;
      if (i >= band.bassLo && i <= band.bassHi) bassE += p;
    }
    const bassRatio = fullE > 0 ? bassE / fullE : 0;

    this._updateFloor(rmsDb, dt, holdFloor, flatness, bassRatio);

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
    const warmingUp = this.warmupLeft > 0;
    const presence = clamp01((snr - PRESENCE_LO_DB) / (PRESENCE_HI_DB - PRESENCE_LO_DB));
    // Тональность обязана быть вето, а не слагаемым. Слагаемым она бессильна:
    // у устойчивого шума flow насыщается в единицу, а если в шуме есть низы
    // (кондиционер, вытяжка, дорога за окном) — то и bass. Вместе это 0.25 + 0.15,
    // уже выше порога 0.35, и tone = 0 ничего не решает: гейт защёлкивается
    // на вентиляторе, фон замерзает и статус «играет музыка» висит минутами.
    // Множителем та же величина работает: у музыки плоскостность 0.02–0.12,
    // вето равно единице и на замеренные сценарии не влияет.
    const toneVeto = clamp01((t.flatnessVeto - flatness) / (t.flatnessVeto - t.flatnessHigh));
    const raw = warmingUp
      ? 0
      : presence * toneVeto * (w.level * level + w.flow * flow + w.tone * tone + w.bass * bass);
    // Сглаживание: у музыки размах громкости десятки децибел, и на отдельных
    // тихих долях оценка проваливается. Гейту нужны 2.5 с подряд выше порога —
    // один провал сбрасывает отсчёт, поэтому усредняем примерно за треть секунды.
    this.score += (raw - this.score) * 0.12;

    return {
      score: this.score, level, tone, bass, flow,
      rmsDb, floorDb: this.floorDb, snr, flatness, bassRatio, warmingUp,
    };
  }

  /**
   * Оценка шумового фона по принципу минимальной статистики: вниз следуем
   * быстро, вверх — медленно и только пока музыка не играет.
   *
   * Симметричное окно тут не работает: за минуту непрерывного трека фон
   * дорос бы до уровня самой музыки, превышение упало бы до нуля и детектор
   * потерял бы песню на середине. По той же причине нельзя пересчитывать фон
   * во время воспроизведения — он должен описывать комнату, а не сигнал.
   *
   * Но и стартовать с константы нельзя: при подъёме 0.6 дБ/с фон добирается
   * до реальной комнаты десятки секунд, всё это время превышение завышено на
   * те же 15–20 дБ, и гейт защёлкивается на тишине за 2.5 с — а дальше фон уже
   * заморожен воспроизведением и разжаться не может. Поэтому первые секунды
   * фон именно измеряется.
   */
  _updateFloor(rmsDb, dt, holdFloor, flatness, bassRatio) {
    // Пока поток не пошёл, приходят кадры цифровой тишины — это не комната.
    if (rmsDb <= MIN_FLOOR_DB) return;

    if (this.warmupLeft > 0) {
      this.warmupLeft -= dt;
      this.warmupAll.push(rmsDb);
      const musical = rmsDb > LOUD_START_DB
        && flatness < LOUD_START_FLATNESS
        && bassRatio > LOUD_START_BASS;
      if (!musical) this.warmupRms.push(rmsDb);
      // Если за весь прогрев не нашлось ни одного немузыкального кадра —
      // музыка играла ещё до запуска. Фон тогда не измерить, ставим его
      // заведомо ниже сигнала, иначе он навсегда останется глух к этому треку.
      this.floorDb = this.warmupRms.length
        ? quantile(this.warmupRms, WARMUP_QUANTILE)
        : quantile(this.warmupAll, WARMUP_QUANTILE) - LOUD_START_MARGIN_DB;
      return;
    }

    this.holdSec = holdFloor ? this.holdSec + dt : 0;

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
    } else if (!holdFloor || this.holdSec > FLOOR_HOLD_LIMIT_SEC) {
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
  constructor({ threshold = 0.55, attackSec = 2.5, releaseSec = 5 } = {}) {
    Object.assign(this, { threshold, attackSec, releaseSec });
    this.playing = false;
    this.aboveSince = null;
    this.belowSince = null;
    this.startedAt = null;
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
      this.belowSince = null;
      if (this.aboveSince === null) this.aboveSince = now;
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
        return 'stop';
      }
    }
    return null;
  }

  reset() {
    this.playing = false;
    this.aboveSince = this.belowSince = this.startedAt = null;
  }
}
