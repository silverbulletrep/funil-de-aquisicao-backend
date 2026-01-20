import { Router, type Request, type Response } from 'express'
import dotenv from 'dotenv'
import axios from 'axios'
import { sendEventViaPhp } from '../lib/phpCapi.js'

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
    const form = new URLSearchParams()
    form.set('grant_type', 'client_credentials')
    const resp = await axios.post<{ access_token: string }>(
      `${API_BASE}/v1/oauth2/token`,
      form.toString(),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
      },
    )
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`OAuth failed: ${resp.status} ${JSON.stringify(resp.data)}`)
    }
    console.log('[PAYPAL] Operação concluída com sucesso: oauth', {
      id_resultado: 'token_obtido',
      timestamp: new Date().toISOString(),
    })
    return resp.data.access_token
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    throw error
  }
}

router.get('/health', async (req: Request, res: Response): Promise<void> => {
  try {
    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV, FRONTEND_URL } = getEnv()
    res.status(200).json({
      success: true,
      configured: !!PAYPAL_CLIENT_ID && !!PAYPAL_SECRET,
      env: PAYPAL_ENV,
      frontend_url: FRONTEND_URL,
    })
  } catch (err: unknown) {
    const error = err as { message?: string }
    res.status(500).json({ success: false, error: error?.message || 'health failed' })
  }
})

router.post('/create-order', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'paypal.create_order'
  const dados_entrada = {
    currency: (req.body?.currency || 'EUR').toUpperCase(),
    value: String(req.body?.value ?? '37.00'),
    metadata: req.body?.metadata || {},
  }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })
    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, API_BASE, FRONTEND_URL } = getEnv()
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
      res.status(500).json({ success: false, error: 'PayPal não configurado: defina PAYPAL_CLIENT_ID e PAYPAL_SECRET' })
      return
    }
    const currency = String(dados_entrada.currency).toUpperCase()
    const valueStr = String(dados_entrada.value)
    const valueNum = Number(valueStr)
    if (!Number.isFinite(valueNum)) {
      res.status(400).json({ success: false, error: 'Valor inválido' })
      return
    }
    const valueCents = Math.round(valueNum * 100)
    const allowedEUR = [100, 2400, 3700, 4700] // 100 = 1.00 EUR (Teste)
    const allowedBRL = [100, 990, 1470, 1980] // 100 = 1.00 BRL (Teste)
    if ((currency === 'EUR' && !allowedEUR.includes(valueCents)) || (currency === 'BRL' && !allowedBRL.includes(valueCents))) {
      res.status(400).json({ success: false, error: 'Valor selecionado inválido' })
      return
    }
    const token = await getAccessToken()
    const returnBase = (req.headers.origin && String(req.headers.origin)) || FRONTEND_URL
    const base = String(returnBase).replace(/\/$/, '')
    const origin = String((dados_entrada.metadata?.origin || 'fim')).toLowerCase()
    const testEventCode = dados_entrada.metadata?.test_event_code || ''
    const customId = `origin=${encodeURIComponent(origin)}&test_event_code=${encodeURIComponent(testEventCode)}`
    
    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: dados_entrada.currency,
            value: dados_entrada.value,
          },
          custom_id: customId,
        },
      ],
      application_context: {
        return_url: `${base}/checkout-success`,
        cancel_url: `${base}/checkout-cancel`,
        brand_name: 'Inner Peace',
        user_action: 'PAY_NOW',
      },
    }
    const resp = await axios.post<{ id?: string; links?: Array<{ rel?: string; href?: string }> }>(
      `${API_BASE}/v2/checkout/orders`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      },
    )
    const json = resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Create order failed: ${resp.status} ${JSON.stringify(json)}`)
    }
    console.log('[PAYPAL] Operação concluída com sucesso: create_order', {
      id_resultado: json?.id,
      timestamp: new Date().toISOString(),
    })
    const approve = Array.isArray(json?.links) ? json.links.find((l) => l?.rel === 'approve')?.href : null
    res.status(200).json({ success: true, id: json?.id, approve_url: approve })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ success: false, error: error.message || 'Falha ao criar pedido' })
  }
})

router.post('/capture-order', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'paypal.capture_order'
  const dados_entrada = { orderID: String(req.body?.orderID || ''), fbp: req.body?.fbp, fbc: req.body?.fbc }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })
    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, API_BASE } = getEnv()
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
      res.status(500).json({ success: false, error: 'PayPal não configurado: defina PAYPAL_CLIENT_ID e PAYPAL_SECRET' })
      return
    }
    const token = await getAccessToken()
    const orderId = dados_entrada.orderID
    if (!orderId) {
      res.status(400).json({ success: false, error: 'orderID é obrigatório' })
      return
    }
    const resp = await axios.post<{ id?: string; status?: string; purchase_units?: Array<unknown> }>(
      `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      null,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      },
    )
    const json = resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Capture failed: ${resp.status} ${JSON.stringify(json)}`)
    }
    console.log('[PAYPAL] Operação concluída com sucesso: capture_order', {
      id_resultado: json?.id || orderId,
      status: json?.status,
      timestamp: new Date().toISOString(),
    })
    try {
      const status = String(json?.status || '').toUpperCase()
      type PayPalPurchaseUnit = {
        custom_id?: string
        amount?: { currency_code?: string; value?: string }
        payments?: { captures?: Array<{ amount?: { currency_code?: string; value?: string } }> }
      }
      const pu = (Array.isArray(json?.purchase_units) ? (json.purchase_units[0] as PayPalPurchaseUnit) : null)
      const customId = String(pu?.custom_id || '')
      
      // Parse custom_id (querystring style)
      const params = new URLSearchParams(customId)
      const origin = params.get('origin') || 'fim'
      const testEventCode = params.get('test_event_code') || undefined

      if (status === 'COMPLETED' && pu) {
        const currency = String(
          pu?.payments?.captures?.[0]?.amount?.currency_code || pu?.amount?.currency_code || 'EUR',
        )
        const valueStr = String(
          pu?.payments?.captures?.[0]?.amount?.value || pu?.amount?.value || '0',
        )
        const value = Number(valueStr)
        const base = process.env.FRONTEND_URL || 'http://localhost:3002'
        const srcUrl = `${String(base).replace(/\/$/, '')}${String(origin).includes('upsell') ? '/audio-upsell' : '/fim'}`
        const ua = String(req.headers['user-agent'] || '') || null
        
        // Disparar CAPI via PHP (Centralizado)
        const payload = {
          event_id: `paypal:${json?.id || orderId}`,
          event_source_url: srcUrl,
          fbp: (typeof req.body?.fbp === 'string') ? req.body.fbp : undefined,
          fbc: (typeof req.body?.fbc === 'string') ? req.body.fbc : undefined,
          user_agent: ua || undefined,
          currency,
          value,
          test_event_code: testEventCode,
          email: undefined // PayPal geralmente retorna no payer info, mas aqui simplificamos
        }
        
        const respCapi = await sendEventViaPhp(payload)
        console.log('[PAYPAL] CAPI disparado via PHP', { success: respCapi.success, php_event_id: respCapi.event_id })
      }
    } catch (capErr: unknown) {
      const e = capErr as { message?: string }
      console.error('[PAYPAL] Erro ao enviar CAPI após capture', { message: e?.message })
    }
    res.status(200).json({ success: true, data: json })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ success: false, error: error.message || 'Falha ao capturar pedido' })
  }
})

export default router
