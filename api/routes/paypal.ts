import { Router, type Request, type Response } from 'express'
import dotenv from 'dotenv'

dotenv.config()

const router = Router()

function getEnv() {
  dotenv.config({ override: true })
  const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || ''
  const PAYPAL_SECRET = process.env.PAYPAL_SECRET || ''
  const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'live').toLowerCase()
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3002'
  const API_BASE = PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'
  return { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV, FRONTEND_URL, API_BASE }
}

async function getAccessToken(): Promise<string> {
  const operacao = 'paypal.oauth_token'
  const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, API_BASE, PAYPAL_ENV } = getEnv()
  const dados_entrada = { client_id: !!PAYPAL_CLIENT_ID, secret: !!PAYPAL_SECRET, env: PAYPAL_ENV }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64')
    const res = await fetch(`${API_BASE}/v1/oauth2/token`, { method: 'POST', headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
    if (!res.ok) { const text = await res.text(); throw new Error(`OAuth failed: ${res.status} ${text}`) }
    const json = await res.json() as { access_token: string }
    console.log('[PAYPAL] Operação concluída com sucesso: oauth', { id_resultado: 'token_obtido', timestamp: new Date().toISOString() })
    return json.access_token
  } catch (error: any) {
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, { dados_entrada, stack: error.stack, timestamp: new Date().toISOString() })
    throw error
  }
}

router.get('/health', async (req: Request, res: Response): Promise<void> => {
  try {
    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV, FRONTEND_URL } = getEnv()
    res.status(200).json({ success: true, configured: !!PAYPAL_CLIENT_ID && !!PAYPAL_SECRET, env: PAYPAL_ENV, frontend_url: FRONTEND_URL })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'health failed' })
  }
})

router.post('/create-order', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'paypal.create_order'
  const dados_entrada = { currency: String(((req as any)?.body?.currency || 'EUR')).toUpperCase(), value: String(((req as any)?.body?.value ?? '37.00')), metadata: (req as any)?.body?.metadata || {} }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })
    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, API_BASE, FRONTEND_URL } = getEnv()
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) { res.status(500).json({ success: false, error: 'PayPal não configurado: defina PAYPAL_CLIENT_ID e PAYPAL_SECRET' }); return }
    const currency = String(dados_entrada.currency).toUpperCase()
    const valueStr = String(dados_entrada.value)
    const valueNum = Number(valueStr)
    if (!Number.isFinite(valueNum)) { res.status(400).json({ success: false, error: 'Valor inválido' }); return }
    const valueCents = Math.round(valueNum * 100)
    const allowedEUR = [2400, 3700, 4700]
    const allowedBRL = [990, 1470, 1980]
    if ((currency === 'EUR' && !allowedEUR.includes(valueCents)) || (currency === 'BRL' && !allowedBRL.includes(valueCents))) { res.status(400).json({ success: false, error: 'Valor selecionado inválido' }); return }
    const token = await getAccessToken()
    const returnBase = ((req as any)?.headers?.origin && String((req as any)?.headers?.origin)) || FRONTEND_URL
    const base = String(returnBase).replace(/\/$/, '')
    const body = { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: dados_entrada.currency, value: dados_entrada.value } }], application_context: { return_url: `${base}/checkout-success`, cancel_url: `${base}/checkout-cancel`, brand_name: 'Inner Peace', user_action: 'PAY_NOW' } }
    const resp = await fetch(`${API_BASE}/v2/checkout/orders`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await resp.json() as any
    if (!resp.ok) { throw new Error(`Create order failed: ${resp.status} ${JSON.stringify(json)}`) }
    console.log('[PAYPAL] Operação concluída com sucesso: create_order', { id_resultado: json?.id, timestamp: new Date().toISOString() })
    const approve = Array.isArray(json?.links) ? json.links.find((l: any) => l?.rel === 'approve')?.href : null
    res.status(200).json({ success: true, id: json?.id, approve_url: approve })
  } catch (error: any) {
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, { dados_entrada, stack: error.stack, timestamp: new Date().toISOString() })
    res.status(500).json({ success: false, error: error?.message || 'Falha ao criar pedido' })
  }
})

router.post('/capture-order', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'paypal.capture_order'
  const dados_entrada = { orderID: String(((req as any)?.body?.orderID || '')) }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })
    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, API_BASE } = getEnv()
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) { res.status(500).json({ success: false, error: 'PayPal não configurado: defina PAYPAL_CLIENT_ID e PAYPAL_SECRET' }); return }
    const token = await getAccessToken()
    const orderId = dados_entrada.orderID
    if (!orderId) { res.status(400).json({ success: false, error: 'orderID é obrigatório' }); return }
    const resp = await fetch(`${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } })
    const json = await resp.json() as any
    if (!resp.ok) { throw new Error(`Capture failed: ${resp.status} ${JSON.stringify(json)}`) }
    console.log('[PAYPAL] Operação concluída com sucesso: capture_order', { id_resultado: json?.id || orderId, status: json?.status, timestamp: new Date().toISOString() })
    res.status(200).json({ success: true, data: json })
  } catch (error: any) {
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, { dados_entrada, stack: error.stack, timestamp: new Date().toISOString() })
    res.status(500).json({ success: false, error: error?.message || 'Falha ao capturar pedido' })
  }
})

export default router
