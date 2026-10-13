import React, { useState, useRef, useEffect } from 'react'

const LANG = 'fr-FR'

const SAMPLE_PHRASES = [
  { id: 1, label: 'Приветствие', text: 'Bonjour, comment ça va ?', accent: 'Базовый диалог' },
  { id: 2, label: 'Покупки', text: 'Je voudrais un café, s’il vous plaît.', accent: 'Покупки и повседневная речь' },
  { id: 3, label: 'Утро', text: 'Je me lève tôt et je prends le petit-déjeuner.', accent: 'Режим дня' },
  { id: 4, label: 'Работа', text: 'Je travaille bien et j’apprends le français tous les jours.', accent: 'Мотивация' },
  { id: 5, label: 'Путешествие', text: 'Je veux visiter Paris et parler avec des gens locaux.', accent: 'Путешествия' },
  { id: 6, label: 'Чувства', text: 'Je suis très content d’apprendre le français.', accent: 'Личное выражение' },
]

const STORAGE_KEYS = {
  history: 'fr_voice_tutor_history_v2',
  email: 'fr_voice_tutor_email_v2',
}

function safeStorageGet(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const val = localStorage.getItem(key)
    return val ? JSON.parse(val) : fallback
  } catch {
    return fallback
  }
}

function safeStorageSet(key, value) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

function computeScore(transcript, corrected) {
  const source = (transcript || '').trim()
  const target = (corrected || '').trim()
  if (!source && !target) return 0
  if (!source) return 0
  if (source === target) return 100

  const normalize = (value) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean)

  const a = normalize(source)
  const b = normalize(target)
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 0

  let same = 0
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i++) {
    if (a[i] === b[i]) same += 1
  }

  const similarity = (same / maxLen) * 100
  return Math.max(0, Math.min(100, Math.round(similarity)))
}

function generateCoachAdvice(transcript, corrected, matches) {
  if (!transcript) {
    return 'Нажми «Говорить» и попробуй одну короткую фразу.'
  }

  if (corrected === transcript) {
    return 'Отлично! Фраза звучит хорошо. Попробуй усложнить её и добавить ещё один глагол или обстоятельство.'
  }

  const list = []
  const text = (matches || []).map(m => (m.message || '')).join(' ').toLowerCase()

  if (text.includes('article') || text.includes('determin')) {
    list.push('Проверь артикли: le, la, les, un, une — они очень важны в французском.')
  }
  if (text.includes('verb') || text.includes('conjug')) {
    list.push('Проверь форму глагола: часто ошибка в окончании или в согласовании с подлежащим.')
  }
  if (text.includes('accen') || text.includes('apostrophe') || text.includes('letter')) {
    list.push('Обрати внимание на ударения и апострофы: в французском они сильно влияют на звучание.')
  }
  if (text.includes('singular') || text.includes('plural') || text.includes('gender')) {
    list.push('Проверь род и число: многие ошибки появляются в окончании прилагательных и существительных.')
  }
  if (list.length === 0) {
    list.push('Повторяй короткую фразу 2–3 раза. Главное — замедлить темп и разделить слова по слогам.')
    list.push('Сфокусируйся на произношении гласных: a, e, i, o, u и носовых звуков.')
  }

  return list.join(' ')
}

function applyCorrections(text, matches) {
  if (!text) return ''
  if (!matches || matches.length === 0) return text

  const sorted = [...matches].sort((a, b) => (a.offset || 0) - (b.offset || 0))
  let output = ''
  let cursor = 0

  for (const item of sorted) {
    const start = item.offset || 0
    const length = item.length || 0
    const replacement =
      (item.replacements && item.replacements[0] && item.replacements[0].value) || text.slice(start, start + length)

    if (start >= cursor) {
      output += text.slice(cursor, start)
      output += replacement
      cursor = start + length
    }
  }

  if (cursor < text.length) {
    output += text.slice(cursor)
  }

  return output
}

export default function App() {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [corrected, setCorrected] = useState('')
  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('Готово')
  const [error, setError] = useState(null)
  const [selectedPhrase, setSelectedPhrase] = useState(SAMPLE_PHRASES[0].text)
  const [score, setScore] = useState(0)
  const [history, setHistory] = useState([])
  const [coachAdvice, setCoachAdvice] = useState('Нажми «Говорить» и начни тренировку.')
  const recognitionRef = useRef(null)

  useEffect(() => {
    const saved = safeStorageGet(STORAGE_KEYS.history, [])
    setHistory(saved)
  }, [])

  function supportsSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function pushHistory(entry) {
    const prev = safeStorageGet(STORAGE_KEYS.history, [])
    const next = [entry, ...prev].slice(0, 8)
    safeStorageSet(STORAGE_KEYS.history, next)
    setHistory(next)
  }

  function startRecording() {
    setError(null)

    if (!supportsSpeechRecognition()) {
      setError('SpeechRecognition не поддерживается в этом браузере. Попробуй Chrome или Edge.')
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.lang = LANG
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setListening(true)
      setStatus('Слушаю... говори 5–15 секунд')
    }

    recognition.onresult = async (event) => {
      const nextText = event.results[event.results.length - 1][0].transcript
      setTranscript(nextText)
      setStatus('Обрабатываю текст...')
      await checkGrammar(nextText)
    }

    recognition.onerror = (e) => {
      setError('Ошибка распознавания: ' + e.error)
      setListening(false)
      setStatus('Ошибка распознавания')
    }

    recognition.onend = () => {
      setListening(false)
      setStatus((current) => current === 'Слушаю... говори 5–15 секунд' ? 'Готово' : current)
    }

    recognitionRef.current = recognition
    recognition.start()
  }

  function stopRecording() {
    if (recognitionRef.current) recognitionRef.current.stop()
    setListening(false)
    setStatus('Остановлено')
  }

  async function checkGrammar(text) {
    try {
      setError(null)
      const params = new URLSearchParams()
      params.append('text', text)
      params.append('language', 'fr')

      const response = await fetch('https://api.languagetool.org/v2/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })

      let matchesList = []
      let correctedText = text

      if (response.ok) {
        const data = await response.json()
        matchesList = data.matches || []
        correctedText = applyCorrections(text, matchesList)
      } else {
        correctedText = text
        matchesList = []
      }

      const nextScore = computeScore(text, correctedText)
      setMatches(matchesList)
      setCorrected(correctedText)
      setScore(nextScore)
      setCoachAdvice(generateCoachAdvice(text, correctedText, matchesList))
      setStatus('Готово')

      pushHistory({
        transcript: text,
        corrected: correctedText,
        score: nextScore,
        ts: Date.now(),
      })
    } catch (err) {
      console.error(err)
      setError('Ошибка проверки: ' + err.message)
      setStatus('Ошибка проверки')
    }
  }

  function speak(text) {
    if (!text) return
    if (!('speechSynthesis' in window)) {
      setError('SpeechSynthesis не поддерживается в этом браузере')
      return
    }

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = LANG
    const voices = speechSynthesis.getVoices()
    const frenchVoice = voices.find((voice) => voice.lang && voice.lang.toLowerCase().startsWith('fr'))
    if (frenchVoice) utterance.voice = frenchVoice

    speechSynthesis.cancel()
    speechSynthesis.speak(utterance)
  }

  function renderDiff(orig, corr) {
    const a = (orig || '').trim().split(/\s+/).filter(Boolean)
    const b = (corr || '').trim().split(/\s+/).filter(Boolean)
    const len = Math.max(a.length, b.length)
    const parts = []

    for (let i = 0; i < len; i++) {
      const wa = a[i] || ''
      const wb = b[i] || ''
      if (!wa && wb) {
        parts.push(<span key={`add-${i}`} className="diff-added">{wb} </span>)
      } else if (wa && !wb) {
        parts.push(<span key={`rem-${i}`} className="diff-removed">{wa} </span>)
      } else if (wa === wb) {
        parts.push(<span key={`same-${i}`} className="diff-same">{wa} </span>)
      } else {
        parts.push(<span key={`chg-${i}`} className="diff-changed">{wb} </span>)
      }
    }

    return parts.length ? parts : <span className="muted">Пока нет сравнения</span>
  }

  async function shareResult() {
    const summary = `Я сказал: ${transcript}\nИсправлено: ${corrected}\nОценка: ${score}/100`

    if (navigator.share) {
      try {
        await navigator.share({ title: 'FR Voice Tutor', text: summary })
      } catch (e) {
        console.error(e)
      }
      return
    }

    if (navigator.clipboard) {
      await navigator.clipboard.writeText(summary)
      alert('Результат скопирован в буфер обмена')
      return
    }

    prompt('Скопируй результат:', summary)
  }

  function saveEmail() {
    const input = document.getElementById('email-input')
    const email = input ? input.value : ''
    if (!email || !email.includes('@')) {
      alert('Введите корректный email')
      return
    }

    const prev = safeStorageGet(STORAGE_KEYS.email, [])
    const next = [...prev, { email, ts: Date.now() }]
    safeStorageSet(STORAGE_KEYS.email, next)
    input.value = ''
    alert('Спасибо! Ты подписан на обновления.')
  }

  const todayCount = history.filter((entry) => {
    const date = new Date(entry.ts)
    const now = new Date()
    return date.toDateString() === now.toDateString()
  }).length

  const averageScore = history.length
    ? Math.round(history.reduce((acc, item) => acc + (item.score || 0), 0) / history.length)
    : 0

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="pill">Free MVP</span>
          <h1>FR Voice Tutor</h1>
        </div>
        <button className="ghost-btn" onClick={() => speak(corrected || selectedPhrase)}>Слушать пример</button>
      </header>

      <section className="hero card">
        <div>
          <p className="eyebrow">Практика французского языка</p>
          <h2>Говори, получай исправления и учись быстрее.</h2>
          <p className="subtext">
            Этот MVP позволяет тебе произнести фразу, услышать корректный вариант и понять, где была ошибка.
          </p>
        </div>

        <div className="stats-grid">
          <div className="stat-box">
            <strong>{todayCount}</strong>
            <span>Сегодня</span>
          </div>
          <div className="stat-box">
            <strong>{averageScore}%</strong>
            <span>Средний балл</span>
          </div>
          <div className="stat-box">
            <strong>{history.length}</strong>
            <span>Проверок</span>
          </div>
        </div>
      </section>

      <section className="practice-row">
        <div className="card phrase-card">
          <h3>Примеры фраз</h3>
          <div className="phrase-list">
            {SAMPLE_PHRASES.map((phrase) => (
              <button
                key={phrase.id}
                className={`phrase-btn ${selectedPhrase === phrase.text ? 'active' : ''}`}
                onClick={() => {
                  setSelectedPhrase(phrase.text)
                  setTranscript('')
                  setCorrected('')
                  setMatches([])
                  setCoachAdvice(`Попробуй сказать: “${phrase.text}”`)
                }}
              >
                <span>{phrase.label}</span>
                <small>{phrase.accent}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="card coach-card">
          <h3>ИИ-советник</h3>
          <p>{coachAdvice}</p>
          <div className="score-box">
            <span>Текущий результат</span>
            <strong>{score}%</strong>
          </div>
        </div>
      </section>

      <section className="card action-card">
        <div className="controls">
          <button className="primary-btn" onClick={startRecording} disabled={listening}>
            {listening ? 'Слушаю...' : 'Говорить'}
          </button>
          <button className="secondary-btn" onClick={stopRecording} disabled={!listening}>Остановить</button>
          <button className="secondary-btn" onClick={() => speak(corrected || selectedPhrase)}>Прослушать</button>
          <button className="secondary-btn" onClick={shareResult}>Поделиться</button>
        </div>

        <div className="status-row">
          <div className="status-tag">{status}</div>
          {error && <div className="error-tag">{error}</div>}
        </div>
      </section>

      <section className="results-grid">
        <div className="card result-card">
          <h3>Что ты сказал</h3>
          <div className="result-box">
            {transcript || <span className="muted">Пока нет записи. Нажми «Говорить».</span>}
          </div>
        </div>

        <div className="card result-card">
          <h3>Правильный вариант</h3>
          <div className="result-box corrected-box">
            {corrected || <span className="muted">Здесь появится правильная формулировка.</span>}
          </div>
          <div className="diff-box">{renderDiff(transcript, corrected)}</div>
        </div>
      </section>

      <section className="card insights-card">
        <h3>Проверка и анализ</h3>
        {matches.length === 0 ? (
          <p className="muted">Пока нет деталей. Сначала произнеси фразу и дождись проверки.</p>
        ) : (
          <ul className="insight-list">
            {matches.slice(0, 4).map((item, index) => (
              <li key={`${item.message}-${index}`}>
                <strong>{item.message}</strong>
                {item.replacements && item.replacements.length > 0 && (
                  <span> — возможно: {item.replacements.slice(0, 2).map((r) => r.value).join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card history-card">
        <h3>История практики</h3>
        {history.length === 0 ? (
          <p className="muted">Пока нет записей — начни сегодня с одной короткой фразы.</p>
        ) : (
          <div className="history-list">
            {history.map((item, index) => (
              <div key={`${item.ts}-${index}`} className="history-item">
                <div>
                  <strong>{item.transcript || '—'}</strong>
                  <small>{new Date(item.ts).toLocaleString('ru-RU')}</small>
                </div>
                <span>{item.score}%</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="card signup-card">
        <div>
          <h3>Бесплатные обновления</h3>
          <p>Подпишись, чтобы узнавать о новых функциях, бесплатных уроках и улучшениях.</p>
        </div>
        <div className="signup-row">
          <input id="email-input" type="email" placeholder="Твой e-mail" />
          <button className="primary-btn" onClick={saveEmail}>Подписаться</button>
        </div>
      </footer>
    </div>
  )
}
