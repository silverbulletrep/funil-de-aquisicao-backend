/**
 * Stripe Checkout Session route
 */
import express, { Router, type Request, type Response } from 'express'
import Stripe from 'stripe'
import dotenv from 'dotenv'
import { buildMetaPurchasePayload, sendMetaPurchaseEvent } from '../lib/metaCapi.js'

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
    const redirectBase = preferOrigin ? originHeader as string : FRONTEND_URL
    const normalizedBase = redirectBase.replace(/\/$/, '')
    const rawMetadata = (req.body?.metadata || {}) as Record<string, string | number | boolean | null | undefined>
    const sanitizedMetadata: Record<string, string> = sanitizeMetadata(rawMetadata)
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
    const allowedAmountsBRL = [100, 990, 1000, 1470, 1980]
    const requestedAmount = Number(req.body?.amount_cents)
    const requestedCurrency = (req.body?.currency || '').toLowerCase()

    // Define moeda: suportar BRL, EUR; fallback para USD
    const currency = requestedCurrency === 'brl' ? 'brl' : (requestedCurrency === 'eur' ? 'eur' : 'usd')

    // Validação de amount conforme moeda
    let unitAmount = 0
    if (currency === 'brl') {
      if (!Number.isFinite(requestedAmount) || !allowedAmountsBRL.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (BRL)', {
          requestedAmount,
          allowedAmountsBRL,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido (BRL)' })
        return
      }
      unitAmount = requestedAmount
    } else if (currency === 'eur') {
      const allowedAmountsEUR = [100, 3700, 2400, 4700]
      if (!Number.isFinite(requestedAmount) || !allowedAmountsEUR.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (EUR)', {
          requestedAmount,
          allowedAmountsEUR,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: `Valor selecionado inválido (EUR) [DEBUG: ${requestedAmount}]` })
        return
      }
      unitAmount = requestedAmount
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
        customer_email: dados_entrada.email || undefined,
        payment_intent_data: {
          metadata: {
            source: 'vsl2',
            selected_currency: currency,
            selected_amount_cents: String(unitAmount),
            ...sanitizedMetadata,
          },
        },
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...sanitizedMetadata,
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
        customer_email: dados_entrada.email || undefined,
        payment_intent_data: {
          metadata: {
            source: 'vsl2',
            selected_currency: currency,
            selected_amount_cents: String(unitAmount),
            ...sanitizedMetadata,
          },
        },
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...sanitizedMetadata,
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
      allowed: { brl: [100, 990, 1000, 1470, 1980], eur: [100, 3700, 2400, 4700], usd: [5999] },
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

    // Whitelist de valores permitidos (em centavos)
    const allowedAmountsBRL = [100, 990, 1000, 1470, 1980]
    const allowedAmountsEUR = [100, 3700, 2400, 4700]
    const requestedAmount = Number(req.body?.amount_cents)
    const requestedCurrency = (req.body?.currency || '').toLowerCase()

    // Define moeda: prioriza BRL/EUR; fallback para USD
    const currency = requestedCurrency === 'brl' ? 'brl' : (requestedCurrency === 'eur' ? 'eur' : 'usd')

    console.log('[DEBUG] Validando PaymentIntent:', {
      requestedAmount,
      requestedCurrency,
      currencyParsed: currency,
      allowedBRL: allowedAmountsBRL,
      isAllowed: currency === 'brl' ? allowedAmountsBRL.includes(requestedAmount) : 'N/A'
    })

    // Validação de amount conforme moeda
    let unitAmount = 0
    if (currency === 'brl') {
      if (!Number.isFinite(requestedAmount) || !allowedAmountsBRL.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (BRL)', {
          requestedAmount,
          allowedAmountsBRL,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido' })
        return
      }
      unitAmount = requestedAmount
    } else if (currency === 'eur') {
      if (!Number.isFinite(requestedAmount) || !allowedAmountsEUR.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (EUR)', {
          requestedAmount,
          allowedAmountsEUR,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: `Valor selecionado inválido (EUR) [DEBUG: ${requestedAmount}]` })
        return
      }
      unitAmount = requestedAmount
    } else {
      // Fallback USD: valor padrão
      unitAmount = 5999
    }

    const preferredPaymentMethodTypes: Stripe.PaymentIntentCreateParams['payment_method_types'] = currency === 'brl'
      ? ['card']
      : [
        'card',
        'sepa_debit',
        'sofort',
        'giropay',
        'klarna',
      ]

    let intent: Stripe.PaymentIntent
    try {
      intent = await stripe.paymentIntents.create({
        amount: unitAmount,
        currency,
        payment_method_types: preferredPaymentMethodTypes,
        description: 'Plano Inner Peace',
        metadata: {
          source: 'vsl2',
          selected_currency: currency,
          selected_amount_cents: String(unitAmount),
          ...sanitizedMetadata,
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
          ...sanitizedMetadata,
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
      const pi = event.data.object as Stripe.PaymentIntent
      const amount = (pi.amount_received || pi.amount || 0) / 100
      const currency = String(pi.currency || '').toUpperCase()
      const origin = String((pi.metadata?.origin || pi.metadata?.source || 'fim')).toLowerCase()
      const base = process.env.FRONTEND_URL || 'http://localhost:3002'
      const srcUrl = `${String(base).replace(/\/$/, '')}${origin.includes('upsell') ? '/audio-upsell' : '/fim'}`
      const fbp = (pi.metadata?.fbp as string | undefined) || undefined
      const fbc = (pi.metadata?.fbc as string | undefined) || undefined
      const uaMeta = (pi.metadata?.ua as string | undefined) || (pi.metadata?.user_agent as string | undefined) || null
      const payload = buildMetaPurchasePayload({
        event_id: `stripe:${pi.id}`,
        event_time: Math.floor((event.created || Date.now()) / 1),
        event_source_url: srcUrl,
        fbp: fbp || null,
        fbc: fbc || null,
        user_agent: uaMeta,
        ip_address: null,
        currency,
        value: amount,
      })
      const resp = await sendMetaPurchaseEvent(payload)
      console.log('[STRIPE] CAPI disparado via webhook', { success: resp.success, status: resp.status })
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
