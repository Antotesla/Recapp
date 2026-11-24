import * as db from './db.js';
import { analyzeNote, makeDigest, listGeminiModels } from './ai.js';

// ---------- Impostazioni ----------

const DEFAULTS = {
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  groqKey: '',
  groqWhisper: 'whisper-large-v3-turbo',
  groqChat: 'llama-3.3-70b-versatile',
  context: '',
  autoDigest: true,
  keepAudioDays: 14,
};
const SETTINGS_KEY = 'recapp.settings';

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { toast('Impossibile salvare le impostazioni su questo browser.'); }
}
let settings = loadSettings();
const hasKey = () => Boolean(settings.geminiKey || settings.groqKey);

// ---------- Utilità ----------

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const today = () => dayOf(Date.now());
const shiftDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); return dayOf(new Date(y, m - 1, d + n).getTime()); };
const fmtTime = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function fmtDay(day) {
  const t = today();
  if (day === t) return 'Oggi';
  if (day === shiftDay(t, -1)) return 'Ieri';
  const [y, m, d] = day.split('-').map(Number);
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('it-IT', opts);
}

const byOrder = (a, b) => (a.day.localeCompare(b.day)) || ((a.seq ?? 1e9) - (b.seq ?? 1e9)) || (a.receivedAt - b.receivedAt) || (a.addedAt - b.addedAt);

let toastTimer;
function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const AUDIO_EXT = /\.(opus|ogg|oga|m4a|mp3|wav|aac|flac|webm|mp4)$/i;
const isAudio = f => /^audio\//.test(f.type) || f.type === 'application/ogg' || AUDIO_EXT.test(f.name || '');

function guessMime(f) {
  const ext = (f.name || '').split('.').pop().toLowerCase();
  const t = (f.type || '').toLowerCase().split(';')[0];
  if (['opus', 'ogg', 'oga'].includes(ext) || /ogg|opus/.test(t)) return 'audio/ogg';
  if (ext === 'mp3' || t === 'audio/mpeg') return 'audio/mp3';
  if (ext === 'wav' || /wav/.test(t)) return 'audio/wav';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'aac') return 'audio/aac';
  if (['m4a', 'mp4'].includes(ext) || /m4a|mp4/.test(t)) return 'audio/mp4';
  if (ext === 'webm') return 'audio/webm';
  return t.startsWith('audio/') ? t : 'audio/ogg';
}

// I vocali WhatsApp si chiamano tipo "PTT-20261124-WA0012.opus":
// da lì ricaviamo il giorno e l'ordine di arrivo.
function parseName(name = '', lastModified) {
  const m = name.match(/(20\d{2})(\d{2})(\d{2})[-_ ]?WA(\d+)/i);
  if (m) {
    const base = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    const sameDay = lastModified && dayOf(lastModified) === dayOf(base);
    return { at: sameDay ? lastModified : base, timeKnown: false, seq: +m[4] };
  }
  return { at: lastModified || Date.now(), timeKnown: false, seq: null };
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// ---------- Stato ----------

let currentDay = today();
let query = '';
let running = false;
let progress = null; // { done, total }
const digestBusy = new Set();
const expanded = new Set();

// ---------- Acquisizione vocali ----------

async function ingest(files) {
  let added = 0, dup = 0, skipped = 0, lastDay = null;
  for (const f of files) {
    if (!isAudio(f)) { skipped++; continue; }
    const buf = await f.arrayBuffer();
    const hash = hex(await crypto.subtle.digest('SHA-256', buf));
    if ((await db.byIndex('notes', 'hash', hash)).length) { dup++; continue; }
    const meta = parseName(f.name, f.lastModified);
    const mime = guessMime(f);
    await db.put('notes', {
      id: crypto.randomUUID(),
      hash,
      name: f.name || 'vocale',
      mime,
      blob: new Blob([buf], { type: mime }),
      size: buf.byteLength,
      receivedAt: meta.at,
      timeKnown: meta.timeKnown,
      seq: meta.seq,
      day: dayOf(meta.at),
      addedAt: Date.now(),
      status: 'queued',
    });
    added++;
    lastDay = dayOf(meta.at);
  }
  const parts = [];
  if (added) parts.push(`${added} ${added === 1 ? 'vocale aggiunto' : 'vocali aggiunti'}`);
  if (dup) parts.push(`${dup} già presenti`);
  if (skipped) parts.push(`${skipped} non audio, ignorati`);
  if (parts.length) toast(parts.join(' · '));
  if (lastDay) { currentDay = lastDay; query = ''; $('#search').value = ''; }
  await render();
  runQueue();
}

async function drainInbox() {
  const items = await db.takeInbox();
  if (!items.length) return;
  await ingest(items.map(it => new File([it.blob], it.name || 'vocale.opus', { type: it.type || it.blob.type, lastModified: it.lastModified || Date.now() })));
}

// ---------- Elaborazione ----------

async function runQueue() {
  if (running || !hasKey()) return;
  running = true;
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* non disponibile */ }
  const touched = new Set();
  try {
    let queue = (await db.all('notes')).filter(n => n.status === 'queued');
    progress = { done: 0, total: queue.length };
    while (queue.length) {
      const n = queue.sort(byOrder)[0];
      n.status = 'processing';
      n.error = null;
      await db.put('notes', n);
      await render();
      try {
        const { result, provider } = await analyzeNote(n, settings);
        Object.assign(n, { result, provider, status: 'done', processedAt: Date.now() });
        touched.add(n.day);
      } catch (e) {
        if (e.rateLimited) {
          n.status = 'queued';
          await db.put('notes', n);
          toast(`${e.message} I vocali restano in coda: riprova più tardi.`, 8000);
          break;
        }
        n.status = 'error';
        n.error = e.message;
      }
      await db.put('notes', n);
      progress.done++;
      await render();
      queue = (await db.all('notes')).filter(x => x.status === 'queued');
      progress.total = progress.done + queue.length;
    }
  } finally {
    running = false;
    progress = null;
    try { await wake?.release(); } catch { /* già rilasciato */ }
    await render();
  }
  if (settings.autoDigest) for (const d of touched) await buildDigest(d);
}

async function dayNotes(day) {
  return (await db.byIndex('notes', 'day', day)).sort(byOrder);
}

async function buildDigest(day) {
  const notes = await dayNotes(day);
  const items = [];
  notes.forEach((n, i) => {
    if (n.status !== 'done') return;
    const { trascrizione, sintesi, priorita, da_fare, domande_per_me, decisioni, info_utili } = n.result;
    items.push({ n: i + 1, ora: n.timeKnown ? fmtTime(n.receivedAt) : undefined, sintesi, priorita, da_fare, domande_per_me, decisioni, info_utili, trascrizione });
  });
  if (!items.length) return;
  digestBusy.add(day);
  await render();
  try {
    const prev = await db.get('digests', day);
    const { result, provider } = await makeDigest(items, day, settings);
    // Mantiene le spunte sulle attività già fatte, se ricompaiono.
    const prevTasks = prev?.result?.da_fare || [];
    const done = {};
    result.da_fare.forEach((t, i) => {
      const j = prevTasks.findIndex(p => norm(p.cosa) === norm(t.cosa));
      if (j >= 0 && prev.done?.[j]) done[i] = true;
    });
    await db.put('digests', { day, result, provider, generatedAt: Date.now(), noteIds: notes.filter(n => n.status === 'done').map(n => n.id), done });
  } catch (e) {
    toast(`Riepilogo non generato: ${e.message}`, 8000);
  } finally {
    digestBusy.delete(day);
    await render();
  }
}

// Cancella l'audio dei vocali vecchi, tenendo i testi.
async function purgeOldAudio() {
  const limit = shiftDay(today(), -Math.max(1, +settings.keepAudioDays || DEFAULTS.keepAudioDays));
  for (const n of await db.all('notes')) {
    if (n.blob && n.status === 'done' && n.day < limit) {
      n.blob = null;
      n.audioPurged = true;
      await db.put('notes', n);
    }
  }
}

// ---------- Rendering ----------

function list(title, items, cls = '') {
  if (!items?.length) return '';
  return `<div class="block ${cls}"><h3>${esc(title)}</h3><ul>${items.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
}
const refs = v => (v?.length ? ` <span class="ref">${v.map(n => `#${n}`).join(' ')}</span>` : '');
const prioBadge = p => (p ? `<span class="badge prio-${esc(p)}">${esc(p)}</span>` : '');

function renderOnboarding(notes) {
  const el = $('#onboarding');
  if (hasKey() && notes.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = !hasKey() ? `
    <h2>Benvenuto in Recapp</h2>
    <ol>
      <li>Crea una chiave gratuita su <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> (“Create API key”).</li>
      <li>Incollala nelle <a href="#" data-act="settings">impostazioni ⚙︎</a> e descrivi in due righe il tuo lavoro.</li>
      <li>Da WhatsApp tieni premuto uno o più vocali → <b>Condividi</b> → <b>Recapp</b> (su Android, dopo aver installato l’app). In alternativa usa “＋ Vocali”.</li>
    </ol>
    <button class="btn primary" data-act="settings">Apri impostazioni</button>`
    : `
    <h2>Pronto</h2>
    <p>Da WhatsApp tieni premuto uno o più vocali → <b>Condividi</b> → <b>Recapp</b>. Puoi selezionarne tanti insieme. Oppure usa “＋ Vocali”.</p>`;
}

async function renderDigest(notes) {
  const el = $('#digest');
  if (query) { el.innerHTML = ''; return; }
  const doneNotes = notes.filter(n => n.status === 'done');
  const dg = await db.get('digests', currentDay);
  const busy = digestBusy.has(currentDay);
  if (!dg && !doneNotes.length) { el.innerHTML = ''; return; }

  if (!dg) {
    el.innerHTML = `<div class="card"><div class="card-head"><h2>Riepilogo della giornata</h2></div>
      <p class="meta">${busy ? '<span class="spinner"></span> Sto preparando il riepilogo…' : 'Unisce tutti i vocali del giorno, elimina le ripetizioni e segnala i cambi di programma.'}</p>
      ${busy ? '' : '<button class="btn primary" data-act="digest">Genera riepilogo</button>'}</div>`;
    return;
  }

  const r = dg.result;
  const newCount = doneNotes.filter(n => !dg.noteIds.includes(n.id)).length;
  const removed = dg.noteIds.some(id => !doneNotes.find(n => n.id === id));
  const stale = (newCount || removed) && !busy
    ? `<div class="stale"><span>${newCount ? `${newCount} ${newCount === 1 ? 'vocale nuovo' : 'vocali nuovi'} non ${newCount === 1 ? 'incluso' : 'inclusi'}` : 'Vocali modificati'}</span><button class="btn small primary" data-act="digest">Aggiorna</button></div>` : '';
  const tasks = r.da_fare.length ? `<div class="block"><h3>Da fare</h3><ul class="tasks">${r.da_fare.map((t, i) => `
      <li class="${dg.done?.[i] ? 'done' : ''}">
        <input type="checkbox" data-act="task" data-i="${i}" ${dg.done?.[i] ? 'checked' : ''} aria-label="Fatto">
        <div><div class="task-text">${esc(t.cosa)}</div>
          <div class="task-meta">${prioBadge(t.priorita)}${t.scadenza ? `<span class="due">⏰ ${esc(t.scadenza)}</span>` : ''}${refs(t.vocali)}</div></div>
      </li>`).join('')}</ul></div>` : '';

  el.innerHTML = `<div class="card">
    <div class="card-head"><h2>Riepilogo della giornata</h2>
      ${busy ? '<span class="meta"><span class="spinner"></span> aggiorno…</span>' : `<button class="btn small" data-act="digest">↻</button><button class="btn small" data-act="copy">Copia</button>`}
    </div>
    ${stale}
    ${r.panoramica ? `<p class="panoramica">${esc(r.panoramica)}</p>` : ''}
    ${tasks}
    ${list('Devi rispondere a', r.domande_per_me.map(q => esc(q.domanda) + refs(q.vocali)))}
    ${list('Cambi di programma', r.cambi_di_programma.map(esc), 'changes')}
    ${list('Decisioni', r.decisioni.map(esc))}
    ${list('Info utili', r.info_utili.map(esc))}
    <p class="meta" style="margin-top:12px">Aggiornato alle ${fmtTime(dg.generatedAt)} · ${esc(dg.provider)}</p>
  </div>`;
}

function highlight(text) {
  const t = esc(text);
  if (!query) return t;
  const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
}

function noteHTML(n, num) {
  const r = n.result;
  const statusLine = {
    queued: '<span class="meta">In coda</span>',
    processing: '<span class="meta"><span class="spinner"></span> Trascrivo e riassumo…</span>',
    error: '<span class="badge prio-alta">errore</span>',
    done: prioBadge(r?.priorita),
  }[n.status];
  const when = query ? fmtDay(n.day) : (n.timeKnown ? fmtTime(n.receivedAt) : '');
  const head = `<button class="note-head" data-act="toggle" aria-expanded="${expanded.has(n.id)}">
    <div class="note-line"><span class="num">${query ? '' : '#' + num}</span><span class="grow">${esc(when)}</span>${statusLine}</div>
    ${r ? `<div class="note-sintesi">${highlight(r.sintesi)}</div>` : `<div class="note-sintesi meta">${esc(n.name)}</div>`}
    ${n.status === 'error' ? `<div class="err">${esc(n.error)}</div>` : ''}
  </button>`;
  if (!expanded.has(n.id)) return head;
  const body = r ? `
    ${list('Da fare', r.da_fare.map(t => esc(t.cosa) + (t.scadenza ? ` <span class="due">⏰ ${esc(t.scadenza)}</span>` : '')))}
    ${list('Devi rispondere a', r.domande_per_me.map(esc))}
    ${list('Decisioni', r.decisioni.map(esc))}
    ${list('Info utili', r.info_utili.map(esc))}
    <details ${query ? 'open' : ''}><summary>Trascrizione completa</summary><p class="transcript">${highlight(r.trascrizione)}</p></details>` : '';
  const audio = n.blob ? '<div class="audio-slot"></div>' : (n.audioPurged ? '<p class="meta">Audio cancellato per liberare spazio.</p>' : '');
  return `${head}<div class="note-body">${audio}${body}
    <div class="note-actions">
      ${n.blob && n.status !== 'processing' ? `<button class="btn small" data-act="retry">${n.status === 'done' ? 'Rielabora' : 'Riprova'}</button>` : ''}
      <button class="btn small danger" data-act="delete">Elimina</button>
      <span class="meta" style="align-self:center">${esc(n.name)}${n.provider ? ' · ' + esc(n.provider) : ''}</span>
    </div></div>`;
}

// Le schede vengono ridisegnate solo se cambiano, così l'audio in ascolto non si interrompe.
const cards = new Map();
function renderNotes(notes) {
  const container = $('#notes');
  const els = notes.map((n, i) => {
    const sig = [n.status, n.error, n.processedAt, expanded.has(n.id), i, query, n.audioPurged].join('|');
    let c = cards.get(n.id);
    if (!c || c.sig !== sig) {
      const el = c?.el || Object.assign(document.createElement('article'), { className: 'note' });
      el.dataset.id = n.id;
      el.querySelector('audio')?.src && URL.revokeObjectURL(el.querySelector('audio').src);
      el.innerHTML = noteHTML(n, i + 1);
      const slot = el.querySelector('.audio-slot');
      if (slot && n.blob) {
        const a = document.createElement('audio');
        a.controls = true;
        a.preload = 'metadata';
        a.src = URL.createObjectURL(n.blob);
        slot.replaceWith(a);
      }
      c = { sig, el };
      cards.set(n.id, c);
    }
    return c.el;
  });
  for (const [id, c] of cards) if (!notes.find(n => n.id === id)) { c.el.remove(); cards.delete(id); }
  const same = els.length === container.children.length && els.every((el, i) => container.children[i] === el);
  if (!same) container.replaceChildren(...els);

  if (!notes.length) {
    container.innerHTML = query
      ? '<div class="empty"><p>Nessun vocale trovato.</p></div>'
      : `<div class="empty"><p>Nessun vocale per questo giorno.</p><p class="meta">Condividili da WhatsApp o usa “＋ Vocali”.</p></div>`;
  }
}

function renderStatus(allNotes) {
  const queued = allNotes.filter(n => n.status === 'queued').length;
  let text = '';
  if (running && progress) text = `Elaboro ${Math.min(progress.done + 1, progress.total)} di ${progress.total}…`;
  else if (queued && !hasKey()) text = `${queued} in coda · manca la chiave`;
  else if (queued) text = `${queued} in coda`;
  $('#status').textContent = text;
}

let renderPending = null;
let renderAgain = false;
function render() {
  // Evita rendering sovrapposti; se arriva una richiesta durante un rendering, ne fa un altro alla fine.
  if (renderPending) { renderAgain = true; return renderPending; }
  renderPending = (async () => {
    try {
      do {
        renderAgain = false;
        await doRender();
      } while (renderAgain);
    } finally {
      renderPending = null;
    }
  })();
  return renderPending;
}

async function doRender() {
    {
      const allNotes = await db.all('notes');
      let notes;
      if (query) {
        const q = norm(query);
        notes = allNotes
          .filter(n => norm([n.name, n.result?.sintesi, n.result?.trascrizione].join(' ')).includes(q))
          .sort((a, b) => byOrder(b, a));
      } else {
        notes = allNotes.filter(n => n.day === currentDay).sort(byOrder);
      }
      $('#daynav').hidden = Boolean(query);
      $('#day-label').textContent = fmtDay(currentDay);
      $('#day-next').disabled = currentDay >= today();
      $('#notes-title').textContent = query ? `Risultati (${notes.length})` : (notes.length ? `Vocali (${notes.length})` : '');
      renderOnboarding(allNotes);
      renderStatus(allNotes);
      await renderDigest(notes);
      renderNotes(notes);
    }
}

// ---------- Copia riepilogo ----------

async function copyDigest() {
  const dg = await db.get('digests', currentDay);
  if (!dg) return;
  const r = dg.result;
  const sec = (t, a) => (a.length ? `\n${t}\n${a.map(x => `• ${x}`).join('\n')}\n` : '');
  const text = [
    `Riepilogo vocali – ${fmtDay(currentDay)}`,
    r.panoramica ? `\n${r.panoramica}\n` : '',
    sec('DA FARE', r.da_fare.map((t, i) => `${dg.done?.[i] ? '[x] ' : '[ ] '}${t.cosa}${t.scadenza ? ` (entro: ${t.scadenza})` : ''}`)),
    sec('DEVI RISPONDERE A', r.domande_per_me.map(q => q.domanda)),
    sec('CAMBI DI PROGRAMMA', r.cambi_di_programma),
    sec('DECISIONI', r.decisioni),
    sec('INFO UTILI', r.info_utili),
  ].join('');
  try {
    await navigator.clipboard.writeText(text);
    toast('Riepilogo copiato');
  } catch {
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else toast('Copia non riuscita');
  }
}

// ---------- Impostazioni (dialog) ----------

const dlg = $('#settings');
const form = $('#settings-form');

function openSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const input = form.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(v); else input.value = v;
  }
  $('#models-status').textContent = '';
  dlg.showModal();
}

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save') return;
  for (const k of Object.keys(DEFAULTS)) {
    const input = form.elements[k];
    if (!input) continue;
    settings[k] = input.type === 'checkbox' ? input.checked
      : input.type === 'number' ? (parseInt(input.value, 10) || DEFAULTS[k])
      : input.value.trim();
  }
  if (!settings.geminiModel) settings.geminiModel = DEFAULTS.geminiModel;
  saveSettings();
  toast('Impostazioni salvate');
  await render();
  runQueue();
});

$('#btn-models').addEventListener('click', async () => {
  const key = form.elements.geminiKey.value.trim();
  const out = $('#models-status');
  if (!key) { out.textContent = 'Inserisci prima la chiave.'; return; }
  out.textContent = 'Verifico…';
  try {
    const models = await listGeminiModels(key);
    $('#gemini-models').innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    const flash = models.filter(m => /flash/i.test(m.id) && !/lite|image|tts|live|audio/i.test(m.id)).map(m => m.id);
    out.textContent = `Chiave valida ✓ ${models.length} modelli disponibili. Consigliati (veloci e gratuiti): ${flash.slice(0, 4).join(', ') || '—'}. Tocca il campo Modello per sceglierne uno.`;
  } catch (e) {
    out.textContent = e.message;
  }
});

// ---------- Eventi ----------

$('#btn-settings').addEventListener('click', openSettings);
$('#file-input').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await ingest(files);
});
$('#day-prev').addEventListener('click', () => { currentDay = shiftDay(currentDay, -1); render(); });
$('#day-next').addEventListener('click', () => { if (currentDay < today()) { currentDay = shiftDay(currentDay, 1); render(); } });
$('#day-label').addEventListener('click', () => { currentDay = today(); render(); });

let searchTimer;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = e.target.value.trim(); render(); }, 200);
});

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = t.closest('.note')?.dataset.id;
  if (act === 'settings') { e.preventDefault(); openSettings(); }
  else if (act === 'digest') buildDigest(currentDay);
  else if (act === 'copy') copyDigest();
  else if (act === 'toggle' && id) { expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
  else if (act === 'retry' && id) {
    const n = await db.get('notes', id);
    Object.assign(n, { status: 'queued', error: null });
    await db.put('notes', n);
    await render();
    runQueue();
  } else if (act === 'delete' && id) {
    if (!confirm('Eliminare questo vocale e il suo riassunto?')) return;
    await db.del('notes', id);
    expanded.delete(id);
    await render();
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.act !== 'task') return;
  const dg = await db.get('digests', currentDay);
  if (!dg) return;
  dg.done = { ...(dg.done || {}), [t.dataset.i]: t.checked };
  await db.put('digests', dg);
  t.closest('li').classList.toggle('done', t.checked);
});

// Quando si torna sull'app (es. dopo aver condiviso altri vocali) ricontrolla l'inbox.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') drainInbox().then(() => runQueue());
});

// ---------- Avvio ----------

async function start() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker non registrato', err));
  }
  navigator.storage?.persist?.().catch(() => {});

  // Se l'app è stata chiusa a metà elaborazione, rimette in coda.
  for (const n of await db.all('notes')) {
    if (n.status === 'processing') { n.status = 'queued'; await db.put('notes', n); }
  }
  await purgeOldAudio();

  const params = new URLSearchParams(location.search);
  if (params.has('shared')) {
    history.replaceState(null, '', location.pathname);
    if (params.get('shared') === '0') toast('Nessun file audio ricevuto dalla condivisione.');
  }
  await drainInbox();
  await render();
  runQueue();
}

start();
