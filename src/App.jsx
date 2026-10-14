import React, { useState, useRef, useEffect } from 'react'

const STORAGE = {
  history: 'fr_voice_tutor_history_v4',
  wordCache: 'fr_voice_word_cache_v2',
  email: 'fr_voice_tutor_email_v4',
}

const LEVELS = [
  {
    level: 'A1',
    lessons: [
      { id: 'greeting', title: 'Приветствия', phrases: ['Bonjour, comment ça va ?', 'Je m’appelle Ana.'] },
      { id: 'cafe', title: 'В кафе', phrases: ['Je voudrais un café, s’il vous plaît.', 'L’addition, s’il vous plaît.'] },
      { id: 'shop', title: 'Магазин', phrases: ['Combien ça coûte ?', 'Je prends ce modèle.'] },
    ],
  },
  {
    level: 'A2',
    lessons: [
      { id: 'travel', title: 'Путешествие', phrases: ['Où est la gare ?', 'Je cherche l’hôtel.'] },
      { id: 'schedule', title: 'Распорядок дня', phrases: ['Je me lève à sept heures.', 'Je travaille de neuf à cinq.'] },
      { id: 'plans', title: 'Планы', phrases: ['Je vais aller au cinéma ce soir.', 'On se voit demain ?'] },
    ],
  },
  {
    level: 'B1',
    lessons: [
      { id: 'work', title: 'Работа', phrases: ['Je travaille comme développeur.', 'Je dois préparer une présentation.'] },
      { id: 'opinions', title: 'Мнение', phrases: ['À mon avis, c’est une bonne idée.', 'Je pense que cela peut marcher.'] },
      { id: 'future', title: 'Будущее', phrases: ['Dans deux ans, je veux étudier à l’étranger.', 'Je vais développer de nouvelles compétences.'] },
    ],
  },
  {
    level: 'B2',
    lessons: [
      { id: 'debate', title: 'Дебаты', phrases: ['À mon avis, la situation est complexe et demande du temps.', 'Nous devons trouver une solution durable.'] },
      { id: 'projects', title: 'Проекты', phrases: ['Le projet a bien avancé, mais il reste encore des obstacles.', 'Il faut améliorer la communication interne.'] },
      { id: 'ideas', title: 'Идеи', phrases: ['Je suis convaincu que cette stratégie va fonctionner.', 'Nous devons penser à long terme.'] },
    ],
  },
]

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function normalizeWords(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .split(/\s+/)
    .map(w => w.replace(/^['"(]+|['")]+$/g, '').trim())
    .filter(Boolean)
}

async function callTranslate(text, source = 'auto', target = 'ru') {
  if (!text || !text.trim()) return { translatedText: '' }

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target }),
    })
    if (res.ok) return await res.json()
  } catch (err) {
    // fallback below
  }

  try {
    const res2 = await fetch('https://libretranslate.de/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: source === 'auto' ? 'auto' : source, target, format: 'text' }),
    })
    return await res2.json()
  } catch (err) {
    console.error('Translate failed', err)
    return { translatedText: '' }
  }
}

async function callLanguageTool(text, language = 'fr') {
  try {
    const res = await fetch('/api/languagetool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language }),
    })
    if (res.ok) return await res.json()
  } catch (err) {}

  try {
    const res2 = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language }),
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

export default function App() {
  const [selectedLevel, setSelectedLevel] = useState('A1')
  const [selectedLesson, setSelectedLesson] = useState(LEVELS[0].lessons[0])
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [corrected, setCorrected] = useState('')
  const [translation, setTranslation] = useState('')
  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('Готово')
  const [error, setError] = useState(null)
  const [score, setScore] = useState(0)
  const [history, setHistory] = useState(safeGet(STORAGE.history, []))
  const [wordMap, setWordMap] = useState(safeGet(STORAGE.wordCache, {}))
  const [inputText, setInputText] = useState('')
  const [inputSource, setInputSource] = useState('fr')
  const [inputTarget, setInputTarget] = useState('ru')
  const [showWords, setShowWords] = useState(false)
  const recognitionRef = useRef(null)

  useEffect(() => {
    setHistory(safeGet(STORAGE.history, []))
    setWordMap(safeGet(STORAGE.wordCache, {}))
  }, [])

  function supportsSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function getWaveLang() {
    if (inputSource === 'ru') return 'ru-RU'
    return 'fr-FR'
  }

  function computeScore(original, correctedText) {
    const a = normalizeWords(original)
    const b = normalizeWords(correctedText)
    if (a.length === 0 && b.length === 0) return 0
    const max = Math.max(a.length, b.length)
    let same = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) same += 1
    }
    return Math.round((same / max) * 100)
  }

  async function translateText(text, source = inputSource, target = inputTarget) {
    const result = await callTranslate(text, source, target)
    const out = result.translatedText || result.translated || result.result || (result.data && result.data.translatedText) || ''
    setTranslation(out)
    return out
  }

  async function handleSpeechResult(text) {
    setTranscript(text)
    setStatus('Обрабатываю...')

    try {
      const ltLang = inputSource === 'ru' ? 'ru' : 'fr'
      const toolRes = await callLanguageTool(text, ltLang)
      const matchesList = toolRes.matches || []
      const correctedText = applyCorrections(text, matchesList)
      setMatches(matchesList)
      setCorrected(correctedText)
      setScore(computeScore(text, correctedText))

      const source = inputSource === 'ru' ? 'ru' : 'fr'
      const target = inputSource === 'ru' ? 'fr' : 'ru'
      const translated = await callTranslate(text, source, target)
      const out = translated.translatedText || translated.translated || translated.result || (translated.data && translated.data.translatedText) || ''
      setTranslation(out)

      const historyEntry = { ts: Date.now(), transcript: text, corrected: correctedText, score: computeScore(text, correctedText), target }
      const previous = safeGet(STORAGE.history, [])
      const next = [historyEntry, ...previous].slice(0, 200)
      safeSet(STORAGE.history, next)
      setHistory(next)

      setStatus('Готово')
    } catch (err) {
      console.error(err)
      setError('Ошибка проверки: ' + (err.message || err))
      setStatus('Ошибка')
    }
  }

  function startRecording() {
    setError(null)
    if (!supportsSpeechRecognition()) {
      setError('SpeechRecognition не поддерживается в этом браузере. Попробуй Chrome/Edge.')
      return
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang = inputSource === 'ru' ? 'ru-RU' : 'fr-FR'
    rec.interimResults = false
    rec.maxAlternatives = 1

    rec.onstart = () => {
      setListening(true)
      setStatus('Слушаю...')
    }

    rec.onresult = (event) => {
      const last = event.results[event.results.length - 1][0].transcript
      handleSpeechResult(last)
    }

    rec.onerror = (event) => {
      setError('Ошибка распознавания: ' + (event.error || event.message || event))
      setListening(false)
      setStatus('Ошибка')
    }

    rec.onend = () => {
      setListening(false)
      if (status === 'Слушаю...') setStatus('Готово')
    }

    recognitionRef.current = rec
    rec.start()
  }

  function stopRecording() {
    if (recognitionRef.current) recognitionRef.current.stop()
    setListening(false)
    setStatus('Остановлено')
  }

  function speakText(text, lang = 'fr') {
    if (!text) return
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = lang === 'ru' ? 'ru-RU' : 'fr-FR'
    const list = speechSynthesis.getVoices()
    const voice = list.find(v => v.lang && v.lang.toLowerCase().startsWith(lang === 'ru' ? 'ru' : 'fr'))
    if (voice) utter.voice = voice
    speechSynthesis.cancel()
    speechSynthesis.speak(utter)
  }

  async function buildWordMapForText(text) {
    const words = normalizeWords(text)
    if (words.length === 0) return {}

    const liveMap = { ...wordMap }
    const source = inputSource === 'ru' ? 'ru' : 'fr'
    const target = inputSource === 'ru' ? 'fr' : 'ru'

    for (const word of words) {
      const key = `${word}|${source}|${target}`
      if (liveMap[key]) continue
      const translated = await callTranslate(word, source, target)
      const out = translated.translatedText || translated.translated || translated.result || (translated.data && translated.data.translatedText) || ''
      liveMap[key] = out
      await new Promise(resolve => setTimeout(resolve, 120))
    }

    safeSet(STORAGE.wordCache, liveMap)
    setWordMap(liveMap)
    return liveMap
  }

  function onLessonSelect(levelName, lesson) {
    setSelectedLevel(levelName)
    setSelectedLesson(lesson)
    setTranscript('')
    setCorrected('')
    setMatches([])
    setTranslation('')
    setScore(0)
    setShowWords(false)
    setStatus('Готово')
    setError(null)
  }

  async function onQuickTranslate() {
    if (!inputText.trim()) return
    setStatus('Перевожу...')
    const result = await translateText(inputText.trim(), inputSource, inputTarget)
    setStatus(result ? 'Готово' : 'Ошибка')
  }

  async function showWordsForCurrent() {
    setShowWords(true)
    const sourceText = corrected || transcript || inputText || ''
    await buildWordMapForText(sourceText)
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

  const levelData = LEVELS.find(l => l.level === selectedLevel) || LEVELS[0]

  return (
    <div style={{ maxWidth: 1180, margin: '20px auto', padding: 12, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0 }}>FR Voice Tutor</h1>
          <div style={{ color: '#475569' }}>Языковая платформа: уроки, перевод, словарь, практика</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={inputSource} onChange={e => setInputSource(e.target.value)}>
            <option value="fr">FR</option>
            <option value="ru">RU</option>
          </select>
          <span style={{ alignSelf: 'center', color: '#64748b' }}>→</span>
          <select value={inputTarget} onChange={e => setInputTarget(e.target.value)}>
            <option value="ru">RU</option>
            <option value="fr">FR</option>
          </select>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 16 }}>
        <main>
          <section style={{ background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 2px 10px rgba(15, 23, 42, 0.04)', marginBottom: 16 }}>
            <h2 style={{ marginTop: 0 }}>Уроки</h2>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {LEVELS.map(group => (
                <button
                  key={group.level}
                  onClick={() => setSelectedLevel(group.level)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 10,
                    border: '1px solid #cbd5e1',
                    background: selectedLevel === group.level ? '#dbeafe' : '#fff',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {group.level}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
              {levelData.lessons.map(lesson => (
                <div key={lesson.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 12, background: selectedLesson.id === lesson.id ? '#eff6ff' : '#f8fafc', border: selectedLesson.id === lesson.id ? '1px solid #bfdbfe' : '1px solid #e2e8f0' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{lesson.title}</div>
                    <div style={{ color: '#64748b', fontSize: 13 }}>{lesson.phrases[0]}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => onLessonSelect(levelData.level, lesson)}>Открыть</button>
                    <button onClick={() => speakText(lesson.phrases[0], 'fr')}>Прослушать</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 2px 10px rgba(15, 23, 42, 0.04)', marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Практика: {selectedLesson.title}</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <button onClick={startRecording} disabled={listening}>{listening ? 'Слушаю...' : 'Говорить'}</button>
              <button onClick={stopRecording} disabled={!listening}>Остановить</button>
              <button onClick={() => speakText(corrected || transcript || selectedLesson.phrases[0], 'fr')}>Прослушать правильный вариант</button>
              <button onClick={showWordsForCurrent}>Показать слова</button>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <strong>Эталон:</strong>
                <div style={{ marginTop: 6, padding: 12, background: '#f8fafc', borderRadius: 10, whiteSpace: 'pre-wrap' }}>
                  {selectedLesson.phrases.join('\n')}
                </div>
              </div>

              <div>
                <strong>Что ты сказал:</strong>
                <div style={{ marginTop: 6, padding: 12, background: '#f8fafc', borderRadius: 10 }}>
                  {transcript || <span style={{ color: '#94a3b8' }}>Пока ничего не записано</span>}
                </div>
              </div>

              <div>
                <strong>Исправленный вариант:</strong>
                <div style={{ marginTop: 6, padding: 12, background: '#ecfdf5', borderRadius: 10 }}>
                  {corrected || <span style={{ color: '#94a3b8' }}>Исправление появится здесь</span>}
                </div>
              </div>

              <div>
                <strong>Перевод:</strong>
                <div style={{ marginTop: 6, padding: 12, background: '#fff7ed', borderRadius: 10 }}>
                  {translation || <span style={{ color: '#94a3b8' }}>Перевод появится здесь</span>}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <strong style={{ fontSize: 18 }}>{score}%</strong>
                <span style={{ color: '#64748b' }}>точность</span>
              </div>
            </div>

            <div style={{ marginTop: 12, minHeight: 22, color: '#475569' }}>
              {status} {error ? <span style={{ color: '#b91c1c' }}>— {error}</span> : null}
            </div>
          </section>
        </main>

        <aside>
          <section style={{ background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 2px 10px rgba(15, 23, 42, 0.04)', marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Быстрый перевод</h3>
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="Напиши слово или фразу..."
              style={{ width: '100%', minHeight: 90, resize: 'vertical', padding: 12, borderRadius: 10, border: '1px solid #cbd5e1', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={onQuickTranslate}>Перевести</button>
              <button onClick={() => speakText(translation || inputText, inputTarget)}>Прослушать</button>
            </div>
            <div style={{ marginTop: 10, padding: 10, background: '#f8fafc', borderRadius: 10 }}>
              {translation || <span style={{ color: '#94a3b8' }}>Результат будет здесь</span>}
            </div>
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setInputText(transcript || '')}>Подставить из записи</button>
            </div>
          </section>

          <section style={{ background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 2px 10px rgba(15, 23, 42, 0.04)', marginBottom: 16 }}>
            <h3 style={{ marginTop: 0 }}>Словарь</h3>
            {showWords && Object.keys(wordMap).length > 0 ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {Object.entries(wordMap).slice(0, 12).map(([key, value]) => (
                  <div key={key} style={{ padding: 10, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontWeight: 700 }}>{key.split('|')[0]}</div>
                    <div style={{ color: '#475569', marginTop: 4 }}>{value || '-'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#94a3b8' }}>Нажми «Показать слова» чтобы увидеть переводы по словам.</div>
            )}
          </section>

          <section style={{ background: '#fff', borderRadius: 16, padding: 16, boxShadow: '0 2px 10px rgba(15, 23, 42, 0.04)' }}>
            <h3 style={{ marginTop: 0 }}>История</h3>
            {history.length === 0 ? (
              <div style={{ color: '#94a3b8' }}>Пока нет записей.</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {history.slice(0, 8).map((h, i) => (
                  <div key={i} style={{ padding: 10, borderRadius: 10, background: '#f8fafc' }}>
                    <div style={{ fontWeight: 700 }}>{h.transcript}</div>
                    <div style={{ color: '#64748b', fontSize: 12 }}>{new Date(h.ts).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={exportHistory}>Экспорт</button>
              <button onClick={clearHistory}>Очистить</button>
            </div>
          </section>
        </aside>
      </div>

      <footer style={{ marginTop: 20, color: '#64748b', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>FR Voice Tutor — учебная платформа для французского.</div>
        <div>
          <input id="email-input" placeholder="Твой email" style={{ padding: 8, borderRadius: 8, marginRight: 8 }} />
          <button onClick={() => {
            const value = document.getElementById('email-input')?.value || ''
            if (!value.includes('@')) return alert('Введи корректный email')
            const prev = safeGet(STORAGE.email, [])
            prev.push({ email: value, ts: Date.now() })
            safeSet(STORAGE.email, prev)
            alert('Спасибо! Мы свяжемся позже.')
          }}>Подписаться</button>
        </div>
      </footer>
    </div>
  )
}
