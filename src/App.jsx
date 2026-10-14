import React, { useState, useRef, useEffect } from 'react'

const DEFAULT_LANG = 'fr-FR'
const STORAGE = {
  history: 'fr_voice_tutor_history_v3',
  email: 'fr_voice_tutor_email_v3',
  settings: 'fr_voice_tutor_settings_v3',
  wordCache: 'fr_voice_word_cache_v1'
}

// Lessons grouped by level
const LESSON_LEVELS = [
  {
    level: 'A1',
    lessons: [
      { id: 'a1-1', title: 'Приветствия', prompts: ['Bonjour, comment ça va ?', 'Je m’appelle Pierre. Et toi ?'] },
      { id: 'a1-2', title: 'В кафе', prompts: ['Je voudrais un café, s’il vous plaît.', 'L’addition, s’il vous plaît.'] }
    ]
  },
  {
    level: 'A2',
    lessons: [
      { id: 'a2-1', title: 'Путешествие', prompts: ['Où est la gare ?', 'Je cherche cet hôtel.'] },
      { id: 'a2-2', title: 'Магазин', prompts: ['Combien ça coûte ?', 'Je prends ceci.'] }
    ]
  },
  {
    level: 'B1',
    lessons: [
      { id: 'b1-1', title: 'Работа', prompts: ['Je travaille comme développeur.', 'Je dois préparer une présentation.'] }
    ]
  },
  {
    level: 'B2',
    lessons: [
      { id: 'b2-1', title: 'Обсуждение', prompts: ['À mon avis, la situation est compliquée.', 'Nous devons trouver une solution.'] }
    ]
  }
]

function safeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

async function callTranslate(text, source = 'auto', target = 'ru') {
  if (!text) return { translatedText: '' }
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target })
    })
    if (res.ok) return await res.json()
  } catch (e) {}
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

async function callLanguageTool(text, lang = 'fr') {
  try {
    const res = await fetch('/api/languagetool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: lang })
    })
    if (res.ok) return await res.json()
  } catch (e) {}
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
  const [level, setLevel] = useState(LESSON_LEVELS[0].level)
  const [selectedLesson, setSelectedLesson] = useState(LESSON_LEVELS[0].lessons[0])
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [corrected, setCorrected] = useState('')
  const [matches, setMatches] = useState([])
  const [translation, setTranslation] = useState('')
  const [history, setHistory] = useState(safeGet('fr_voice_tutor_history_v3', []))
  const [wordTranslations, setWordTranslations] = useState(safeGet('fr_voice_word_cache_v1', {}))
  const [showWordList, setShowWordList] = useState(false)
  const [recordLang, setRecordLang] = useState('fr')
  const recognitionRef = useRef(null)
  const [status, setStatus] = useState('Готово')
  const [error, setError] = useState(null)
  const [score, setScore] = useState(0)

  const [keyboardInput, setKeyboardInput] = useState('')
  const [keyboardSource, setKeyboardSource] = useState('auto')
  const [keyboardTarget, setKeyboardTarget] = useState('ru')
  const debounceRef = useRef(null)

  useEffect(() => {
    setHistory(safeGet(STORAGE.history, []))
    setWordTranslations(safeGet(STORAGE.wordCache, {}))
  }, [])

  function supportsSR() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition) }
  function getRecognitionLang() { if (recordLang === 'fr') return 'fr-FR'; if (recordLang === 'ru') return 'ru-RU'; return DEFAULT_LANG }

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
    if (!supportsSR()) { setError('SpeechRecognition не поддерживается в этом браузере. Попробуй Chrome/Edge.'); return }
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
        const langForLT = (recordLang === 'ru') ? 'ru' : 'fr'
        const ltRes = await callLanguageTool(t, langForLT)
        const mm = ltRes.matches || []
        const corr = applyCorrections(t, mm)
        setMatches(mm)
        setCorrected(corr)
        const sc = computeScore(t, corr)
        setScore(sc)

        const entry = { ts: Date.now(), transcript: t, corrected: corr, score: sc, lang: recordLang }
        const prev = safeGet(STORAGE.history, [])
        const next = [entry, ...prev].slice(0, 200)
        safeSet(STORAGE.history, next)
        setHistory(next)

        const source = (recordLang === 'ru') ? 'ru' : 'fr'
        const target = (recordLang === 'ru') ? 'fr' : 'ru'
        try {
          const tr = await callTranslate(t, source, target)
          const txt = tr.translatedText || tr.translated || tr.result || (tr.data && tr.data.translatedText) || ''
          setTranslation(txt)
        } catch (err) { console.warn('translate error', err) }

        setStatus('Готово')
      } catch (err) { console.error(err); setError('Ошибка проверки: ' + (err.message || err)); setStatus('Ошибка') }
    }

    rec.onerror = (e) => { setError('Ошибка распознавания: ' + (e.error || e.message || e)); setListening(false); setStatus('Ошибка') }
    rec.onend = () => { setListening(false); if (status === 'Слушаю...') setStatus('Готово') }

    recognitionRef.current = rec
    rec.start()
  }

  function stopRecording() { if (recognitionRef.current) recognitionRef.current.stop(); setListening(false); setStatus('Остановлено') }

  function speakText(text, langCode) { if (!text) return; const utter = new SpeechSynthesisUtterance(text); utter.lang = langCode === 'ru' ? 'ru-RU' : 'fr-FR'; const voices = speechSynthesis.getVoices(); const voice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(langCode === 'ru' ? 'ru' : 'fr')); if (voice) utter.voice = voice; speechSynthesis.cancel(); speechSynthesis.speak(utter) }

  async function translateInline(text, source, target) {
    setStatus('Перевожу...')
    try {
      const res = await callTranslate(text, source, target)
      const out = res.translatedText || res.translated || res.result || (res.data && res.data.translatedText) || ''
      setTranslation(out)
      setStatus('Готово')
      return out
    } catch (err) { setError('Ошибка перевода: ' + (err.message || err)); setStatus('Ошибка'); return '' }
  }

  // debounce keyboard input translation
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!keyboardInput || keyboardInput.trim().length === 0) { setTranslation(''); return }
    debounceRef.current = setTimeout(() => {
      translateInline(keyboardInput, keyboardSource, keyboardTarget)
    }, 450)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyboardInput, keyboardSource, keyboardTarget])

  function selectLevel(lvl) {
    setLevel(lvl)
    const group = LESSON_LEVELS.find(g => g.level === lvl)
    if (group && group.lessons && group.lessons[0]) setSelectedLesson(group.lessons[0])
  }

  function selectLesson(lesson) {
    setSelectedLesson(lesson)
    setTranscript('')
    setCorrected('')
    setMatches([])
    setTranslation('')
    setScore(0)
    setShowWordList(false)
  }

  async function fillKeyboardWithTranscript() {
    setKeyboardInput(transcript || '')
    setKeyboardSource(recordLang === 'ru' ? 'ru' : 'fr')
    setKeyboardTarget(recordLang === 'ru' ? 'fr' : 'ru')
  }

  function exportHistory() { const data = safeGet(STORAGE.history, []); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'fr-voice-history.json'; a.click(); URL.revokeObjectURL(url) }
  function clearHistory() { safeSet(STORAGE.history, []); setHistory([]); alert('История очищена') }

  async function buildWordList() {
    setShowWordList(true)
    const base = corrected || transcript || keyboardInput || ''
    const words = normalizeWords(base)
    const source = (recordLang === 'ru') ? 'ru' : 'fr'
    const target = (recordLang === 'ru') ? 'fr' : 'ru'
    const cache = safeGet(STORAGE.wordCache, {})
    const result = {}
    for (const w of words) {
      const key = `${w.toLowerCase()}|${source}|${target}`
      if (cache[key]) { result[w] = cache[key]; continue }
      const tr = await callTranslate(w, source, target)
      const out = tr.translatedText || tr.translated || tr.result || (tr.data && tr.data.translatedText) || ''
      cache[key] = out
      result[w] = out
      await new Promise(r => setTimeout(r, 120))
    }
    safeSet(STORAGE.wordCache, cache)
    setWordTranslations(cache)
    return result
  }

  return (
    <div style={{ maxWidth: 980, margin: '18px auto', fontFamily: 'Inter, system-ui, sans-serif', padding: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0 }}>FR Voice Tutor</h1>
          <small style={{ color: '#475569' }}>Уроки A1→B2, говори или печатай — получай исправления и перевод</small>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={recordLang} onChange={e => setRecordLang(e.target.value)} title="Язык записи">
            <option value="fr">Говорить: Français</option>
            <option value="ru">Говорить: Русский</option>
            <option value="auto">Говорить: Авто</option>
          </select>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
        <main>
          <section style={{ padding: 14, background: '#fff', borderRadius: 12, marginBottom: 12 }}>
            <h2 style={{ marginTop: 0 }}>Уроки</h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {LESSON_LEVELS.map(g => (
                <button key={g.level} onClick={() => selectLevel(g.level)} style={{ padding: 8, borderRadius: 8, background: level === g.level ? '#e6f6ff' : '#fff' }}>{g.level}</button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <h3>Уроки уровня {level}</h3>
                <div style={{ display: 'grid', gap: 8 }}>
                  {(LESSON_LEVELS.find(g => g.level === level) || { lessons: [] }).lessons.map(ls => (
                    <div key={ls.id} style={{ padding: 10, borderRadius: 8, background: ls.id === selectedLesson.id ? '#f0f9ff' : '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{ls.title}</div>
                        <div style={{ color: '#64748b', fontSize: 12 }}>{ls.prompts[0]}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => selectLesson(ls)}>Открыть</button>
                        <button onClick={() => speakText(ls.prompts[0], 'fr')}>Прослушать</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <aside style={{ width: 320 }}>
                <div style={{ padding: 12, background: '#fff', borderRadius: 12 }}>
                  <h4>Текущий урок</h4>
                  <div style={{ fontWeight: 700 }}>{selectedLesson.title}</div>
                  <div style={{ color: '#64748b', marginTop: 6 }}>{selectedLesson.prompts[0]}</div>

                  <div style={{ marginTop: 12 }}>
                    <button onClick={() => speakText(selectedLesson.prompts[0], 'fr')} style={{ marginRight: 8 }}>Прослушать</button>
                    <button onClick={() => { setTranscript(''); setCorrected(''); setMatches([]); setTranslation(''); setScore(0) }}>Сбросить</button>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <strong>Эталон:</strong>
                    <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', borderRadius: 8 }}>{selectedLesson.prompts.join('\n')}</div>
                  </div>
                </div>

                <div style={{ marginTop: 12, padding: 12, background: '#fff', borderRadius: 12 }}>
                  <h4>Быстрая практика</h4>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => startRecording()} disabled={listening}>{listening ? 'Слушаю...' : 'Говорить'}</button>
                    <button onClick={() => stopRecording()} disabled={!listening}>Остановить</button>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button onClick={() => fillKeyboardWithTranscript()}>Заполнить поле ввода</button>
                    <button onClick={() => buildWordList()} style={{ marginLeft: 8 }}>Показать слова</button>
                  </div>
                </div>

              </aside>
            </div>

          </section>

          <section style={{ padding: 14, background: '#fff', borderRadius: 12, marginBottom: 12 }}>
            <h3>Твоя запись</h3>
            <div style={{ padding: 10, background: '#f8fafc', borderRadius: 8 }}>{transcript || <span style={{ color: '#94a3b8' }}>Пока нет записи</span>}</div>
            <div style={{ marginTop: 10 }}>
              <strong>Исправленный вариант:</strong>
              <div style={{ padding: 10, background: '#f0fff4', borderRadius: 8 }}>{corrected || <span style={{ color: '#94a3b8' }}>—</span>}</div>
              <div style={{ marginTop: 8 }}>{/* diff could be here */}</div>
            </div>

            <div style={{ marginTop: 10 }}>
              <strong>Перевод:</strong>
              <div style={{ padding: 10, background: '#fff7ed', borderRadius: 8 }}>{translation || <span style={{ color: '#94a3b8' }}>—</span>}</div>
            </div>

            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ fontWeight: 700 }}>{score}%</div>
              <div style={{ color: '#64748b' }}>Оценка совпадения</div>
            </div>

          </section>

        </main>

        <aside>
          <section style={{ padding: 12, background: '#fff', borderRadius: 12, marginBottom: 12 }}>
            <h3>Быстрый перевод (через клавиатуру)</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <select value={keyboardSource} onChange={e => setKeyboardSource(e.target.value)}>
                <option value="auto">auto</option>
                <option value="fr">fr</option>
                <option value="ru">ru</option>
              </select>
              <select value={keyboardTarget} onChange={e => setKeyboardTarget(e.target.value)}>
                <option value="ru">ru</option>
                <option value="fr">fr</option>
              </select>
            </div>
            <textarea placeholder="Напиши слово или фразу и переведу мгновенно" value={keyboardInput} onChange={e => setKeyboardInput(e.target.value)} style={{ width: '100%', minHeight: 80, padding: 8 }} />
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button onClick={() => translateInline(keyboardInput, keyboardSource, keyboardTarget)}>Перевести</button>
              <button onClick={() => speakText(translation, keyboardTarget)}>Прослушать перевод</button>
            </div>

            <div style={{ marginTop: 12 }}>
              <strong>Результат:</strong>
              <div style={{ marginTop: 8, padding: 8, background: '#fbfbff', borderRadius: 8 }}>{translation || <span style={{ color: '#94a3b8' }}>Результат появится здесь</span>}</div>
            </div>

            <div style={{ marginTop: 12 }}>
              <button onClick={() => { setKeyboardInput(''); setTranslation('') }}>Очистить</button>
            </div>

          </section>

          <section style={{ padding: 12, background: '#fff', borderRadius: 12, marginBottom: 12 }}>
            <h3>Значения слов</h3>
            {Object.keys(wordTranslations).length === 0 ? <div style={{ color: '#94a3b8' }}>Пусто — нажми «Показать слова»</div> : (
              <div style={{ display: 'grid', gap: 8 }}>
                {Object.keys(wordTranslations).map(k => (
                  <div key={k} style={{ padding: 8, borderRadius: 8, background: '#fff' }}>
                    <div style={{ fontWeight: 700 }}>{k.split('|')[0]}</div>
                    <div style={{ color: '#475569' }}>{wordTranslations[k] || '-'}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section style={{ padding: 12, background: '#fff', borderRadius: 12 }}>
            <h3>История</h3>
            {history.length === 0 ? <div style={{ color: '#94a3b8' }}>Пока нет записей</div> : (
              <div style={{ display: 'grid', gap: 8 }}>
                {history.slice(0, 16).map(h => (
                  <div key={h.ts} style={{ padding: 8, borderRadius: 8, background: '#f7f9fc' }}>
                    <div style={{ fontWeight: 700 }}>{h.transcript}</div>
                    <div style={{ color: '#64748b', fontSize: 12 }}>{new Date(h.ts).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button onClick={() => exportHistory()}>Экспорт</button>
              <button onClick={() => clearHistory()}>Очистить</button>
            </div>
          </section>

        </aside>
      </div>

      <footer style={{ marginTop: 16, color: '#64748b' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>FR Voice Tutor — прототип. По вопросам и идеям пиши.</div>
          <div>
            <input id="email-v3" placeholder="Твой email" style={{ padding: 8, borderRadius: 8 }} />
            <button onClick={() => { const e = (document.getElementById('email-v3') || {}).value; if (!e || !e.includes('@')) return alert('Введи email'); const prev = safeGet(STORAGE.email, []); prev.push({ email: e, ts: Date.now() }); safeSet(STORAGE.email, prev); alert('Спасибо!') }} style={{ marginLeft: 8 }}>Подписаться</button>
          </div>
        </div>
      </footer>
    </div>
  )
}
