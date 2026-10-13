// Simple Vercel Serverless function: proxy to LanguageTool to avoid CORS in browser
// Place this file under /api/languagetool.js — Vercel will expose it at /api/languagetool

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    // body might already be a URLSearchParams string depending on client
    const text = req.body?.text || req.body?.get?.('text') || ''
    const language = req.body?.language || 'fr'

    const params = new URLSearchParams()
    params.append('text', text)
    params.append('language', language)

    const response = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })

    const data = await response.json()
    res.status(200).json(data)
  } catch (err) {
    console.error('Proxy error', err)
    res.status(500).json({ error: 'proxy_failed', message: err.message })
  }
}
