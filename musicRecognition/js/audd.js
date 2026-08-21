// Клиент api.audd.io. Отдаёт CORS-заголовок `Access-Control-Allow-Origin: *`,
// поэтому клип уходит из браузера напрямую, без своего бэкенда.

const ENDPOINT = 'https://api.audd.io/';
const MAX_BYTES = 10 * 1024 * 1024; // лимит бесплатного эндпоинта

export const ERRORS = {
  300: 'No se ha podido crear la huella: el fragmento es demasiado corto o demasiado bajo',
  400: 'El archivo supera los 10 MB',
  500: 'Archivo de audio dañado',
  700: 'No se ha enviado el archivo',
  900: 'Clave de API no válida',
  901: 'Se ha agotado el límite de solicitudes de la clave',
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
  if (!token) throw new AudDError(900, 'No se ha indicado la clave de API');
  if (blob.size > MAX_BYTES) throw new AudDError(400, ERRORS[400]);

  const form = new FormData();
  form.append('api_token', token);
  form.append('file', blob, 'clip.wav');
  form.append('return', extra);

  const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
  if (!res.ok) throw new AudDError(res.status, `HTTP ${res.status} de api.audd.io`);

  const data = await res.json();
  if (data.status === 'error') {
    const code = data.error?.error_code;
    throw new AudDError(code, ERRORS[code] || data.error?.error_message || 'Error de AudD');
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
  if (result.song_link) out.push({ name: 'Escuchar', url: result.song_link, kind: 'songlink' });
  if (result.spotify?.external_urls?.spotify)
    out.push({ name: 'Spotify', url: result.spotify.external_urls.spotify, kind: 'spotify' });
  if (result.apple_music?.url)
    out.push({ name: 'Apple Music', url: result.apple_music.url, kind: 'apple' });
  return out;
}
