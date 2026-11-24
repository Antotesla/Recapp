// Chiamate ai servizi AI gratuiti: Google Gemini (principale) e Groq (riserva).

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ = 'https://api.groq.com/openai/v1';
const MAX_INLINE_BYTES = 14 * 1024 * 1024; // Gemini: max 20 MB per richiesta, base64 +33%

export class ApiError extends Error {
  constructor(message, { status = 0, retryAfter = null, provider = '' } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.provider = provider;
  }
  get rateLimited() { return this.status === 429; }
}

// ---------- Schemi di risposta ----------

const T = (type, extra = {}) => ({ type, ...extra });
const STR = T('STRING');
const ARR = items => T('ARRAY', { items });
const OBJ = (properties, required = Object.keys(properties)) =>
  T('OBJECT', { properties, required, propertyOrdering: Object.keys(properties) });
const PRIO = T('STRING', { enum: ['alta', 'media', 'bassa'] });

const NOTE_SCHEMA = OBJ({
  trascrizione: STR,
  sintesi: STR,
  priorita: PRIO,
  da_fare: ARR(OBJ({ cosa: STR, scadenza: STR })),
  domande_per_me: ARR(STR),
  decisioni: ARR(STR),
  info_utili: ARR(STR),
});

const DIGEST_SCHEMA = OBJ({
  panoramica: STR,
  da_fare: ARR(OBJ({ cosa: STR, scadenza: STR, priorita: PRIO, vocali: ARR(T('INTEGER')) })),
  domande_per_me: ARR(OBJ({ domanda: STR, vocali: ARR(T('INTEGER')) })),
  cambi_di_programma: ARR(STR),
  decisioni: ARR(STR),
  info_utili: ARR(STR),
});

// Esempio JSON ricavato dallo schema, per i modelli senza output strutturato (Groq).
function shape(s) {
  if (s.type === 'OBJECT') return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, shape(v)]));
  if (s.type === 'ARRAY') return [shape(s.items)];
  if (s.type === 'INTEGER') return 1;
  return s.enum ? s.enum.join('|') : '...';
}

// Garantisce che tutti i campi attesi esistano col tipo giusto.
function normalize(v, s) {
  if (s.type === 'OBJECT') {
    const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    return Object.fromEntries(Object.entries(s.properties).map(([k, sub]) => [k, normalize(o[k], sub)]));
  }
  if (s.type === 'ARRAY') return Array.isArray(v) ? v.map(x => normalize(x, s.items)) : [];
  if (s.type === 'INTEGER') return Number.isFinite(+v) ? Math.round(+v) : 0;
  const str = v == null ? '' : String(v);
  return s.enum && !s.enum.includes(str) ? s.enum[1] : str;
}

// ---------- Prompt ----------

const fmtDate = ms => new Date(ms).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const contextLine = s => s.context?.trim()
  ? `Contesto del lavoro del collaboratore (usalo per capire cosa è rilevante): ${s.context.trim()}`
  : '';

function noteSystem(note, s, withTranscript) {
  return [
    'Ricevi un messaggio vocale WhatsApp che il capo ha inviato a un suo collaboratore. Lavori per il collaboratore: devi fargli risparmiare tempo senza fargli perdere niente di importante.',
    withTranscript
      ? '1. "trascrizione": ti viene già fornita, ricopiala così com\'è.'
      : '1. "trascrizione": trascrivi fedelmente TUTTO il vocale nella lingua originale, con punteggiatura e a capo tra un argomento e l\'altro. Togli solo esitazioni e intercalari ("ehm", "cioè cioè"). Non riassumere e non inventare: se un passaggio non si capisce scrivi [incomprensibile].',
    '2. "sintesi": una o due frasi con il succo del messaggio.',
    '3. "priorita": "alta" se c\'è qualcosa di urgente, con scadenza entro 48 ore, o se il capo si aspetta una risposta rapida; "bassa" se è solo informativo o chiacchiera; altrimenti "media".',
    '4. "da_fare": ogni azione concreta che il collaboratore deve fare. "cosa" inizia con un verbo all\'infinito ed è comprensibile da sola (chi, cosa, per quale cliente o progetto). "scadenza": se il capo indica un tempo riportalo; se è relativo ("domani", "venerdì") aggiungi tra parentesi la data esatta calcolata dalla data del vocale; stringa vuota se non c\'è.',
    '5. "domande_per_me": domande o richieste di conferma a cui il collaboratore deve rispondere al capo.',
    '6. "decisioni": decisioni, cambi di programma o indicazioni definitive date dal capo.',
    '7. "info_utili": informazioni da sapere per lavorare (nomi, numeri, importi, indirizzi, orari, contatti, riferimenti). Riporta i dati esatti.',
    'Non ripetere la stessa informazione in più campi. Lascia vuoti gli elenchi se non c\'è nulla. Ignora saluti, sfoghi e divagazioni non operative.',
    `Data del vocale: ${fmtDate(note.receivedAt)}${note.timeKnown ? `, ore ${fmtTime(note.receivedAt)}` : ''}.`,
    contextLine(s),
  ].filter(Boolean).join('\n');
}

function digestSystem(day, s) {
  const [y, m, d] = day.split('-').map(Number);
  return [
    'Ricevi tutti i vocali che il capo ha mandato al collaboratore in una giornata, già trascritti e analizzati uno per uno e numerati in ordine cronologico. Prepara un unico riepilogo operativo della giornata.',
    '- Unisci le cose ripetute in più vocali: ogni attività e ogni domanda deve comparire una sola volta.',
    '- Se un vocale successivo corregge o annulla qualcosa detto prima, vale l\'ultima versione; segnala il cambiamento in "cambi_di_programma" (es. "Riunione con Rossi spostata da martedì a giovedì (#3 → #7)").',
    '- "vocali": i numeri dei vocali da cui proviene ogni punto.',
    '- "da_fare": ordina per priorità (alta per prima) e poi per scadenza.',
    '- "panoramica": 2-4 frasi su cosa conta davvero oggi.',
    '- Non aggiungere niente che non sia nei vocali.',
    `Data: ${fmtDate(new Date(y, m - 1, d).getTime())}.`,
    contextLine(s),
  ].filter(Boolean).join('\n');
}

// ---------- Utilità HTTP ----------

const wait = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = e.status >= 500 || (e.rateLimited && (e.retryAfter ?? 10) <= 60);
      if (i >= tries || !transient) throw e;
      await wait(((e.retryAfter ?? 5 * i) + 1) * 1000);
    }
  }
}

function friendly(provider, status, raw) {
  const r = String(raw || '');
  if (status === 429) return `Limite gratuito di ${provider} raggiunto per ora.`;
  if (status === 401 || /API_KEY_INVALID|api key not valid|invalid api key/i.test(r)) return `Chiave ${provider} non valida: controllala nelle impostazioni.`;
  if (status === 403) return `${provider} ha rifiutato la richiesta (permessi o paese non supportato): ${r}`;
  if (status === 404) return `Modello ${provider} non trovato: scegline un altro nelle impostazioni.`;
  if (status >= 500) return `${provider} è sovraccarico o non disponibile, riprova tra poco.`;
  if (!status) return `Impossibile contattare ${provider}: controlla la connessione.`;
  return `${provider}: ${r || 'errore ' + status}`;
}

async function call(provider, url, init) {
  let r;
  try { r = await fetch(url, init); } catch { throw new ApiError(friendly(provider, 0), { provider }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const details = j.error?.details || [];
    const ri = details.find(d => String(d['@type']).includes('RetryInfo'));
    let retryAfter = ri ? parseFloat(ri.retryDelay) : parseFloat(r.headers.get('retry-after'));
    if (!Number.isFinite(retryAfter)) retryAfter = null;
    throw new ApiError(friendly(provider, r.status, j.error?.message), { status: r.status, retryAfter, provider });
  }
  return j;
}

const parseJson = (text, provider) => {
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {
    throw new ApiError(`${provider} ha restituito una risposta non leggibile, riprova.`, { provider });
  }
};

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

// ---------- Gemini ----------

async function gemini(s, system, parts, schema) {
  const model = (s.geminiModel || 'gemini-flash-latest').replace(/^models\//, '');
  const j = await call('Gemini', `${GEMINI}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(s.geminiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
    }),
  });
  const c = j.candidates?.[0];
  const text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text) throw new ApiError(`Gemini non ha risposto (${c?.finishReason || j.promptFeedback?.blockReason || 'motivo sconosciuto'}).`, { provider: 'Gemini' });
  return parseJson(text, 'Gemini');
}

export async function listGeminiModels(key) {
  const j = await call('Gemini', `${GEMINI}/models?pageSize=1000&key=${encodeURIComponent(key)}`, {});
  return (j.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
}

async function geminiNote(note, s) {
  if (note.size > MAX_INLINE_BYTES) throw new ApiError('Vocale troppo grande per Gemini (oltre 14 MB).', { provider: 'Gemini' });
  const data = await blobToBase64(note.blob);
  return gemini(s, noteSystem(note, s, false), [
    { inlineData: { mimeType: note.mime, data } },
    { text: 'Analizza questo vocale.' },
  ], NOTE_SCHEMA);
}

// ---------- Groq ----------

const groqHeaders = s => ({ Authorization: `Bearer ${s.groqKey}` });

async function groqChat(s, system, user, schema) {
  const j = await call('Groq', `${GROQ}/chat/completions`, {
    method: 'POST',
    headers: { ...groqHeaders(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: s.groqChat || 'llama-3.3-70b-versatile',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}\n\nRispondi SOLO con un oggetto JSON con esattamente questa struttura:\n${JSON.stringify(shape(schema))}` },
        { role: 'user', content: user },
      ],
    }),
  });
  return parseJson(j.choices?.[0]?.message?.content || '', 'Groq');
}

async function groqNote(note, s) {
  const ext = /ogg|opus/.test(note.mime) ? 'ogg' : (note.name.split('.').pop() || 'ogg');
  const fd = new FormData();
  fd.append('file', new File([note.blob], `vocale.${ext}`, { type: note.mime }));
  fd.append('model', s.groqWhisper || 'whisper-large-v3-turbo');
  fd.append('language', 'it');
  fd.append('response_format', 'json');
  const { text } = await call('Groq', `${GROQ}/audio/transcriptions`, { method: 'POST', headers: groqHeaders(s), body: fd });
  const out = await groqChat(s, noteSystem(note, s, true), `Trascrizione del vocale:\n\n${text}`, NOTE_SCHEMA);
  return { ...out, trascrizione: text };
}

// ---------- API pubblica ----------

async function firstWorking(s, viaGemini, viaGroq, schema) {
  const errors = [];
  if (s.geminiKey) {
    try { return { provider: 'Gemini', result: normalize(await withRetry(viaGemini), schema) }; } catch (e) { errors.push(e); }
  }
  if (s.groqKey) {
    try { return { provider: 'Groq', result: normalize(await withRetry(viaGroq), schema) }; } catch (e) { errors.push(e); }
  }
  if (!errors.length) throw new ApiError('Inserisci la chiave Gemini nelle impostazioni (⚙︎).');
  const err = new ApiError(errors.map(e => e.message).join(' '), {
    status: errors.every(e => e.rateLimited) ? 429 : errors[0].status,
    retryAfter: errors[0].retryAfter,
  });
  throw err;
}

export function analyzeNote(note, s) {
  return firstWorking(s, () => geminiNote(note, s), () => groqNote(note, s), NOTE_SCHEMA);
}

// items: [{ n, ora, trascrizione, sintesi, da_fare, ... }]
export function makeDigest(items, day, s) {
  const system = digestSystem(day, s);
  const user = `Vocali della giornata (JSON):\n${JSON.stringify(items)}`;
  return firstWorking(s, () => gemini(s, system, [{ text: user }], DIGEST_SCHEMA), () => groqChat(s, system, user, DIGEST_SCHEMA), DIGEST_SCHEMA);
}
