// Serverless proxy for LibreTranslate
// Deploying on Vercel: place under /api/translate.js and it will be available at /api/translate

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    // Expect JSON body: { q: 'text', source: 'auto'|'fr'|'ru', target: 'ru'|'fr' }
    const body = req.body || {}
    // Some platforms send urlencoded body; handle both
    const q = body.q || (req.body && req.body.get && req.body.get('q')) || ''
    const source = body.source || 'auto'
    const target = body.target || 'ru'

    const payload = {
      q: q,
      source: source,
      target: target,
      format: 'text'
    }

    const response = await fetch('https://libretranslate.de/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const data = await response.json()
    // LibreTranslate returns { translatedText: '...' }
    res.status(200).json(data)
  } catch (err) {
    console.error('Translate proxy error', err)
    res.status(500).json({ error: 'proxy_failed', message: err.message })
  }
}
