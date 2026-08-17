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

/**
 * Даунсэмплинг усреднением по окну источника — заодно работает
 * как грубый ФНЧ, так что алиасинга после децимации не будет.
 */
export function resample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const from = i * ratio;
    const to = from + ratio;
    const s = Math.floor(from);
    const e = Math.min(Math.ceil(to), input.length);
    let sum = 0;
    for (let j = s; j < e; j++) sum += input[j];
    out[i] = e > s ? sum / (e - s) : 0;
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
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

// Частота, в которую сводим клип перед отправкой. Акустические отпечатки
// живут ниже 5 кГц, так что 16 кГц моно — с запасом, а вес втрое меньше.
export const CLIP_SAMPLE_RATE = 16000;

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

  async start(source = 'mic') {
    // Все три обработки ломают распознавание: шумодав съедает музыку,
    // AGC качает уровень, а эхоподавление вычтет звук собственных колонок.
    const constraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };

    if (source === 'display') {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 },
        audio: constraints,
      });
      if (this.stream.getAudioTracks().length === 0) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        throw new Error(
          'Вкладка расшарена без звука. Повторите и включите «Поделиться аудио вкладки».'
        );
      }
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    }

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

    // Если пользователь снимет шаринг из плашки Chrome — узнаем об этом.
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
        // Захват вкладки часто приходит стерео; сводим в моно до процессора,
        // иначе в буфер попал бы только левый канал.
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

  /**
   * WAV с последними seconds секундами, но не длиннее maxSeconds
   * реально накопленного звука.
   */
  makeClip(seconds) {
    if (!this.ring) return null;
    const want = Math.ceil(seconds * this.ctx.sampleRate);
    const raw = this.ring.readLast(want);
    if (raw.length < this.ctx.sampleRate) return null; // меньше секунды — бессмысленно
    const down = resample(raw, this.ctx.sampleRate, CLIP_SAMPLE_RATE);
    return { blob: encodeWav(down, CLIP_SAMPLE_RATE), seconds: raw.length / this.ctx.sampleRate };
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
