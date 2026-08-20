// Захват звука, кольцевой буфер PCM и кодирование в WAV.

const WORKLET_SRC = `
class TapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = (options.processorOptions && options.processorOptions.chunkSize) || 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('tap', TapProcessor);
`;

/** Кольцевой буфер последних N секунд моно-PCM. */
class RingBuffer {
  constructor(capacity) {
    this.data = new Float32Array(capacity);
    this.w = 0;
    this.written = 0;
  }

  push(chunk) {
    const { data } = this;
    const cap = data.length;
    if (chunk.length >= cap) {
      data.set(chunk.subarray(chunk.length - cap));
      this.w = 0;
      this.written += chunk.length;
      return;
    }
    const tail = cap - this.w;
    if (chunk.length <= tail) {
      data.set(chunk, this.w);
    } else {
      data.set(chunk.subarray(0, tail), this.w);
      data.set(chunk.subarray(tail), 0);
    }
    this.w = (this.w + chunk.length) % cap;
    this.written += chunk.length;
  }

  /** Последние n сэмплов в хронологическом порядке. */
  readLast(n) {
    const cap = this.data.length;
    const count = Math.min(n, this.written, cap);
    const out = new Float32Array(count);
    let start = this.w - count;
    if (start >= 0) {
      out.set(this.data.subarray(start, start + count));
    } else {
      start += cap;
      const head = cap - start;
      out.set(this.data.subarray(start, cap), 0);
      out.set(this.data.subarray(0, count - head), head);
    }
    return out;
  }
}

const FIR_HALF_AT_3X = 16; // полуширина ядра при прореживании ровно втрое
const PHASES = 128;        // на столько шагов дробится задержка внутри отсчёта

/**
 * Банк ядер ФНЧ на PHASES дробных сдвигов центра.
 *
 * Ядро приходится готовить заранее: синусов в нём (2·half+1)·PHASES, а считать
 * их заново для каждого выходного отсчёта было бы на порядок дороже самой
 * свёртки. Зато сама свёртка потом идёт по таблице.
 */
function polyphaseBank(cutoffRatio, half) {
  const taps = half * 2 + 1;
  const bank = new Float32Array(PHASES * taps);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = t - half - frac;
      const sinc = Math.abs(x) < 1e-9
        ? 2 * cutoffRatio
        : Math.sin(2 * Math.PI * cutoffRatio * x) / (Math.PI * x);
      // Окно привязано к номеру отвода, а не к x: иначе оно съезжало бы вместе
      // с синком и полоса пропускания гуляла бы от фазы к фазе.
      bank[p * taps + t] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * t) / (taps - 1)));
      sum += bank[p * taps + t];
    }
    // Нормировка на фазу, а не на всё ядро: иначе на дробных сдвигах усиление
    // по постоянному току чуть плавает и появляется низкочастотная модуляция.
    for (let t = 0; t < taps; t++) bank[p * taps + t] /= sum;
  }
  return bank;
}

/**
 * Пересчёт частоты с ФНЧ и дробной задержкой — в обе стороны.
 *
 * Две ловушки, обе замерены на тонах:
 *
 * 1. Усреднение по окну источника фильтрует слишком слабо: у бокскара из трёх
 *    отсчётов на 10 кГц всего −6 дБ, и всё выше новой частоты Найквиста
 *    заворачивается обратно в 0–8 кГц — ровно поверх полосы отпечатка.
 *
 * 2. Брать ближайший целый отсчёт вместо дробного центра — это не «дрожание
 *    в десяток микросекунд», а посэмпловый джиттер, то есть паразитная фазовая
 *    модуляция. При 48 кГц отношение ровно 3, дробной части не возникает и всё
 *    выглядит чисто; при 44100 (ratio 2.75625) дробная часть пробегает 160 фаз,
 *    и на 5 кГц спуры вылезали на −13 дБ от несущей. Отсюда банк дробных сдвигов.
 */
export function resample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  // При повышении частоты прореживать нечего: ядро давит не заворот, а образы
  // выше входного Найквиста, и срез остаётся привязанным к входу. Отсюда
  // Math.max(1, ratio) в обеих формулах — на upsampling обе дают ветку «ratio 1».
  const decim = Math.max(1, ratio);
  // Переходная полоса окна Хэмминга — около 3.3/taps от входной частоты. При
  // фиксированной длине ядра и большом ratio она шире, чем расстояние до зоны
  // заворота, и фильтр до неё просто не дотягивается (на 96 кГц алиас давился
  // всего на −21 дБ). Держим полосу пропорциональной прореживанию.
  const half = Math.max(8, Math.round((FIR_HALF_AT_3X * decim) / 3));
  const taps = half * 2 + 1;
  // Срез с запасом ниже выходного Найквиста: у фильтра конечной длины спад
  // не отвесный, и посадить край ровно на 8 кГц значит пропустить его половину.
  const bank = polyphaseBank(0.45 / decim, half);

  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const n = input.length;
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    let base = Math.floor(center);
    let p = Math.round((center - base) * PHASES);
    if (p === PHASES) { p = 0; base++; } // округление вверх переносит в следующий отсчёт
    const off = p * taps + half - base;
    const lo = Math.max(0, base - half);
    const hi = Math.min(n - 1, base + half);
    let acc = 0;
    for (let j = lo; j <= hi; j++) acc += input[j] * bank[off + j];
    out[i] = acc;
  }
  return out;
}

export function encodeWav(samples, sampleRate) {
  const bytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const ascii = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // моно
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    // Округление, а не усечение: setInt16 отбрасывает дробную часть в сторону
    // нуля, а это лишний младший разряд ошибки (−6 дБ к шуму квантования)
    // плюс постоянное смещение в полразряда.
    view.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

// Частота, в которую сводим клип перед отправкой.
//
// Полоса отпечатка и правда лежит ниже 5 кГц, но решает не она, а то, как AudD
// разбирает присланный файл. Один и тот же клип с микрофона (−26 dBFS RMS,
// 10 с) на 16 кГц не опознаётся, а на 8, 22.05, 32, 44.1 и 48 кГц — опознаётся;
// каждая точка проверена запросом к API, провал на 16 кГц воспроизводится. Тот
// же клип, поднятый с 16 кГц обратно до 44.1, опознаётся снова — значит дело не
// в потерянной полосе, а именно в частоте заголовка. Студийная запись 16 кГц
// переживает: запас по SNR у неё есть, у микрофонной — нет.
//
// Поэтому клип уходит на своей частоте, и трогаем её только на краях.
const CLIP_MAX_RATE = 48000;  // выше не проверяли — не поднимаем туда вслепую
const BAD_RATE = 16000;       // ровно её отдаёт Bluetooth-гарнитура в mSBC
const SAFE_RATE = 44100;      // куда уводим с провальной

/** Частота, на которой отправляем клип, снятый контекстом на ctxRate. */
export function clipRate(ctxRate) {
  if (ctxRate > CLIP_MAX_RATE) return CLIP_MAX_RATE;
  if (ctxRate === BAD_RATE) return SAFE_RATE;
  return ctxRate;
}

export class AudioCapture {
  /**
   * @param {object} opts
   * @param {number} opts.bufferSeconds  глубина кольцевого буфера
   * @param {(features: {analyser: AnalyserNode, samples: number}) => void} opts.onFrame
   */
  constructor({ bufferSeconds = 30, onFrame } = {}) {
    this.bufferSeconds = bufferSeconds;
    this.onFrame = onFrame;
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.ring = null;
    this.node = null;
    this.source = null;
    this.totalSamples = 0;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  /** Время в секундах от старта захвата, посчитанное по сэмплам (не по таймеру). */
  get audioTime() {
    return this.ctx ? this.totalSamples / this.ctx.sampleRate : 0;
  }

  async start() {
    // Все три обработки ломают распознавание: шумодав съедает музыку,
    // AGC качает уровень, а эхоподавление вычтет звук собственных колонок.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.3;
    this.source.connect(this.analyser);

    this.ring = new RingBuffer(Math.ceil(this.bufferSeconds * this.ctx.sampleRate));
    this.totalSamples = 0;

    await this._attachTap();

    // Микрофон могут выдернуть из разъёма или отобрать другим приложением.
    this.stream.getTracks().forEach((t) => {
      t.onended = () => this.onTrackEnded && this.onTrackEnded();
    });
  }

  async _attachTap() {
    const handle = (chunk) => {
      this.ring.push(chunk);
      this.totalSamples += chunk.length;
      // Кадр детектора привязан к приходу звука, а не к setInterval:
      // таймеры в фоновой вкладке душатся до 1 Гц, аудиопоток — нет.
      if (this.onFrame) this.onFrame({ analyser: this.analyser, samples: chunk.length });
    };

    if (this.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.node = new AudioWorkletNode(this.ctx, 'tap', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        // Часть устройств отдаёт стерео вопреки channelCount: 1; сводим в моно
        // до процессора, иначе в буфер попал бы только левый канал.
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { chunkSize: 2048 },
      });
      this.node.port.onmessage = (e) => handle(new Float32Array(e.data));
      this.source.connect(this.node);
      return;
    }

    // Запасной путь для старых движков без AudioWorklet.
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.channelCount = 1;
    this.node.channelCountMode = 'explicit';
    this.node.onaudioprocess = (e) => handle(new Float32Array(e.inputBuffer.getChannelData(0)));
    this.source.connect(this.node);
    // ScriptProcessor не тикает, пока не подключён к выходу; глушим гейном.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this._mute = mute;
  }

  /** WAV с последними seconds секундами — или меньше, если столько ещё не накопилось. */
  makeClip(seconds) {
    if (!this.ring) return null;
    const want = Math.ceil(seconds * this.ctx.sampleRate);
    const raw = this.ring.readLast(want);
    if (raw.length < this.ctx.sampleRate) return null; // меньше секунды — бессмысленно
    // В заголовок идёт та частота, в которой клип реально лежит, — иначе он
    // воспроизводится не на своей скорости и AudD не найдёт ничего.
    const rate = clipRate(this.ctx.sampleRate);
    const pcm = resample(raw, this.ctx.sampleRate, rate);
    return { blob: encodeWav(pcm, rate), seconds: raw.length / this.ctx.sampleRate };
  }

  async stop() {
    if (this.node) {
      if (this.node.port) this.node.port.onmessage = null;
      this.node.onaudioprocess = null;
      try { this.node.disconnect(); } catch { /* уже отключён */ }
    }
    if (this._mute) { try { this._mute.disconnect(); } catch { /* уже отключён */ } }
    if (this.source) { try { this.source.disconnect(); } catch { /* уже отключён */ } }
    if (this.stream) this.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (this.ctx) await this.ctx.close();
    this.ctx = this.stream = this.analyser = this.node = this.source = this.ring = null;
    this._mute = null;
  }
}
