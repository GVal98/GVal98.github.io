// Клиент api.audd.io. Отдаёт CORS-заголовок `Access-Control-Allow-Origin: *`,
// поэтому клип уходит из браузера напрямую, без своего бэкенда.

const ENDPOINT = 'https://api.audd.io/';
const MAX_BYTES = 10 * 1024 * 1024; // лимит бесплатного эндпоинта

export const ERRORS = {
  300: 'Не удалось построить отпечаток — фрагмент слишком короткий или тихий',
  400: 'Файл больше 10 МБ',
  500: 'Битый аудиофайл',
  700: 'Файл не отправлен',
  900: 'Неверный API-ключ',
  901: 'Исчерпан лимит запросов по ключу',
};

export class AudDError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {Blob} blob   WAV-клип
 * @param {string} token API-ключ
 * @param {object} opts
 * @returns {Promise<object|null>} трек или null, если совпадений нет
 */
export async function recognize(blob, token, { signal, extra = 'apple_music,spotify' } = {}) {
  if (!token) throw new AudDError(900, 'Не задан API-ключ');
  if (blob.size > MAX_BYTES) throw new AudDError(400, ERRORS[400]);

  const form = new FormData();
  form.append('api_token', token);
  form.append('file', blob, 'clip.wav');
  form.append('return', extra);

  const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
  if (!res.ok) throw new AudDError(res.status, `HTTP ${res.status} от api.audd.io`);

  const data = await res.json();
  if (data.status === 'error') {
    const code = data.error?.error_code;
    throw new AudDError(code, ERRORS[code] || data.error?.error_message || 'Ошибка AudD');
  }
  return data.result ?? null;
}

/** Ключ для сравнения «тот же трек или уже другой». */
export function trackKey(result) {
  return `${(result.artist || '').toLowerCase().trim()}::${(result.title || '').toLowerCase().trim()}`;
}

/** Обложка нужного размера — в ответе URL приходит с плейсхолдерами {w}x{h}. */
export function artworkUrl(result, size = 300) {
  const url = result?.apple_music?.artwork?.url;
  if (!url) return null;
  return url.replace('{w}', size).replace('{h}', size);
}

export function links(result) {
  const out = [];
  if (result.song_link) out.push({ name: 'Слушать', url: result.song_link, kind: 'songlink' });
  if (result.spotify?.external_urls?.spotify)
    out.push({ name: 'Spotify', url: result.spotify.external_urls.spotify, kind: 'spotify' });
  if (result.apple_music?.url)
    out.push({ name: 'Apple Music', url: result.apple_music.url, kind: 'apple' });
  return out;
}
