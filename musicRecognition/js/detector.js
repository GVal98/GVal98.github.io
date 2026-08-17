// Определение «играет ли музыка» по признакам спектра — без нейросетей.
//
// Четыре признака, каждый закрывает свой класс ложных срабатываний:
//   level — громкость над шумовым полом комнаты (отсекает тишину);
//   tone  — спектральная плоскостность (отсекает шипение, вентилятор, дорогу);
//   bass  — доля энергии в низах (у музыки бас есть почти всегда, у речи нет);
//   flow  — непрерывность (в речи паузы между фразами, в музыке их нет).

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const INITIAL_FLOOR_DB = -75;  // предположение о тихой комнате до первых измерений
const MIN_FLOOR_DB = -95;      // ниже — цифровая тишина, туда проваливаться нельзя
const FLOOR_RISE_DB_PER_SEC = 0.6;

export const DEFAULT_TUNING = {
  minSnrDb: 8,        // на сколько дБ сигнал должен превышать шумовой пол
  snrRangeDb: 14,     // при таком превышении level = 1
  flatnessLow: 0.05,  // плоскостность музыки
  flatnessHigh: 0.40, // плоскостность шума
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

    this._updateFloor(rmsDb, dt, holdFloor);

    const t = this.tuning;
    const snr = rmsDb - this.floorDb;
    const level = clamp01((snr - t.minSnrDb) / t.snrRangeDb);
    const tone = clamp01((t.flatnessHigh - flatness) / (t.flatnessHigh - t.flatnessLow));
    const bass = clamp01((bassRatio - t.bassLow) / (t.bassHigh - t.bassLow));

    this.activity.push(snr > t.minSnrDb * 0.6 ? 1 : 0);
    if (this.activity.length > this.activityCapacity) this.activity.shift();
    const flow = this.activity.reduce((a, b) => a + b, 0) / this.activity.length;

    const w = t.weights;
    const raw = w.level * level + w.flow * flow + w.tone * tone + w.bass * bass;
    // Лёгкое сглаживание, чтобы одиночный хлопок дверью не дёргал состояние.
    this.score += (raw - this.score) * 0.25;

    return {
      score: this.score, level, tone, bass, flow,
      rmsDb, floorDb: this.floorDb, snr, flatness, bassRatio,
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
   */
  _updateFloor(rmsDb, dt, holdFloor) {
    const observed = Math.max(rmsDb, MIN_FLOOR_DB);
    if (observed < this.floorDb) {
      this.floorDb += (observed - this.floorDb) * 0.15;
    } else if (!holdFloor) {
      this.floorDb = Math.min(this.floorDb + FLOOR_RISE_DB_PER_SEC * dt, observed);
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
