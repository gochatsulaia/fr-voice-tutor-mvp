import React, { useState, useRef } from 'react'

const LANG = 'fr-FR'

export default function App() {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [corrected, setCorrected] = useState('')
  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('Готово')
  const [error, setError] = useState(null)
  const recognitionRef = useRef(null)

  function supportsSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function startRecording() {
    setError(null)
    if (!supportsSpeechRecognition()) {
      setError('SpeechRecognition не поддерживается в этом браузере')
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

    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript
      setTranscript(text)
      setStatus('Обрабатываю текст...')
      checkGrammar(text)
    }

    recognition.onerror = (e) => {
      setError('Ошибка распознавания: ' + e.error)
      setListening(false)
      setStatus('Ошибка')
    }

    recognition.onend = () => {
      setListening(false)
      if (status === 'Слушаю... говори 5–15 секунд') setStatus('Готово')
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

      const res = await fetch('https://api.languagetool.org/v2/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })

      if (!res.ok) {
        throw new Error('LanguageTool API error ' + res.status)
      }

      const data = await res.json()
      setMatches(data.matches || [])
      const correctedText = applyCorrections(text, data.matches || [])
      setCorrected(correctedText)
      setStatus('Готово')
    } catch (err) {
      console.error(err)
      setError('Ошибка проверки: ' + err.message)
      setStatus('Ошибка')
    }
  }

  function applyCorrections(text, matches) {
    if (!matches || matches.length === 0) return text
    // Sort by offset
    const sorted = [...matches].sort((a, b) => a.offset - b.offset)
    let out = ''
    let cursor = 0
    for (const m of sorted) {
      const start = m.offset
      const len = m.length
      if (cursor <= start) {
        out += text.slice(cursor, start)
        const replacement = (m.replacements && m.replacements[0] && m.replacements[0].value) || text.slice(start, start + len)
        out += replacement
        cursor = start + len
      }
    }
    if (cursor < text.length) out += text.slice(cursor)
    return out
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) {
      setError('SpeechSynthesis не поддерживается в этом браузере')
      return
    }
    const ut = new SpeechSynthesisUtterance(text)
    ut.lang = LANG
    const voices = speechSynthesis.getVoices()
    // Try to choose a French voice
    const voice = voices.find(v => v.lang && v.lang.startsWith('fr'))
    if (voice) ut.voice = voice
    speechSynthesis.cancel()
    speechSynthesis.speak(ut)
  }

  function renderDiff(orig, corr) {
    const a = orig.trim().split(/\s+/)
    const b = corr.trim().split(/\s+/)
    const len = Math.max(a.length, b.length)
    const parts = []
    for (let i = 0; i < len; i++) {
      const wa = a[i] || ''
      const wb = b[i] || ''
      if (!wa && wb) {
        parts.push(<span key={i} className="added">{wb} </span>)
      } else if (wa && !wb) {
        parts.push(<span key={i} className="removed">{wa} </span>)
      } else if (wa === wb) {
        parts.push(<span key={i} className="same">{wa} </span>)
      } else {
        parts.push(<span key={i} className="changed">{wb} </span>)
      }
    }
    return parts
  }

  async function shareResult() {
    const summary = `Я сказал: ${transcript}\nИсправлено: ${corrected}`
    if (navigator.share) {
      try {
        await navigator.share({ title: 'FR Voice Tutor', text: summary })
      } catch (e) {
        console.error(e)
      }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(summary)
      alert('Результат скопирован в буфер обмена')
    } else {
      prompt('Скопируй результат:', summary)
    }
  }

  return (
    <div className="container">
      <h1>FR Voice Tutor — MVP</h1>
      <p className="lead">Практикуй французскую речь: говори, получай исправления и слушай правильное произношение.</p>

      <div className="controls">
        <button onClick={startRecording} disabled={listening} className="btn primary">Говорить</button>
        <button onClick={stopRecording} disabled={!listening} className="btn">Остановить</button>
        <button onClick={() => { if (transcript) checkGrammar(transcript) }} className="btn">Повторно проверить</button>
        <button onClick={() => speak(corrected || transcript)} className="btn">Прослушать правильный вариант</button>
        <button onClick={shareResult} className="btn">Поделиться</button>
      </div>

      <div className="panel">
        <div className="panel-block">
          <h3>ASR (что распознано)</h3>
          <div className="box">{transcript || <em>Нет транскрипта</em>}</div>
        </div>

        <div className="panel-block">
          <h3>Исправленный вариант</h3>
          <div className="box">{corrected || <em>Нет исправлений</em>}</div>
          <div className="diff">{renderDiff(transcript || '', corrected || '')}</div>
        </div>

        <div className="panel-block">
          <h3>Детали проверки</h3>
          {matches.length === 0 ? <div className="box"><em>Ошибок не найдено или ещё не проверено.</em></div> : (
            <ul>
              {matches.map((m, i) => (
                <li key={i}><strong>{m.message}</strong> — <em>предложения:</em> {m.replacements && m.replacements.slice(0,3).map(r => r.value).join(', ')}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="status">Статус: {status} {error && <span className="error"> — {error}</span>}</div>

      <footer>
        <p>Собираем почту для оповещений и улучшений. Пока всё бесплатно.</p>
        <SignupForm />
      </footer>
    </div>
  )
}

function SignupForm() {
  const [email, setEmail] = useState('')
  const [saved, setSaved] = useState(false)

  function save() {
    if (!email.includes('@')) return alert('Введи корректный email')
    // На MVP просто сохраняем в localStorage и даём почту через mailto для владельца
    const list = JSON.parse(localStorage.getItem('emails') || '[]')
    list.push({ email, ts: Date.now() })
    localStorage.setItem('emails', JSON.stringify(list))
    setSaved(true)
    // Можно открывать почтовый клиент для уведомлений владельцу
    window.location.href = `mailto:you@example.com?subject=Подписка FR Voice Tutor&body=Добавить ${email}`
  }

  return (
    <div className="signup">
      <input placeholder="Твой email" value={email} onChange={e => setEmail(e.target.value)} />
      <button onClick={save} className="btn">Подписаться</button>
      {saved && <div className="note">Спасибо! Мы свяжемся с тобой.</div>}
    </div>
  )
}
