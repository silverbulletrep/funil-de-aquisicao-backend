import { Router, type Request, type Response } from 'express'
import dotenv from 'dotenv'
import axios from 'axios'
import { sendPurchaseToN8N } from '../lib/n8n.js'
import { buildMetaPurchasePayload, sendMetaPurchaseEvent } from '../lib/metaCapi.js'

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

async function sendPurchaseToMetaCAPI(payload: Parameters<typeof buildMetaPurchasePayload>[0]) {
  const operacao = 'paypal.meta_capi_purchase'
  const dados_entrada = { event_id: payload.event_id }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })
    const resp = await sendMetaPurchaseEvent(buildMetaPurchasePayload(payload))
    console.log('[PAYPAL] CAPI disparado com sucesso', { success: resp.success, status: resp.status })
    return resp
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('[PAYPAL] Erro ao enviar CAPI', { message: e?.message })
    return { success: false, error: e?.message || 'Falha ao enviar CAPI' }
  }
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
    const allowedEUR = [2400, 3700, 4700]
    const allowedBRL = [100, 990, 1470, 1980]
    if ((currency === 'EUR' && !allowedEUR.includes(valueCents)) || (currency === 'BRL' && !allowedBRL.includes(valueCents))) {
      res.status(400).json({ success: false, error: 'Valor selecionado inválido' })
      return
    }
    const token = await getAccessToken()
    const returnBase = (req.headers.origin && String(req.headers.origin)) || FRONTEND_URL
    const base = String(returnBase).replace(/\/$/, '')
    const origin = String((dados_entrada.metadata?.origin || 'fim')).toLowerCase()
    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: dados_entrada.currency,
            value: dados_entrada.value,
          },
          custom_id: `origin=${encodeURIComponent(origin)}`,
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
    type PayPalOrderResponse = {
      id?: string
      status?: string
      purchase_units?: Array<unknown>
      payer?: { email_address?: string }
    }
    const resp = await axios.post<PayPalOrderResponse>(
      `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      null,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        validateStatus: () => true,
      },
    )
    let json = resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Capture failed: ${resp.status} ${JSON.stringify(json)}`)
    }

    const needsDetails = !json?.payer?.email_address || !Array.isArray(json?.purchase_units)
    if (needsDetails) {
      const detailsResp = await axios.get<PayPalOrderResponse>(
        `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          validateStatus: () => true,
        },
      )
      if (detailsResp.status >= 200 && detailsResp.status < 300 && detailsResp.data) {
        const details = detailsResp.data
        json = {
          ...details,
          ...json,
          payer: json?.payer || details?.payer,
          purchase_units: Array.isArray(json?.purchase_units) ? json.purchase_units : details?.purchase_units,
        }
      }
    }
    console.log('[PAYPAL] Operação concluída com sucesso: capture_order', {
      id_resultado: json?.id || orderId,
      status: json?.status,
      timestamp: new Date().toISOString(),
    })
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

router.post('/finalize-email', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'paypal.finalize_email'
  console.log('[PAYPAL] HIT do finalize-email', { body: req.body, headers: req.headers['content-type'] })
  const dados_entrada = { orderID: String(req.body?.orderID || ''), email: String(req.body?.email || '') }
  try {
    console.log(`[PAYPAL] Iniciando operação: ${operacao}`, { dados_entrada })



    const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, API_BASE } = getEnv()
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
      res.status(500).json({ success: false, error: 'PayPal não configurado: defina PAYPAL_CLIENT_ID e PAYPAL_SECRET' })
      return
    }
    const orderId = dados_entrada.orderID
    if (!orderId) {
      res.status(400).json({ success: false, error: 'orderID é obrigatório' })
      return
    }
    const email = String(req.body?.email || '').trim()
    if (!email) {
      res.status(400).json({ success: false, error: 'email é obrigatório' })
      return
    }
    const token = await getAccessToken()
    const resp = await axios.get<{ id?: string; status?: string; purchase_units?: Array<unknown>; payer?: unknown }>(
      `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        validateStatus: () => true,
      },
    )
    let json = resp.data
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Get order failed: ${resp.status} ${JSON.stringify(json)}`)
    }
    let status = String(json?.status || '').toUpperCase()
    if (status !== 'COMPLETED') {
      const captureResp = await axios.post<{ id?: string; status?: string }>(
        `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        null,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          validateStatus: () => true,
        },
      )
      if (captureResp.status >= 200 && captureResp.status < 300 && captureResp.data) {
        status = String(captureResp.data?.status || '').toUpperCase()
      } else if (captureResp.status === 422) {
        try {
          const retryResp = await axios.get<{ status?: string }>(
            `${API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation',
              },
              validateStatus: () => true,
            },
          )
          if (retryResp.status >= 200 && retryResp.status < 300) {
            status = String(retryResp.data?.status || '').toUpperCase()
            if (retryResp.data) json = retryResp.data
          }
        } catch (retryErr: unknown) {
          const e = retryErr as { message?: string }
          console.error('[PAYPAL] Falha ao reconsultar pedido no finalize-email', { message: e?.message })
        }
      }
      if (status !== 'COMPLETED') {
        res.status(409).json({ success: false, error: 'Pedido PayPal não está completo' })
        return
      }
    }
    type PayPalPurchaseUnit = {
      custom_id?: string
      amount?: { currency_code?: string; value?: string }
      payments?: { captures?: Array<{ amount?: { currency_code?: string; value?: string } }> }
      shipping?: { address?: { admin_area_1?: string; admin_area_2?: string; postal_code?: string; country_code?: string } }
    }
    type PayPalPayer = {
      payer_id?: string
      name?: { given_name?: string; surname?: string }
    }
    const pu = (Array.isArray(json?.purchase_units) ? (json.purchase_units[0] as PayPalPurchaseUnit) : null)
    const customId = String(pu?.custom_id || '')
    const originMatch = /^origin=([^&]+)/.exec(customId)
    const origin = decodeURIComponent(originMatch ? originMatch[1] : 'fim')
    const currency = String(
      pu?.payments?.captures?.[0]?.amount?.currency_code || pu?.amount?.currency_code || 'EUR',
    )
    const valueStr = String(
      pu?.payments?.captures?.[0]?.amount?.value || pu?.amount?.value || '0',
    )
    const value = Number(valueStr)
    const base = process.env.FRONTEND_URL || 'http://localhost:3002'
    const fallbackUrl = `${String(base).replace(/\/$/, '')}${String(origin).includes('upsell') ? '/audio-upsell' : '/fim'}`
    const srcUrl = typeof req.body?.event_source_url === 'string' && req.body.event_source_url.trim()
      ? req.body.event_source_url
      : fallbackUrl
    const ua = String(req.headers['user-agent'] || '') || null
    const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || ''
    const ip = (ipHeader.split(',').shift() || '').trim() || null
    const payer = (((json as { payer?: PayPalPayer })?.payer) || {}) as PayPalPayer
    const payerName = payer?.name || {}
    const firstName = payerName?.given_name ? String(payerName.given_name) : null
    const lastName = payerName?.surname ? String(payerName.surname) : null
    const externalId = payer?.payer_id ? String(payer.payer_id) : null
    const phone = typeof req.body?.phone === 'string' && req.body.phone.trim() ? String(req.body.phone) : null
    let capiResp: { success: boolean; error?: string } = { success: false }
    try {
      capiResp = await sendPurchaseToMetaCAPI({
        event_id: `paypal:${json?.id || orderId}`,
        event_time: new Date(),
        event_source_url: srcUrl,
        user_agent: ua,
        ip_address: ip,
        fbp: (typeof req.body?.fbp === 'string') ? req.body.fbp : null,
        fbc: (typeof req.body?.fbc === 'string') ? req.body.fbc : null,
        email,
        phone,
        first_name: firstName,
        last_name: lastName,
        city: (pu?.shipping?.address as { admin_area_2?: string } | undefined)?.admin_area_2 || null,
        state: (pu?.shipping?.address as { admin_area_1?: string } | undefined)?.admin_area_1 || null,
        zip: (pu?.shipping?.address as { postal_code?: string } | undefined)?.postal_code || null,
        country: (pu?.shipping?.address as { country_code?: string } | undefined)?.country_code || null,
        external_id: externalId,
        currency,
        value,
        order_id: String(json?.id || orderId || ''),
      })
    } catch (capiErr: unknown) {
      const e = capiErr as { message?: string }
      console.error('[PAYPAL] Erro ao enviar CAPI no finalize-email', { message: e?.message })
    }
    let n8nDispatched = false
    try {
      n8nDispatched = await sendPurchaseToN8N(email)
    } catch (n8nErr: unknown) {
      const e = n8nErr as { message?: string }
      console.error('[PAYPAL] Erro ao enviar n8n no finalize-email', { message: e?.message })
    }

    console.log('[PAYPAL] Integrações finalizadas (finalize-email)', {
      email,
      capi_success: capiResp.success,
      n8n_success: n8nDispatched,
    })
    res.status(200).json({ success: true })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[PAYPAL] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ success: false, error: error.message || 'Falha ao finalizar email do PayPal' })
  }
})

export default router
