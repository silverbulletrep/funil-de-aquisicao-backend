/**
 * Stripe Checkout Session route
 */
import express, { Router, type Request, type Response } from 'express'
import Stripe from 'stripe'
import dotenv from 'dotenv'
import { buildMetaPurchasePayload, sendMetaPurchaseEvent } from '../lib/metaCapi.js'
import { sendPurchaseToN8N } from '../lib/n8n.js'

// ensure env is loaded before accessing process.env
dotenv.config()

const router = Router()
function sanitizeMetadata(obj: Record<string, string | number | boolean | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)]))
}

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET ||
  process.env.STRIPE_API_KEY ||
  process.env.STRIPE_SK ||
  process.env.STRIPE
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3002'
let stripe: Stripe | null = null
function parseFrontendUrlList(value: string): string[] {
  const raw = String(value || '').trim()
  return raw
    .split(/[,\s]+/g)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
}

function normalizeAllowedAmount(rawAmount: number, allowed: number[]): number {
  if (!Number.isFinite(rawAmount)) return rawAmount
  if (allowed.includes(rawAmount)) return rawAmount
  const scaled = Math.round(rawAmount * 100)
  if (allowed.includes(scaled)) return scaled
  return rawAmount
}
function pickFrontendBase(isLiveKey: boolean): string {
  const list = parseFrontendUrlList(FRONTEND_URL)
  if (!list.length) return String(FRONTEND_URL || 'http://localhost:3002').replace(/\/$/, '')
  if (isLiveKey) {
    const https = list.find((u) => u.toLowerCase().startsWith('https://'))
    return String(https || list[0]).replace(/\/$/, '')
  }
  return String(list[0]).replace(/\/$/, '')
}

async function sendPurchaseToMetaCAPI(payload: Parameters<typeof buildMetaPurchasePayload>[0]) {
  const operacao = 'stripe.meta_capi_purchase'
  const dados_entrada = { event_id: payload.event_id }
  try {
    console.log(`[STRIPE] Iniciando operação: ${operacao}`, { dados_entrada })
    console.log('[STRIPE] Payload CAPI (raw)', {
      event_id: payload.event_id,
      event_time: payload.event_time,
      event_source_url: payload.event_source_url,
      fbp: payload.fbp,
      fbc: payload.fbc,
      hasEmail: !!payload.email,
      hasPhone: !!payload.phone,
      first_name: payload.first_name,
      last_name: payload.last_name,
      city: payload.city,
      state: payload.state,
      zip: payload.zip,
      country: payload.country,
      external_id: payload.external_id,
      currency: payload.currency,
      value: payload.value,
      order_id: payload.order_id,
    })
    const resp = await sendMetaPurchaseEvent(buildMetaPurchasePayload(payload))
    console.log('[STRIPE] CAPI disparado com sucesso', { success: resp.success, status: resp.status })
    return resp
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('[STRIPE] Erro ao enviar CAPI', { message: e?.message })
    return { success: false, error: e?.message || 'Falha ao enviar CAPI' }
  }
}

try {
  const isValidKey = /^(sk_(live|test)_[A-Za-z0-9]+)/.test(STRIPE_SECRET_KEY || '')
  if (!isValidKey) {
    console.error('[STRIPE] Erro de configuração: chave secreta inválida ou ausente', {
      hasKey: !!STRIPE_SECRET_KEY,
      timestamp: new Date().toISOString(),
    })
  } else {
    stripe = new Stripe(STRIPE_SECRET_KEY!)
  }
} catch (error: unknown) {
  const e = error as Error & { stack?: string }
  console.error(`[STRIPE] Falha ao inicializar SDK: ${e.message}`, {
    stack: e.stack,
    timestamp: new Date().toISOString(),
  })
}

router.post('/checkout-session', async (req: Request, res: Response): Promise<void> => {
  const dados_entrada = {
    email: req.body?.email || null,
    amount_cents: req.body?.amount_cents,
    currency: req.body?.currency,
    metadata: req.body?.metadata || {},
  }

  try {
    console.log(`[STRIPE] Iniciando operação: criar_checkout_session`, { dados_entrada })

    if (!stripe) {
      console.error('[STRIPE] Erro na operação: SDK não inicializado. Verifique STRIPE_SECRET_KEY', {
        dados_entrada,
        timestamp: new Date().toISOString(),
      })
      res.status(500).json({ success: false, error: 'Stripe não configurado' })
      return
    }

    const originHeader = req.headers.origin
    const isLiveKey = (STRIPE_SECRET_KEY || '').startsWith('sk_live')
    const originIsHttp = typeof originHeader === 'string' && originHeader.startsWith('http://')
    const preferOrigin = typeof originHeader === 'string' && originHeader.trim().length > 0 && (!isLiveKey || !originIsHttp)
    const redirectBase = preferOrigin ? (originHeader as string) : pickFrontendBase(isLiveKey)
    const normalizedBase = String(redirectBase).replace(/\/$/, '')
    const rawMetadata = (req.body?.metadata || {}) as Record<string, string | number | boolean | null | undefined>
    const sanitizedMetadata: Record<string, string> = sanitizeMetadata(rawMetadata)
    const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || ''
    const ip = (ipHeader.split(',').shift() || '').trim()
    const uaHeader = String(req.headers['user-agent'] || '')
    const metaWithInfra: Record<string, string> = { ...sanitizedMetadata }
    if (ip && !metaWithInfra.ip_address) metaWithInfra.ip_address = ip
    if (uaHeader && !metaWithInfra.user_agent && !metaWithInfra.ua) metaWithInfra.user_agent = uaHeader
    const variantParam = sanitizedMetadata.variant ? `&variant=${encodeURIComponent(sanitizedMetadata.variant)}` : ''
    const successUrl = `${normalizedBase}/checkout-success?session_id={CHECKOUT_SESSION_ID}${variantParam}`
    const cancelUrl = `${normalizedBase}/checkout-cancel`

    console.log('[STRIPE] URLs de redirect configuradas:', {
      successUrl,
      cancelUrl,
      originHeader,
      FRONTEND_URL,
      isLiveKey,
      originIsHttp,
      preferOrigin,
      redirectBase,
    })

    // Sanitiza metadata (já obtida acima)

    // Whitelist de valores permitidos (em centavos)
    const allowedAmountsBRL = [100, 990, 1470, 1980]
    const requestedAmount = Number(req.body?.amount_cents)
    const requestedCurrency = (req.body?.currency || '').toLowerCase()

    // Define moeda: suportar BRL, EUR; fallback para USD
    const currency = requestedCurrency === 'brl' ? 'brl' : (requestedCurrency === 'eur' ? 'eur' : 'usd')

    // Validação de amount conforme moeda
    let unitAmount = 0
    if (currency === 'brl') {
      const normalizedAmount = normalizeAllowedAmount(requestedAmount, allowedAmountsBRL)
      if (!Number.isFinite(normalizedAmount) || !allowedAmountsBRL.includes(normalizedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (BRL)', {
          requestedAmount,
          normalizedAmount,
          allowedAmountsBRL,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido (BRL)' })
        return
      }
      unitAmount = normalizedAmount
    } else if (currency === 'eur') {
      const allowedAmountsEUR = [3700, 2400, 4700]
      const normalizedAmount = normalizeAllowedAmount(requestedAmount, allowedAmountsEUR)
      if (!Number.isFinite(normalizedAmount) || !allowedAmountsEUR.includes(normalizedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (EUR)', {
          requestedAmount,
          normalizedAmount,
          allowedAmountsEUR,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido (EUR)' })
        return
      }
      unitAmount = normalizedAmount
    } else {
      // Fallback USD: mantém valor existente caso não use BRL/EUR
      unitAmount = 5999
    }

    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: [
          'card',
          'link',
          'giropay',
          'sofort',
          'sepa_debit',
          'klarna',
          'eps',
          'bancontact',
          'ideal',
        ],
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: unitAmount,
              product_data: {
                name: 'Plano Inner Peace',
                description: 'Calme sua mente e redescubra a alegria',
              },
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: 'de',
        billing_address_collection: 'auto',
        phone_number_collection: { enabled: true },
        customer_email: dados_entrada.email || undefined,
        payment_intent_data: {
          metadata: {
            source: 'vsl2',
            selected_currency: currency,
            selected_amount_cents: String(unitAmount),
            ...metaWithInfra,
          },
        },
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...metaWithInfra,
        },
      })
    } catch (pmErr: unknown) {
      const e = pmErr as { message?: string; code?: string; type?: string }
      console.warn('[STRIPE] Falha ao criar sessão com métodos estendidos, fallback para card', {
        message: e?.message,
        code: e?.code,
        type: e?.type,
      })
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: unitAmount,
              product_data: {
                name: 'Plano Inner Peace',
                description: 'Calme sua mente e redescubra a alegria',
              },
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: 'de',
        billing_address_collection: 'auto',
        phone_number_collection: { enabled: true },
        customer_email: dados_entrada.email || undefined,
        payment_intent_data: {
          metadata: {
            source: 'vsl2',
            selected_currency: currency,
            selected_amount_cents: String(unitAmount),
            ...metaWithInfra,
          },
        },
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...metaWithInfra,
        },
      })
    }

    console.log(`[STRIPE] Operação concluída com sucesso:`, {
      id_resultado: session.id,
      timestamp: new Date().toISOString(),
    })

    res.status(200).json({
      success: true,
      id: session.id,
      url: session.url,
    })
  } catch (error: unknown) {
    const e = error as Error & { type?: string; code?: string; raw?: unknown; stack?: string }
    console.error(`[STRIPE] Erro na operação: ${e.message}`, {
      dados_entrada,
      type: e.type,
      code: e.code,
      raw: e.raw,
      stack: e.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({
      success: false,
      error: e.message || 'Failed to create checkout session',
      code: e.code,
      type: e.type,
    })
  }
})

router.get('/health', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!stripe) {
      dotenv.config({ override: true })
      const dynamicKey =
        process.env.STRIPE_SECRET_KEY ||
        process.env.STRIPE_SECRET ||
        process.env.STRIPE_API_KEY ||
        process.env.STRIPE_SK ||
        process.env.STRIPE ||
        ''
      if (/^sk_(live|test)_/.test(dynamicKey)) {
        try { stripe = new Stripe(dynamicKey) } catch (e) { void e }
      }
    }
    const key = (
      process.env.STRIPE_SECRET_KEY ||
      process.env.STRIPE_SECRET ||
      process.env.STRIPE_API_KEY ||
      process.env.STRIPE_SK ||
      process.env.STRIPE ||
      STRIPE_SECRET_KEY ||
      ''
    )
    const live = key.startsWith('sk_live')
    const test = key.startsWith('sk_test')
    const ready = !!stripe
    const payload = {
      success: true,
      ready,
      live,
      test,
      configured: /^sk_/.test(key),
      key_prefix: key ? key.slice(0, 7) : null,
      frontend_url: FRONTEND_URL,
      currencies: ['brl', 'eur', 'usd'],
      allowed: { brl: [100, 990, 1470, 1980], eur: [3700, 2400, 4700], usd: [5999] },
      message: ready
        ? 'Stripe pronto'
        : 'Stripe não configurado: defina STRIPE_SECRET_KEY com chave sk_* válida',
    }
    res.status(200).json(payload)
  } catch (error: unknown) {
    const e = error as { message?: string }
    res.status(500).json({ success: false, error: e?.message || 'health failed' })
  }
})

/**
 * Recupera uma sessão do Stripe por ID
 */
router.get('/session/:id', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'stripe.get_checkout_session'
  const sessionId = String(req.params.id || '').trim()

  try {
    console.log(`[STRIPE] Iniciando operação: ${operacao}`, { sessionId })

    if (!stripe) {
      console.error('[STRIPE] Erro na operação: SDK não inicializado. Verifique STRIPE_SECRET_KEY', {
        timestamp: new Date().toISOString(),
      })
      res.status(500).json({ success: false, error: 'Stripe não configurado' })
      return
    }

    if (!sessionId) {
      console.error('[STRIPE] ID de sessão ausente ou inválido', { sessionId })
      res.status(400).json({ success: false, error: 'Parâmetro session_id inválido' })
      return
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'customer'],
    })

    // Opcional: recuperar line_items (útil para auditoria/validação)
    let lineItems: Stripe.ApiList<Stripe.LineItem> | null = null
    try {
      lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 10 })
    } catch (liErr: unknown) {
      const e = liErr as { message?: string }
      console.warn('[STRIPE] Falha ao listar line_items da sessão', { message: e?.message })
    }

    console.log(`[STRIPE] Operação concluída com sucesso: ${operacao}`, {
      id_resultado: session.id,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      timestamp: new Date().toISOString(),
    })

    res.status(200).json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_details: session.customer_details,
        metadata: session.metadata,
        payment_intent: typeof session.payment_intent === 'object' ? session.payment_intent : null,
      },
      line_items: lineItems?.data || [],
    })
  } catch (error: unknown) {
    const e = error as { message?: string; code?: string; type?: string; stack?: string }
    console.error(`[STRIPE] Erro na operação: ${operacao}: ${e.message}`, {
      code: e?.code,
      type: e?.type,
      stack: e?.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({
      success: false,
      error: e?.message || 'Falha ao recuperar sessão do Stripe',
      code: e?.code,
      type: e?.type,
    })
  }
})

export default router
/**
 * Stripe PaymentIntent route (Payment Element)
 */
router.post('/payment-intent', async (req: Request, res: Response): Promise<void> => {
  const dados_entrada = {
    email: req.body?.email || null,
    amount_cents: req.body?.amount_cents,
    currency: (req.body?.currency || '').toLowerCase(),
    metadata: req.body?.metadata || {},
  }

  try {
    console.log(`[STRIPE] Iniciando operação: criar_payment_intent`, { dados_entrada })
    console.log('[STRIPE] Body recebido no payment-intent', {
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      emailBody: req.body?.email,
      amount_cents: req.body?.amount_cents,
      currency: req.body?.currency,
      metadataKeys: req.body?.metadata ? Object.keys(req.body.metadata) : [],
    })

    if (!stripe) {
      console.error('[STRIPE] Erro na operação: SDK não inicializado. Verifique STRIPE_SECRET_KEY', {
        dados_entrada,
        timestamp: new Date().toISOString(),
      })
      res.status(500).json({ success: false, error: 'Stripe não configurado' })
      return
    }

    // Sanitiza metadata
    const rawMetadata = (req.body?.metadata || {}) as Record<string, string | number | boolean | null | undefined>
    const sanitizedMetadata: Record<string, string> = sanitizeMetadata(rawMetadata)
    const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || ''
    const ip = (ipHeader.split(',').shift() || '').trim()
    const uaHeader = String(req.headers['user-agent'] || '')
    const metaWithInfra: Record<string, string> = { ...sanitizedMetadata }
    if (ip && !metaWithInfra.ip_address) metaWithInfra.ip_address = ip
    if (uaHeader && !metaWithInfra.user_agent && !metaWithInfra.ua) metaWithInfra.user_agent = uaHeader

    // Whitelist de valores permitidos (em centavos)
    const allowedAmountsBRL = [100, 990, 1470, 1980]
    const allowedAmountsEUR = [3700, 2400, 4700]
    const requestedAmount = Number(req.body?.amount_cents)
    const requestedCurrency = (req.body?.currency || '').toLowerCase()

    // Define moeda: prioriza BRL/EUR; fallback para USD
    const currency = requestedCurrency === 'brl' ? 'brl' : (requestedCurrency === 'eur' ? 'eur' : 'usd')

    // Validação de amount conforme moeda
    let unitAmount = 0
    if (currency === 'brl') {
      const normalizedAmount = normalizeAllowedAmount(requestedAmount, allowedAmountsBRL)
      if (!Number.isFinite(normalizedAmount) || !allowedAmountsBRL.includes(normalizedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (BRL)', {
          requestedAmount,
          normalizedAmount,
          allowedAmountsBRL,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido' })
        return
      }
      unitAmount = normalizedAmount
    } else if (currency === 'eur') {
      const normalizedAmount = normalizeAllowedAmount(requestedAmount, allowedAmountsEUR)
      if (!Number.isFinite(normalizedAmount) || !allowedAmountsEUR.includes(normalizedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (EUR)', {
          requestedAmount,
          normalizedAmount,
          allowedAmountsEUR,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido (EUR)' })
        return
      }
      unitAmount = normalizedAmount
    } else {
      // Fallback USD: valor padrão
      unitAmount = 5999
    }

    const preferredPaymentMethodTypes: Stripe.PaymentIntentCreateParams['payment_method_types'] = [
      'card',
      'sepa_debit',
      'sofort',
      'giropay',
      'klarna',
    ]

    let intent: Stripe.PaymentIntent
    try {
      console.log('[STRIPE] Criando PaymentIntent', {
        amount: unitAmount,
        currency,
        preferredPaymentMethodTypes,
        receipt_email: dados_entrada.email || null,
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...metaWithInfra,
        },
      })
      intent = await stripe.paymentIntents.create({
        amount: unitAmount,
        currency,
        payment_method_types: preferredPaymentMethodTypes,
        description: 'Plano Inner Peace',
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...metaWithInfra,
        },
        receipt_email: dados_entrada.email || undefined,
      })
    } catch (pmErr: unknown) {
      const e = pmErr as { message?: string; code?: string; type?: string }
      console.warn('[STRIPE] Falha ao criar PaymentIntent com métodos preferidos, fallback para card', {
        message: e?.message,
        code: e?.code,
        type: e?.type,
      })
      intent = await stripe.paymentIntents.create({
        amount: unitAmount,
        currency,
        payment_method_types: ['card'],
        description: 'Plano Inner Peace',
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...metaWithInfra,
        },
        receipt_email: dados_entrada.email || undefined,
      })
    }

    console.log(`[STRIPE] Operação concluída com sucesso:`, {
      id_resultado: intent.id,
      timestamp: new Date().toISOString(),
    })

    res.status(200).json({
      success: true,
      id: intent.id,
      client_secret: intent.client_secret,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      livemode: intent.livemode,
      payment_method_types: intent.payment_method_types,
    })
  } catch (error: unknown) {
    const e = error as Error & { type?: string; code?: string; raw?: unknown; stack?: string }
    console.error(`[STRIPE] Erro na operação: ${e.message}`, {
      dados_entrada,
      type: e.type,
      code: e.code,
      raw: e.raw,
      stack: e.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({
      success: false,
      error: e.message || 'Failed to create payment intent',
      code: e.code,
      type: e.type,
    })
  }
})

router.post('/finalize', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'stripe.finalize'
  console.log('[STRIPE] HIT do finalize', { body: req.body, headers: req.headers['content-type'] })
  const paymentIntentId = String(req.body?.payment_intent_id || req.body?.payment_intent || '').trim()
  const dados_entrada = { payment_intent_id: paymentIntentId }
  try {
    console.log(`[STRIPE] Iniciando operação: ${operacao}`, { dados_entrada })


    console.log('[STRIPE] Body recebido no finalize', {
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      emailBody: req.body?.email,
      phoneBody: req.body?.phone,
      fbp: req.body?.fbp,
      fbc: req.body?.fbc,
      event_source_url: req.body?.event_source_url,
    })
    if (!stripe) {
      console.error('[STRIPE] SDK não inicializado', { dados_entrada })
      res.status(500).json({ success: false, error: 'Stripe não configurado' })
      return
    }
    if (!paymentIntentId) {
      res.status(400).json({ success: false, error: 'payment_intent_id é obrigatório' })
      return
    }
    const pi = (await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['charges.data.billing_details', 'customer'] })) as Stripe.PaymentIntent
    const piWithCharges = pi as Stripe.PaymentIntent & { charges?: Stripe.ApiList<Stripe.Charge> }
    const charge = (piWithCharges.charges?.data && piWithCharges.charges.data.length) ? piWithCharges.charges.data[0] : null
    const customerObj = (pi.customer && typeof pi.customer === 'object' && !('deleted' in pi.customer && pi.customer.deleted))
      ? (pi.customer as Stripe.Customer)
      : null
    const emailFromBody = typeof req.body?.email === 'string' ? req.body.email : null
    const phoneFromBody = typeof req.body?.phone === 'string' ? req.body.phone : null
    console.log('[STRIPE] Extração de email no finalize', {
      receipt_email: pi.receipt_email,
      billing_email: charge?.billing_details?.email,
      customer_email: customerObj?.email,
      emailFromBody,
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : []
    })
    const email = (pi.receipt_email || charge?.billing_details?.email || customerObj?.email || emailFromBody || null) as string | null
    const phone = (charge?.billing_details?.phone || customerObj?.phone || phoneFromBody || null) as string | null
    const name = (charge?.billing_details?.name || pi.shipping?.name || customerObj?.name || '') as string
    const nameParts = String(name || '').trim().split(/\s+/).filter(Boolean)
    const firstName = nameParts.length ? nameParts[0] : null
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null
    const address = (charge?.billing_details?.address || pi.shipping?.address || null) as Stripe.Address | null
    const ipHeader = (req.headers['x-forwarded-for'] as string | undefined) || ''
    const ip = (ipHeader.split(',').shift() || '').trim() || null
    const uaBody = typeof req.body?.user_agent === 'string' ? req.body.user_agent : ''
    const uaHeader = String(req.headers['user-agent'] || '')
    const userAgent = uaBody || uaHeader || null
    const eventSourceUrl = typeof req.body?.event_source_url === 'string' && req.body.event_source_url.trim()
      ? req.body.event_source_url
      : `${String(process.env.FRONTEND_URL || 'http://localhost:3002').replace(/\/$/, '')}/fim`
    const amountCents = (pi.amount_received || pi.amount || 0)
    const value = amountCents ? amountCents / 100 : 0
    const currency = String(pi.currency || '').toUpperCase()
    const capiDispatched = String((pi.metadata && pi.metadata.capi_dispatched) || '').toLowerCase() === 'true'
    const n8nAlready = String((pi.metadata && pi.metadata.n8n_dispatched) || '').toLowerCase() === 'true'
    const metaEventId = typeof pi.metadata?.event_id === 'string' ? String(pi.metadata.event_id) : ''
    const eventId = metaEventId || `stripe:${pi.id}`
    console.log('[STRIPE] Contexto do finalize', {
      eventId,
      metaEventId,
      capiDispatched,
      n8nAlready,
      eventSourceUrl,
      currency,
      value,
      hasEmail: !!email,
      hasPhone: !!phone,
      ip,
      userAgent: userAgent ? true : false,
    })
    let capiResp: { success: boolean; status?: number; error?: string } = { success: false }
    if (!capiDispatched) {
      try {
        console.log('[STRIPE] Enviando CAPI no finalize', {
          event_id: eventId,
          event_source_url: eventSourceUrl,
          fbp: (typeof req.body?.fbp === 'string') ? req.body.fbp : null,
          fbc: (typeof req.body?.fbc === 'string') ? req.body.fbc : null,
          hasEmail: !!email,
          hasPhone: !!phone,
          currency,
          value,
          order_id: pi.id,
        })
        capiResp = await sendPurchaseToMetaCAPI({
          event_id: eventId,
          event_time: pi.created || Math.floor(Date.now() / 1000),
          event_source_url: eventSourceUrl,
          fbp: (typeof req.body?.fbp === 'string') ? req.body.fbp : null,
          fbc: (typeof req.body?.fbc === 'string') ? req.body.fbc : null,
          user_agent: userAgent,
          ip_address: ip,
          email,
          phone,
          first_name: firstName,
          last_name: lastName,
          city: address?.city || null,
          state: address?.state || null,
          zip: address?.postal_code || null,
          country: address?.country || null,
          external_id: typeof pi.customer === 'string' ? pi.customer : (customerObj?.id || null),
          currency,
          value,
          order_id: pi.id,
        })
        console.log('[STRIPE] Retorno CAPI no finalize', { success: capiResp?.success, status: capiResp?.status, error: capiResp?.error })
      } catch (capiErr: unknown) {
        const e = capiErr as { message?: string }
        console.error('[STRIPE] Erro ao enviar CAPI no finalize', { message: e?.message })
      }
    } else {
      console.log('[STRIPE] CAPI já havia sido enviado', { eventId, capiDispatched })
    }
    let n8nDispatched = false
    console.log('[STRIPE] Verificando envio para n8n', { email, n8nAlready, shouldSend: !!(email && !n8nAlready) })
    if (email && !n8nAlready) {
      try {
        console.log('[STRIPE] Enviando email para n8n', { email })
        n8nDispatched = await sendPurchaseToN8N(email)
        console.log('[STRIPE] Resultado do envio para n8n', { n8nDispatched })
      } catch (n8nErr: unknown) {
        const e = n8nErr as { message?: string }
        console.error('[STRIPE] Erro ao enviar n8n no finalize', { message: e?.message })
      }
    } else {
      console.log('[STRIPE] n8n não enviado', { hasEmail: !!email, n8nAlready })
    }
    try {
      const nextMeta: Record<string, string> = { ...pi.metadata }
      if (capiResp?.success || capiDispatched) nextMeta.capi_dispatched = 'true'
      if (n8nDispatched || n8nAlready) nextMeta.n8n_dispatched = 'true'
      await stripe.paymentIntents.update(pi.id, { metadata: nextMeta })
    } catch (metaErr: unknown) {
      const e = metaErr as { message?: string }
      console.warn('[STRIPE] Falha ao atualizar metadata no finalize', { message: e?.message })
    }
    res.status(200).json({ success: true })
  } catch (error: unknown) {
    const e = error as Error & { stack?: string }
    console.error(`[STRIPE] Erro na operação: ${operacao}: ${e.message}`, {
      dados_entrada,
      stack: e.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ success: false, error: e.message || 'Falha no finalize do Stripe' })
  }
})

router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response): Promise<void> => {
  const operacao = 'stripe.webhook'
  const dados_entrada = { signature: req.headers['stripe-signature'] ? true : false }
  try {
    console.log(`[STRIPE] Iniciando operação: ${operacao}`, { dados_entrada })
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || ''
    if (!stripe || !endpointSecret) {
      console.error('[STRIPE] Webhook não configurado', { hasStripe: !!stripe, hasSecret: !!endpointSecret })
      res.status(500).json({ success: false, error: 'Webhook não configurado' })
      return
    }
    let event: Stripe.Event
    try {
      const sig = String(req.headers['stripe-signature'] || '')
      event = stripe.webhooks.constructEvent(req.body as Buffer, sig, endpointSecret)
    } catch (err: unknown) {
      const e = err as { message?: string }
      console.error('[STRIPE] Assinatura inválida no webhook', { message: e?.message })
      res.status(400).json({ success: false, error: 'Assinatura inválida' })
      return
    }
    if (event.type === 'payment_intent.succeeded') {
      const piBase = event.data.object as Stripe.PaymentIntent
      let pi = piBase as Stripe.PaymentIntent
      try {
        pi = (await stripe.paymentIntents.retrieve(piBase.id, { expand: ['charges.data.billing_details', 'customer'] })) as Stripe.PaymentIntent
      } catch {
        pi = piBase as Stripe.PaymentIntent
      }
      const capiDispatched = String((pi.metadata && pi.metadata.capi_dispatched) || '').toLowerCase() === 'true'
      const n8nAlready = String((pi.metadata && pi.metadata.n8n_dispatched) || '').toLowerCase() === 'true'
      const amount = (pi.amount_received || pi.amount || 0) / 100
      const currency = String(pi.currency || '').toUpperCase()
      const origin = String((pi.metadata?.origin || pi.metadata?.source || 'fim')).toLowerCase()
      const base = process.env.FRONTEND_URL || 'http://localhost:3002'
      const srcUrl = `${String(base).replace(/\/$/, '')}${origin.includes('upsell') ? '/audio-upsell' : '/fim'}`
      const fbp = (pi.metadata?.fbp as string | undefined) || undefined
      const fbc = (pi.metadata?.fbc as string | undefined) || undefined
      const uaMeta = (pi.metadata?.ua as string | undefined) || (pi.metadata?.user_agent as string | undefined) || null
      const ipMeta = (pi.metadata?.ip_address as string | undefined) || null
      const piWithCharges = pi as Stripe.PaymentIntent & { charges?: Stripe.ApiList<Stripe.Charge> }
      const charge = (piWithCharges.charges?.data && piWithCharges.charges.data.length) ? piWithCharges.charges.data[0] : null
      const customerObj = (pi.customer && typeof pi.customer === 'object' && !('deleted' in pi.customer && pi.customer.deleted))
        ? (pi.customer as Stripe.Customer)
        : null
      const email = (pi.receipt_email || charge?.billing_details?.email || customerObj?.email || null) as string | null
      const phone = (charge?.billing_details?.phone || customerObj?.phone || null) as string | null
      const name = (charge?.billing_details?.name || pi.shipping?.name || customerObj?.name || '') as string
      const nameParts = String(name || '').trim().split(/\s+/).filter(Boolean)
      const firstName = nameParts.length ? nameParts[0] : null
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null
      const address = (charge?.billing_details?.address || pi.shipping?.address || null) as Stripe.Address | null
      const metaEventId = typeof pi.metadata?.event_id === 'string' ? String(pi.metadata.event_id) : ''
      const eventId = metaEventId || `stripe:${pi.id}`
      let capiResp: { success: boolean; status?: number; error?: string } = { success: false }
      if (!capiDispatched) {
        try {
          capiResp = await sendPurchaseToMetaCAPI({
            event_id: eventId,
            event_time: Math.floor((event.created || Date.now()) / 1),
            event_source_url: srcUrl,
            fbp: fbp || null,
            fbc: fbc || null,
            user_agent: uaMeta,
            ip_address: ipMeta,
            email,
            phone,
            first_name: firstName,
            last_name: lastName,
            city: address?.city || null,
            state: address?.state || null,
            zip: address?.postal_code || null,
            country: address?.country || null,
            external_id: typeof pi.customer === 'string' ? pi.customer : (customerObj?.id || null),
            currency,
            value: amount,
            order_id: pi.id,
          })
        } catch (capiErr: unknown) {
          const e = capiErr as { message?: string }
          console.error('[STRIPE] Erro ao enviar CAPI no webhook', { message: e?.message })
        }
      }
      let n8nDispatched = false
      if (email && !n8nAlready) {
        n8nDispatched = await sendPurchaseToN8N(email)
      }
      if (capiResp.success || n8nDispatched) {
        try {
          const nextMeta: Record<string, string> = { ...pi.metadata }
          if (capiResp.success || capiDispatched) nextMeta.capi_dispatched = 'true'
          if (n8nDispatched || n8nAlready) nextMeta.n8n_dispatched = 'true'
          await stripe.paymentIntents.update(pi.id, { metadata: nextMeta })
        } catch (metaErr: unknown) {
          const e = metaErr as { message?: string }
          console.warn('[STRIPE] Falha ao atualizar metadata no webhook', { message: e?.message })
        }
      }
    }
    res.status(200).json({ success: true })
  } catch (error: unknown) {
    const e = error as Error & { stack?: string }
    console.error(`[STRIPE] Erro na operação: ${operacao}: ${e.message}`, {
      dados_entrada,
      stack: e.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ success: false, error: (e && e.message) || 'Falha no webhook' })
  }
})
