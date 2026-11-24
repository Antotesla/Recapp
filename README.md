# Recapp

Web app (PWA) che trascrive e riassume i vocali WhatsApp: per ogni vocale estrae cose da fare, scadenze, domande a cui rispondere, decisioni e info utili, e prepara un **riepilogo unico della giornata** senza ripetizioni, segnalando i cambi di programma.

Costo zero: usa il piano gratuito di **Google Gemini** (con **Groq** come riserva facoltativa). Tutti i dati restano sul telefono (IndexedDB); l'audio viene inviato solo al servizio AI per l'elaborazione.

## Come si usa

- **Android (Chrome):** installa l'app (menu ⋮ → *Installa app* / *Aggiungi a schermata Home*). Poi su WhatsApp tieni premuti uno o più vocali → **Condividi** → **Recapp**.
- **iPhone:** iOS non permette alle web app di comparire nel menu Condividi. Per provarla usa il pulsante **＋ Vocali** e scegli i file audio.

Al primo avvio apri ⚙︎ e inserisci la chiave Gemini (gratis su <https://aistudio.google.com/apikey>) e due righe sul tuo lavoro: servono a capire cosa è rilevante.

## Pubblicazione (una volta sola)

1. Su GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. **Branch: `main`**, cartella **`/docs`** → **Save**.
3. Dopo circa un minuto l'app è su `https://<utente>.github.io/recapp/`. Ogni nuovo commit su `main` la aggiorna da solo.

## Struttura

```
docs/            (la cartella pubblicata da GitHub Pages)
  index.html, styles.css   interfaccia
  app.js                   logica: acquisizione, coda, riepilogo, UI
  ai.js                    chiamate a Gemini / Groq, prompt e schemi JSON
  db.js                    archivio locale (IndexedDB)
  sw.js                    offline + ricezione dei file da "Condividi"
  manifest.webmanifest     installazione e share target
```

Nessuna build: sono file statici. Per provarla in locale: `cd docs && python3 -m http.server 8080`.

## Limiti noti

- I limiti del piano gratuito di Gemini cambiano nel tempo: se vengono superati i vocali restano in coda e si possono rielaborare più tardi (o passano a Groq, se configurato).
- Il nome del modello si cambia dalle impostazioni (“Verifica chiave e carica modelli” mostra quelli disponibili).
- L'elaborazione avviene con l'app aperta; durante l'elaborazione lo schermo resta acceso.
