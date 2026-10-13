import React, { useState, useRef, useEffect } from 'react'

const LANG = 'fr-FR'

const LESSONS = [
  {
    id: 'a1-1',
    title: 'Приветствия (A1)',
    prompts: [
      'Bonjour, comment ça va ? ',
      'Je m’appelle Pierre. Et toi ?',
      'Enchanté de faire ta connaissance.'
    ]
  },
  {
    id: 'a1-2',
    title: 'Заказ в кафе (A1)',
    prompts: [
      'Je voudrais un café, s’il vous plaît.',
      'Combien ça coûte ? ',
      'L’addition, s’il vous plaît.'
    ]
  }
]

const STORAGE = {
  history: 'fr_voice_tutor_history_v3',
  email: 'fr_voice_tutor_email_v3',
  settings: 'fr_voice_tutor_settings_v3'
}

function safeGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function safeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

async function callLanguageTool(text) {
  // Try proxy first (when deployed on Vercel this will call serverless function)
  try {
    const res = await fetch('/api/languagetool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language: 'fr' })
    })
    if (res.ok) return await res.json()
    // fallback
  } catch (e) {
    // ignore and fallback
  }

  // Direct fallback (may fail locally due to CORS)
  const res2 = await fetch('https://api.languagetool.org/v2/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text, language: 'fr' })
  })
  return await res2.json()
}

async function callTranslate(text, source = 'auto', target = 'ru') {
  // Try proxy first
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target })
    })
    if (res.ok) {
      const data = await res.json()
      return data
    }
  } catch (e) {
    // ignore
  }

  // Direct fallback to public LibreTranslate instance (may have CORS issues locally)
  const res2 = await fetch('https://libretranslate.de/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: source === 'auto' ? 'auto' : source, target, format: 'text' })
  })
  return await res2.json()
}

function applyCorrections(text, matches) {
  if (!text) return ''
  if (!matches || matches.length === 0) return text
  const sorted = [...matches].sort((a,b)=> (a.offset||0)-(b.offset||0))
  let out = ''
  let cursor = 0
  for (const m of sorted) {
    const start = m.offset || 0
    const len = m.length || 0
    const rep = (m.replacements && m.replacements[0] && m.replacements[0].value) || text.slice(start, start+len)
    if (start >= cursor) {
      out += text.slice(cursor, start)
      out += rep
      cursor = start + len
    }
  }
  if (cursor < text.length) out += text.slice(cursor)
  return out
}

function scoreSimple(orig, corr) {
  if (!orig) return 0
  if (!corr) return 0
  const a = orig.toLowerCase().replace(/[^\p{L}\s]/gu,'').split(/\s+/).filter(Boolean)
  const b = corr.toLowerCase().replace(/[^\p{L}\s]/gu,'').split(/\s+/).filter(Boolean)
  const max = Math.max(a.length, b.length)
  if (max===0) return 0
  let same = 0
  for (let i=0;i<Math.min(a.length,b.length);i++) if (a[i]===b[i]) same++
  return Math.round((same/max)*100)
}

export default function App() {
  const [mode, setMode] = useState('practice') // practice | lesson
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [corrected, setCorrected] = useState('')
  const [matches, setMatches] = useState([])
  const [status, setStatus] = useState('Готово')
  const [error, setError] = useState(null)

  const [selectedLesson, setSelectedLesson] = useState(LESSONS[0])
  const [lessonIndex, setLessonIndex] = useState(0)
  const [score, setScore] = useState(0)
  const [history, setHistory] = useState(safeGet(STORAGE.history, []))
  const [translation, setTranslation] = useState('')
  const [translateSource, setTranslateSource] = useState('auto')
  const [translateTarget, setTranslateTarget] = useState('ru')
  const recognitionRef = useRef(null)

  useEffect(()=>{ setHistory(safeGet(STORAGE.history,[])) }, [])

  function supportsSR() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition) }

  async function startRecording(expected) {
    setError(null)
    if (!supportsSR()) { setError('SpeechRecognition не поддерживается в этом браузере. Используй Chrome/Edge.') ; return }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang = LANG
    rec.interimResults = false
    rec.maxAlternatives = 1

    rec.onstart = () => { setListening(true); setStatus('Слушаю...') }
    rec.onresult = async (e) => {
      const t = e.results[e.results.length-1][0].transcript
      setTranscript(t)
      setStatus('Проверяю...')
      try {
        const data = await callLanguageTool(t)
        const mm = data.matches || []
        const corr = applyCorrections(t, mm)
        setMatches(mm)
        setCorrected(corr)
        const sc = scoreSimple(t, corr)
        setScore(sc)
        setStatus('Готово')
        // push history
        const entry = { ts: Date.now(), transcript: t, corrected: corr, score: sc, lessonId: selectedLesson.id }
        const prev = safeGet(STORAGE.history, [])
        const next = [entry, ...prev].slice(0,50)
        safeSet(STORAGE.history, next)
        setHistory(next)

        // auto-translate transcript (French -> Russian)
        try {
          const tr = await callTranslate(t, 'fr', 'ru')
          // LibreTranslate returns { translatedText: '...' } sometimes, or { result } — handle both
          const txt = tr.translatedText || tr.translated || tr.result || (tr.data && tr.data.translatedText) || ''
          setTranslation(txt)
        } catch (err) {
          // ignore translate errors
        }

      } catch (err) {
        console.error(err)
        setError('Ошибка проверки: ' + (err.message||err))
        setStatus('Ошибка')
      }
    }
    rec.onerror = (e) => { setError('Ошибка распознавания: '+e.error); setStatus('Ошибка') ; setListening(false) }
    rec.onend = () => { setListening(false); if (status==='Слушаю...') setStatus('Готово') }

    recognitionRef.current = rec
    rec.start()
  }

  function stopRecording() { if (recognitionRef.current) recognitionRef.current.stop(); setListening(false); setStatus('Остановлено') }

  function nextPrompt() {
    setTranscript('')
    setCorrected('')
    setMatches([])
    setScore(0)
    const pCount = selectedLesson.prompts.length
    setLessonIndex((i)=> (i+1)%pCount)
    setTranslation('')
  }

  function speak(text) { if (!text) return; const u = new SpeechSynthesisUtterance(text); u.lang = LANG; const v = speechSynthesis.getVoices().find(x=>x.lang && x.lang.startsWith('fr')); if (v) u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u) }

  async function translateText(text, source = 'auto', target = 'ru') {
    if (!text) return
    setStatus('Перевожу...')
    try {
      const res = await callTranslate(text, source, target)
      const txt = res.translatedText || res.translated || res.result || (res.data && res.data.translatedText) || ''
      setTranslation(txt)
      setStatus('Готово')
      return txt
    } catch (err) {
      console.error(err)
      setError('Ошибка перевода: ' + (err.message||err))
      setStatus('Ошибка')
    }
  }

  async function exportHistory() {
    const data = safeGet(STORAGE.history, [])
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'fr-voice-history.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function clearHistory() { safeSet(STORAGE.history, []); setHistory([]); alert('История очищена') }

  return (
    <div style={{ maxWidth: 1000, margin: '24px auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
        <div>
          <h1 style={{ margin:0 }}>FR Voice Tutor — Stage 3</h1>
          <div style={{ color:'#475569' }}>Режим: {mode}</div>
        </div>
        <div>
          <button onClick={()=>setMode(mode==='practice'?'lesson':'practice') } style={{ marginRight:8 }}>{mode==='practice'?'Перейти в режим урока':'Перейти в практику'}</button>
          <button onClick={()=>exportHistory()}>Экспорт истории</button>
        </div>
      </header>

      <main>
        {mode==='practice' && (
          <section style={{ display:'grid', gridTemplateColumns:'1fr 340px', gap:18 }}>
            <div>
              <div style={{ padding:18, borderRadius:12, background:'#fff', boxShadow:'0 6px 18px rgba(15,23,42,0.06)' }}>
                <h2>Практика (быстрая проверка)</h2>
                <p style={{ color:'#475569' }}>Говори свободно любой короткий текст на французском, приложение проверит и покажет исправления.</p>

                <div style={{ marginTop:12 }}>
                  <button onClick={()=>startRecording()} disabled={listening} style={{ padding:'10px 14px', marginRight:8 }}>{listening? 'Слушаю...':'Говорить'}</button>
                  <button onClick={()=>stopRecording()} disabled={!listening} style={{ padding:'10px 14px', marginRight:8 }}>Остановить</button>
                  <button onClick={()=>speak(corrected || transcript)} style={{ padding:'10px 14px' }}>Прослушать</button>
                </div>

                <div style={{ marginTop:16 }}>
                  <strong>ASR:</strong>
                  <div style={{ padding:12, background:'#f8fafc', borderRadius:8, marginTop:8 }}>{transcript||<span style={{ color:'#94a3b8' }}>Тут будет распознанный текст</span>}</div>
                </div>

                <div style={{ marginTop:12 }}>
                  <strong>Исправленный вариант:</strong>
                  <div style={{ padding:12, background:'#f0fdf4', borderRadius:8, marginTop:8 }}>{corrected||<span style={{ color:'#94a3b8' }}>Здесь появится исправленный текст</span>}</div>
                </div>

                <div style={{ marginTop:12 }}>
                  <strong>Перевод (FR → RU):</strong>
                  <div style={{ padding:12, background:'#fff7ed', borderRadius:8, marginTop:8 }}>{translation||<span style={{ color:'#94a3b8' }}>Здесь появится перевод распознанного текста</span>}</div>
                </div>

                <div style={{ marginTop:12, display:'flex', gap:8, alignItems:'center' }}>
                  <div style={{ fontWeight:700 }}>{score}%</div>
                  <div style={{ color:'#64748b' }}>Оценка совпадения</div>
                </div>

              </div>

              <div style={{ marginTop:16 }}>
                <h3>История</h3>
                <div style={{ background:'#fff', borderRadius:12, padding:12 }}>
                  {history.length===0 ? <div style={{ color:'#94a3b8' }}>История пуста</div> : history.slice(0,8).map((h, idx)=> (
                    <div key={h.ts} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom: idx<7?'1px solid rgba(15,23,42,0.04)':'none' }}>
                      <div>
                        <div style={{ fontWeight:700 }}>{h.transcript}</div>
                        <div style={{ color:'#64748b', fontSize:12 }}>{new Date(h.ts).toLocaleString()}</div>
                      </div>
                      <div style={{ fontWeight:700, color:'#0ea5a4' }}>{h.score}%</div>
                    </div>
                  ))}

                  <div style={{ marginTop:12, display:'flex', gap:8 }}>
                    <button onClick={()=>exportHistory()}>Экспорт</button>
                    <button onClick={()=>clearHistory()}>Очистить</button>
                  </div>
                </div>
              </div>

            </div>

            <aside>
              <div style={{ padding:16, borderRadius:12, background:'#fff' }}>
                <h3>Советы от ИИ</h3>
                <p style={{ color:'#475569' }}>Говори медленнее, фокусируйся на гласных и носовых звуках. Повторяй фразу 3 раза подряд.</p>
                <h4 style={{ marginTop:12 }}>Примеры фраз</h4>
                <ul>
                  <li>Bonjour, comment ça va ?</li>
                  <li>Je voudrais un café, s’il vous plaît.</li>
                  <li>Je me lève tôt tous les jours.</li>
                </ul>
              </div>

              <div style={{ marginTop:12, padding:12, background:'#fff', borderRadius:12 }}>
                <h4>Средняя оценка</h4>
                <div style={{ fontSize:24, fontWeight:700 }}>{history.length? Math.round(history.reduce((a,c)=>a+(c.score||0),0)/history.length):0}%</div>
                <div style={{ color:'#64748b' }}>{history.length} проверок</div>
              </div>
            </aside>
          </section>
        )}

        {mode==='lesson' && (
          <section>
            <div style={{ display:'flex', gap:12, marginBottom:12 }}>
              {LESSONS.map(l=> (
                <button key={l.id} onClick={()=>{ setSelectedLesson(l); setLessonIndex(0); setTranscript(''); setCorrected(''); setMatches([]) }} style={{ padding:'8px 12px', borderRadius:10, background: selectedLesson.id===l.id ? '#e6f6ff':'#fff' }}>{l.title}</button>
              ))}
            </div>

            <div style={{ padding:16, background:'#fff', borderRadius:12 }}>
              <h2>{selectedLesson.title}</h2>
              <p style={{ color:'#475569' }}>Повтори за учителем: нажми «Говорить», произнеси фразу и получи обратную связь.</p>

              <div style={{ marginTop:12, padding:12, borderRadius:10, background:'#f8fafc' }}>
                <strong>Учитель говорит:</strong>
                <div style={{ marginTop:8, fontSize:18 }}>{selectedLesson.prompts[lessonIndex]}</div>
                <div style={{ marginTop:8 }}>
                  <button onClick={()=>speak(selectedLesson.prompts[lessonIndex])} style={{ marginRight:8 }}>Прослушать</button>
                  <button onClick={()=>startRecording(selectedLesson.prompts[lessonIndex])} disabled={listening} style={{ marginRight:8 }}>{listening? 'Слушаю...':'Говорить'}</button>
                  <button onClick={()=>stopRecording()} disabled={!listening}>Остановить</button>
                </div>

                <div style={{ marginTop:12 }}>
                  <strong>Твой ответ:</strong>
                  <div style={{ padding:10, background:'#fff', borderRadius:8, marginTop:6 }}>{transcript||<span style={{ color:'#94a3b8' }}>Нет записи</span>}</div>
                </div>

                <div style={{ marginTop:12 }}>
                  <strong>Исправленный вариант:</strong>
                  <div style={{ padding:10, background:'#f0fff4', borderRadius:8, marginTop:6 }}>{corrected||<span style={{ color:'#94a3b8' }}>—</span>}</div>
                </div>

                <div style={{ marginTop:12, display:'flex', gap:8, alignItems:'center' }}>
                  <div style={{ fontWeight:700 }}>{score}%</div>
                  <div style={{ color:'#64748b' }}>Соответствие эталону</div>
                </div>

                <div style={{ marginTop:12 }}>
                  <button onClick={()=>{ nextPrompt(); setTranscript(''); setCorrected(''); setMatches([]); setScore(0) }}>Следующая фраза</button>
                </div>

              </div>

              <div style={{ marginTop:16 }}>
                <h3>Анализ</h3>
                {matches.length===0 ? <div style={{ color:'#94a3b8' }}>Нет деталей</div> : (
                  <ul>
                    {matches.slice(0,5).map((m,i)=> (<li key={i}><strong>{m.message}</strong> — {m.replacements && m.replacements.slice(0,3).map(r=>r.value).join(', ')}</li>))}
                  </ul>
                )}
              </div>
            </div>

          </section>
        )}

      </main>

      <section style={{ maxWidth:1000, margin:'18px auto' }}>
        <div style={{ padding:12, background:'#fff', borderRadius:10 }}>
          <h3>Перевод текста (FR ⇄ RU)</h3>
          <div style={{ display:'flex', gap:8, marginBottom:8 }}>
            <select value={translateSource} onChange={(e)=>setTranslateSource(e.target.value)}>
              <option value="auto">auto</option>
              <option value="fr">fr</option>
              <option value="ru">ru</option>
            </select>
            <select value={translateTarget} onChange={(e)=>setTranslateTarget(e.target.value)}>
              <option value="ru">ru</option>
              <option value="fr">fr</option>
            </select>
          </div>

          <div style={{ display:'flex', gap:8 }}>
            <textarea id="translate-input" placeholder="Введите текст или вставьте" style={{ flex:1, padding:10 }}></textarea>
            <div style={{ width:160, display:'flex', flexDirection:'column', gap:8 }}>
              <button onClick={async ()=>{ const txt = (document.getElementById('translate-input')||{}).value; await translateText(txt, translateSource, translateTarget) }}>Перевести</button>
              <button onClick={()=>{ (document.getElementById('translate-input').value = transcript || ''); setTranslateSource('fr'); setTranslateTarget('ru'); }}>Заполнить из распознавания</button>
              <button onClick={()=>{ (document.getElementById('translate-input').value = corrected || ''); setTranslateSource('fr'); setTranslateTarget('ru'); }}>Заполнить из исправленного</button>
            </div>
          </div>

          <div style={{ marginTop:12, padding:10, background:'#fbfbff', borderRadius:8 }}>
            <strong>Результат перевода:</strong>
            <div style={{ marginTop:8 }}>{translation || <span style={{ color:'#94a3b8' }}>Здесь появится перевод</span>}</div>
          </div>
        </div>
      </section>

      <footer style={{ marginTop:20, color:'#64748b' }}>
        <div style={{ display:'flex', justifyContent:'space-between', gap:12 }}>
          <div>FR Voice Tutor — бесплатный прототип. В будущем: глубокая оценка произношения, профили пользователей и уроки.</div>
          <div>
            <input id="email-v3" placeholder="Твой email" style={{ padding:8, borderRadius:8 }} />
            <button onClick={()=>{ const e = (document.getElementById('email-v3')||{}).value; if (!e||!e.includes('@')) return alert('Введи email'); const prev = safeGet(STORAGE.email,[]); prev.push({email:e,ts:Date.now()}); safeSet(STORAGE.email,prev); alert('Спасибо!')}} style={{ marginLeft:8 }}>Подписаться</button>
          </div>
        </div>
      </footer>
    </div>
  )
}
