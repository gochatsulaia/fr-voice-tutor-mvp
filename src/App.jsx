import React, { useState, useRef, useEffect } from 'react'

const DEFAULT_LANG = 'fr-FR'
const STORAGE = {
  history: 'fr_voice_tutor_history_v3',
  email: 'fr_voice_tutor_email_v3',
  settings: 'fr_voice_tutor_settings_v3',
  wordCache: 'fr_voice_word_cache_v1'
}

function safeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

// proxy-aware translate call (calls /api/translate on deployed Vercel)
async function callTranslate(text, source = 'auto', target = 'ru') {
  if (!text) return { translatedText: '' }
  // Try serverless proxy first
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target })
    })
    if (res.ok) return await res.json()
  } catch (e) {
    // ignore -> fallback
  }

  // Fallback to public LibreTranslate instance
  try {
    const res2 = await fetch('https://libretranslate.de/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: source === 'auto' ? 'auto' : source, target, format: 'text' })
    })
    return await res2.json()
  } catch (err) {
    console.error('Translate failed', err)
    return { translatedText: '' }
  }
}

// languageTool proxy already exists in repo; this helper calls it for FR (or RU)
async function callLanguageTool(text, lang = 'fr') {
  try {
    const res = await fetch('/api/languagetool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: lang })
    })
    if (res.ok) return await res.json()
  } catch (e) { /* ignore */ }

  // direct fallback
  try {
    const res2 = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: lang })
    })
    return await res2.json()
  } catch (err) {
    console.error('LanguageTool failed', err)
    return { matches: [] }
  }
}

function applyCorrections(text, matches) {
  if (!text) return ''
  if (!matches || matches.length === 0) return text
  const sorted = [...matches].sort((a, b) => (a.offset || 0) - (b.offset || 0))
  let out = ''
  let cursor = 0
  for (const m of sorted) {
    const start = m.offset || 0
    const len = m.length || 0
    const replacement = (m.replacements && m.replacements[0] && m.replacements[0].value) || text.slice(start, start + len)
    if (start >= cursor) {
      out += text.slice(cursor, start)
      out += replacement
      cursor = start + len
    }
  }
  if (cursor < text.length) out += text.slice(cursor)
  return out
}

function normalizeWords(s) {
  return (s || '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

export default function App() {
  const [recordLang, setRecordLang] = useState('fr') // 'fr' | 'ru' | 'auto'
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [corrected, setCorrected] = useState('')
  const [matches, setMatches] = useState([])
  const [translation, setTranslation] = useState('')
  const [history, setHistory] = useState(safeGet(STORAGE.history, []))
  const [wordTranslations, setWordTranslations] = useState({}) // { word: translated }
  const [showWordList, setShowWordList] = useState(false)
  const recognitionRef = useRef(null)
  const [status, setStatus] = useState('Готово')
  const [error, setError] = useState(null)
  const [score, setScore] = useState(0)

  useEffect(() => {
    setHistory(safeGet(STORAGE.history, []))
    const cached = safeGet(STORAGE.wordCache, {})
    setWordTranslations(cached)
  }, [])

  function supportsSR() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition) }

  function getRecognitionLang() {
    if (recordLang === 'fr') return 'fr-FR'
    if (recordLang === 'ru') return 'ru-RU'
    return DEFAULT_LANG
  }

  function computeScore(orig, corr) {
    const a = normalizeWords(orig.toLowerCase())
    const b = normalizeWords(corr.toLowerCase())
    if (a.length === 0 && b.length === 0) return 0
    const max = Math.max(a.length, b.length)
    let same = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++
    return Math.round((same / max) * 100)
  }

  async function startRecording() {
    setError(null)
    if (!supportsSR()) {
      setError('SpeechRecognition не поддерживается в этом браузере. Попробуй Chrome/Edge.')
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang = getRecognitionLang()
    rec.interimResults = false
    rec.maxAlternatives = 1

    rec.onstart = () => { setListening(true); setStatus('Слушаю...') }
    rec.onresult = async (e) => {
      const t = e.results[e.results.length - 1][0].transcript
      setTranscript(t)
      setStatus('Обрабатываю...')
      try {
        // LanguageTool check depends on the recordLang choice; if auto -> try fr first, fallback ru
        const langForLT = (recordLang === 'ru') ? 'ru' : 'fr'
        const ltRes = await callLanguageTool(t, langForLT)
        const mm = ltRes.matches || []
        const corr = applyCorrections(t, mm)
        setMatches(mm)
        setCorrected(corr)
        const sc = computeScore(t, corr)
        setScore(sc)

        // push history
        const entry = { ts: Date.now(), transcript: t, corrected: corr, score: sc, lang: recordLang }
        const prev = safeGet(STORAGE.history, [])
        const next = [entry, ...prev].slice(0, 200)
        safeSet(STORAGE.history, next)
        setHistory(next)

        // Determine translation direction:
        // if recordLang === 'ru' -> RU -> FR
        // else -> FR -> RU
        const source = (recordLang === 'ru') ? 'ru' : 'fr'
        const target = (recordLang === 'ru') ? 'fr' : 'ru'

        // Auto-translate transcript
        try {
          const tr = await callTranslate(t, source, target)
          // handle various response shapes
          const txt = tr.translatedText || tr.translated || tr.result || (tr.data && tr.data.translatedText) || ''
          setTranslation(txt)
        } catch (err) {
          console.warn('translate error', err)
        }

        setStatus('Готово')
      } catch (err) {
        console.error(err)
        setError('Ошибка проверки: ' + (err.message || err))
        setStatus('Ошибка')
      }
    }

    rec.onerror = (e) => { setError('Ошибка распознавания: ' + (e.error || e.message || e)); setListening(false); setStatus('Ошибка') }
    rec.onend = () => { setListening(false); if (status === 'Слушаю...') setStatus('Готово') }

    recognitionRef.current = rec
    rec.start()
  }

  function stopRecording() {
    if (recognitionRef.current) recognitionRef.current.stop()
    setListening(false)
    setStatus('Остановлено')
  }

  function speakText(text, langCode) {
    if (!text) return
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = langCode === 'ru' ? 'ru-RU' : 'fr-FR'
    const voices = speechSynthesis.getVoices()
    const voice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(langCode === 'ru' ? 'ru' : 'fr'))
    if (voice) utter.voice = voice
    speechSynthesis.cancel()
    speechSynthesis.speak(utter)
  }

  // Word-by-word translations with local cache
  async function translateWord(word, source = 'auto', target = 'ru') {
    if (!word) return ''
    const cache = safeGet(STORAGE.wordCache, {})
    const key = `${word.toLowerCase()}|${source}|${target}`
    if (cache[key]) return cache[key]

    try {
      const res = await callTranslate(word, source, target)
      const out = res.translatedText || res.translated || res.result || (res.data && res.data.translatedText) || ''
      cache[key] = out
      safeSet(STORAGE.wordCache, cache)
      setWordTranslations(cache)
      return out
    } catch (err) {
      console.error('translateWord fail', err)
      return ''
    }
  }

  async function buildWordList() {
    setShowWordList(true)
    const base = corrected || transcript || ''
    const words = normalizeWords(base)
    const source = (recordLang === 'ru') ? 'ru' : 'fr'
    const target = (recordLang === 'ru') ? 'fr' : 'ru'
    const cache = safeGet(STORAGE.wordCache, {})
    const result = {}
    // translate each unique word sequentially (small batch to avoid rate limits)
    for (const w of words) {
      const key = `${w.toLowerCase()}|${source}|${target}`
      if (cache[key]) {
        result[w] = cache[key]
        continue
      }
      // small delay to be polite with public API
      // eslint-disable-next-line no-await-in-loop
      const tr = await translateWord(w, source, target)
      result[w] = tr
      // brief pause
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 120))
    }
    setWordTranslations(safeGet(STORAGE.wordCache, {}))
    return result
  }

  function exportHistory() {
    const data = safeGet(STORAGE.history, [])
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'fr-voice-history.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function clearHistory() {
    safeSet(STORAGE.history, [])
    setHistory([])
    alert('История очищена')
  }

  // UI helpers
  function renderDiff(orig, corr) {
    const a = (orig || '').trim().split(/\s+/).filter(Boolean)
    const b = (corr || '').trim().split(/\s+/).filter(Boolean)
    const len = Math.max(a.length, b.length)
    const parts = []
    for (let i = 0; i < len; i++) {
      const wa = a[i] || ''
      const wb = b[i] || ''
      if (!wa && wb) parts.push(<span key={i} className="diff-added">{wb} </span>)
      else if (wa && !wb) parts.push(<span key={i} className="diff-removed">{wa} </span>)
      else if (wa === wb) parts.push(<span key={i} className="diff-same">{wa} </span>)
      else parts.push(<span key={i} className="diff-changed">{wb} </span>)
    }
    return parts.length ? parts : <span className="muted">Пока нет сравнения</span>
  }

  return (
    <div style={{ maxWidth: 980, margin: '18px auto', fontFamily: 'Inter, system-ui, sans-serif', padding: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0 }}>FR Voice Tutor</h1>
          <small style={{ color: '#475569' }}>Говори → получай исправления → перевод → значения слов</small>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={recordLang} onChange={e => setRecordLang(e.target.value)} title="Язык записи">
            <option value="fr">Говорить: Français</option>
            <option value="ru">Говорить: Русский</option>
            <option value="auto">Говорить: Авто (французский по умолчанию)</option>
          </select>
        </div>
      </header>

      <main>
        <section style={{ padding: 14, background: '#fff', borderRadius: 12, marginBottom: 12 }}>
          <h2 style={{ marginTop: 0 }}>Практика</h2>
          <p style={{ color: '#475569' }}>Нажми «Говорить», произнеси фразу и получи исправление и перевод.</p>

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={startRecording} disabled={listening} style={{ padding: '10px 14px' }}>{listening ? 'Слушаю...' : 'Говорить'}</button>
            <button onClick={stopRecording} disabled={!listening} style={{ padding: '10px 14px' }}>Остановить</button>
            <button onClick={() => speakText(translation, (recordLang === 'ru') ? 'fr' : 'ru')} style={{ padding: '10px 14px' }}>Прослушать перевод</button>
            <button onClick={() => { setShowWordList(false); setWordTranslations({}) }} style={{ padding: '10px 14px' }}>Сбросить слова</button>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Что ты сказал:</strong>
            <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', borderRadius: 8 }}>{transcript || <span style={{ color: '#94a3b8' }}>Записывай фразу...</span>}</div>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Исправленный вариант:</strong>
            <div style={{ marginTop: 8, padding: 10, background: '#f0fff4', borderRadius: 8 }}>{corrected || <span style={{ color: '#94a3b8' }}>Здесь появится исправленный вариант</span>}</div>
            <div style={{ marginTop: 8 }}>{renderDiff(transcript, corrected)}</div>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Перевод:</strong>
            <div style={{ marginTop: 8, padding: 10, background: '#fff7ed', borderRadius: 8 }}>{translation || <span style={{ color: '#94a3b8' }}>Перевод появится здесь</span>}</div>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ fontWeight: 700 }}>{score}%</div>
            <div style={{ color: '#64748b' }}>Оценка совпадения</div>
            <button onClick={async () => { await buildWordList(); }} style={{ marginLeft: 'auto' }}>Показать значения слов</button>
          </div>
        </section>

        {showWordList && (
          <section style={{ padding: 12, background: '#fff', borderRadius: 12, marginBottom: 12 }}>
            <h3>Значения слов</h3>
            {Object.keys(wordTranslations).length === 0 ? (
              <div style={{ color: '#94a3b8' }}>Список пуст. Нажми «Показать значения слов» чтобы собрать переводы по словам.</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {Object.keys(wordTranslations).map((w) => (
                  <div key={w} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 8, borderRadius: 8, background: '#fbfbff' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{w}</div>
                      <div style={{ color: '#475569' }}>{wordTranslations[w] || '-'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => speakText(w, (recordLang === 'ru') ? 'ru' : 'fr')}>Прослушать</button>
                      <button onClick={() => speakText(wordTranslations[w], (recordLang === 'ru') ? 'fr' : 'ru')}>Прослушать перевод</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section style={{ padding: 12, background: '#fff', borderRadius: 12 }}>
          <h3>История</h3>
          {history.length === 0 ? <div style={{ color: '#94a3b8' }}>Пока нет записей</div> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {history.slice(0, 16).map(h => (
                <div key={h.ts} style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderRadius: 8, background: '#f7f9fc' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{h.transcript}</div>
                    <div style={{ color: '#64748b', fontSize: 12 }}>{new Date(h.ts).toLocaleString()}</div>
                  </div>
                  <div style={{ fontWeight: 700, color: '#0ea5a4' }}>{h.score}%</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button onClick={() => exportHistory()}>Экспорт</button>
            <button onClick={() => clearHistory()}>Очистить</button>
          </div>
        </section>
      </main>

      <footer style={{ marginTop: 16, color: '#64748b' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>FR Voice Tutor — прототип. Для стабильной работы перевода используйте прод-деплой (Vercel).</div>
          <div>
            <input id="email-v3" placeholder="Твой email" style={{ padding: 8, borderRadius: 8 }} />
            <button onClick={() => { const e = (document.getElementById('email-v3') || {}).value; if (!e || !e.includes('@')) return alert('Введи email'); const prev = safeGet(STORAGE.email, []); prev.push({ email: e, ts: Date.now() }); safeSet(STORAGE.email, prev); alert('Спасибо!') }} style={{ marginLeft: 8 }}>Подписаться</button>
          </div>
        </div>
      </footer>
    </div>
  )
}
