import { Router, type Request, type Response } from 'express'
import Stripe from 'stripe'
import dotenv from 'dotenv'

dotenv.config()

const router = Router()

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
} catch (error: any) {
  console.error(`[STRIPE] Falha ao inicializar SDK: ${error.message}`, {
    stack: error.stack,
    timestamp: new Date().toISOString(),
  })
}

router.post('/checkout-session', async (req: Request, res: Response): Promise<void> => {
  const dados_entrada = {
    email: (req as any)?.body?.email || null,
    amount_cents: (req as any)?.body?.amount_cents,
    currency: (req as any)?.body?.currency,
    metadata: (req as any)?.body?.metadata || {},
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

    const originHeader = (req as any).headers?.origin
    const isLiveKey = (STRIPE_SECRET_KEY || '').startsWith('sk_live')
    const originIsHttp = typeof originHeader === 'string' && originHeader.startsWith('http://')
    const preferOrigin = typeof originHeader === 'string' && originHeader.trim().length > 0 && (!isLiveKey || !originIsHttp)
    const redirectBase = preferOrigin ? (originHeader as string) : FRONTEND_URL
    const normalizedBase = redirectBase.replace(/\/$/, '')
    const successUrl = `${normalizedBase}/checkout-success?session_id={CHECKOUT_SESSION_ID}`
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

    const rawMetadata = ((req as any)?.body?.metadata || {}) as Record<string, any>
    const sanitizedMetadata: Record<string, string> = Object.fromEntries(
      Object.entries(rawMetadata).map(([k, v]) => [k, String(v)])
    )

    const allowedAmountsBRL = [100, 990, 1470, 1980]
    const requestedAmount = Number((req as any)?.body?.amount_cents)
    const requestedCurrency = String((req as any)?.body?.currency || '').toLowerCase()
    const currency = requestedCurrency === 'brl' ? 'brl' : (requestedCurrency === 'eur' ? 'eur' : 'usd')

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
      const allowedAmountsEUR = [3700, 2400, 4700]
      if (!Number.isFinite(requestedAmount) || !allowedAmountsEUR.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (EUR)', {
          requestedAmount,
          allowedAmountsEUR,
          timestamp: new Date().toISOString(),
        })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido (EUR)' })
        return
      }
      unitAmount = requestedAmount
    } else {
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
              product_data: { name: 'Plano Inner Peace', description: 'Calme sua mente e redescubra a alegria' },
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: 'de',
        billing_address_collection: 'auto',
        customer_email: dados_entrada.email || undefined,
        metadata: { source: 'vsl2', selected_currency: currency, selected_amount_cents: String(unitAmount), ...sanitizedMetadata },
      })
    } catch (pmErr: any) {
      console.warn('[STRIPE] Falha ao criar sessão com métodos estendidos, fallback para card', { message: pmErr?.message, code: pmErr?.code, type: pmErr?.type })
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: unitAmount,
              product_data: { name: 'Plano Inner Peace', description: 'Calme sua mente e redescubra a alegria' },
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: 'de',
        billing_address_collection: 'auto',
        customer_email: dados_entrada.email || undefined,
        metadata: { source: 'vsl2', selected_currency: currency, selected_amount_cents: String(unitAmount), ...sanitizedMetadata },
      })
    }

    console.log(`[STRIPE] Operação concluída com sucesso:`, { id_resultado: session.id, timestamp: new Date().toISOString() })

    res.status(200).json({ success: true, id: session.id, url: session.url })
  } catch (error: any) {
    console.error(`[STRIPE] Erro na operação: ${error.message}`, { dados_entrada, type: error.type, code: error.code, raw: error.raw, stack: error.stack, timestamp: new Date().toISOString() })
    res.status(500).json({ success: false, error: error?.message || 'Failed to create checkout session', code: error?.code, type: error?.type })
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
      if (/^sk_(live|test)_/.test(dynamicKey)) { try { stripe = new Stripe(dynamicKey) } catch {} }
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
      allowed: { brl: [990, 1470, 1980], eur: [3700, 2400, 4700], usd: [5999] },
      message: ready ? 'Stripe pronto' : 'Stripe não configurado: defina STRIPE_SECRET_KEY com chave sk_* válida',
    }
    res.status(200).json(payload)
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'health failed' })
  }
})

router.get('/session/:id', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'stripe.get_checkout_session'
  const sessionId = String((req as any).params?.id || '').trim()
  try {
    console.log(`[STRIPE] Iniciando operação: ${operacao}`, { sessionId })
    if (!stripe) {
      console.error('[STRIPE] Erro na operação: SDK não inicializado. Verifique STRIPE_SECRET_KEY', { timestamp: new Date().toISOString() })
      res.status(500).json({ success: false, error: 'Stripe não configurado' })
      return
    }
    if (!sessionId) {
      console.error('[STRIPE] ID de sessão ausente ou inválido', { sessionId })
      res.status(400).json({ success: false, error: 'Parâmetro session_id inválido' })
      return
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent', 'customer'] as any })
    let lineItems: Stripe.ApiList<Stripe.LineItem> | null = null
    try { lineItems = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 10 }) } catch (liErr: any) { console.warn('[STRIPE] Falha ao listar line_items da sessão', { message: liErr?.message }) }
    console.log(`[STRIPE] Operação concluída com sucesso: ${operacao}`, { id_resultado: session.id, payment_status: session.payment_status, amount_total: session.amount_total, currency: session.currency, timestamp: new Date().toISOString() })
    res.status(200).json({ success: true, session: { id: session.id, status: session.status, payment_status: session.payment_status, amount_total: session.amount_total, currency: session.currency, customer_details: session.customer_details, metadata: session.metadata, payment_intent: typeof session.payment_intent === 'object' ? session.payment_intent : null }, line_items: (lineItems as any)?.data || [] })
  } catch (error: any) {
    console.error(`[STRIPE] Erro na operação: ${operacao}: ${error.message}`, { code: error?.code, type: error?.type, stack: error?.stack, timestamp: new Date().toISOString() })
    res.status(500).json({ success: false, error: error?.message || 'Falha ao recuperar sessão do Stripe', code: error?.code, type: error?.type })
  }
})

export default router

router.post('/payment-intent', async (req: Request, res: Response): Promise<void> => {
  const dados_entrada = {
    email: (req as any)?.body?.email || null,
    amount_cents: (req as any)?.body?.amount_cents,
    currency: String((req as any)?.body?.currency || '').toLowerCase(),
    metadata: (req as any)?.body?.metadata || {},
  }
  try {
    console.log(`[STRIPE] Iniciando operação: criar_payment_intent`, { dados_entrada })
    if (!stripe) {
      console.error('[STRIPE] Erro na operação: SDK não inicializado. Verifique STRIPE_SECRET_KEY', { dados_entrada, timestamp: new Date().toISOString() })
      res.status(500).json({ success: false, error: 'Stripe não configurado' })
      return
    }
    const rawMetadata = ((req as any)?.body?.metadata || {}) as Record<string, any>
    const sanitizedMetadata: Record<string, string> = Object.fromEntries(Object.entries(rawMetadata).map(([k, v]) => [k, String(v)]))
    const allowedAmountsBRL = [990, 1470, 1980]
    const allowedAmountsEUR = [3700, 2400, 4700]
    const requestedAmount = Number((req as any)?.body?.amount_cents)
    const requestedCurrency = String((req as any)?.body?.currency || '').toLowerCase()
    const currency = requestedCurrency === 'brl' ? 'brl' : (requestedCurrency === 'eur' ? 'eur' : 'usd')
    let unitAmount = 0
    if (currency === 'brl') {
      if (!Number.isFinite(requestedAmount) || !allowedAmountsBRL.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (BRL)', { requestedAmount, allowedAmountsBRL, timestamp: new Date().toISOString() })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido' })
        return
      }
      unitAmount = requestedAmount
    } else if (currency === 'eur') {
      if (!Number.isFinite(requestedAmount) || !allowedAmountsEUR.includes(requestedAmount)) {
        console.error('[STRIPE] Amount inválido ou não permitido (EUR)', { requestedAmount, allowedAmountsEUR, timestamp: new Date().toISOString() })
        res.status(400).json({ success: false, error: 'Valor selecionado inválido (EUR)' })
        return
      }
      unitAmount = requestedAmount
    } else {
      unitAmount = 5999
    }
    const intent = await (stripe as Stripe).paymentIntents.create({ amount: unitAmount, currency, automatic_payment_methods: { enabled: true }, description: 'Plano Inner Peace', metadata: { source: 'vsl2', selected_currency: currency, selected_amount_cents: String(unitAmount), ...sanitizedMetadata }, receipt_email: dados_entrada.email || undefined })
    console.log(`[STRIPE] Operação concluída com sucesso:`, { id_resultado: intent.id, timestamp: new Date().toISOString() })
    res.status(200).json({ success: true, id: intent.id, client_secret: intent.client_secret, amount: intent.amount, currency: intent.currency, status: intent.status })
  } catch (error: any) {
    console.error(`[STRIPE] Erro na operação: ${error.message}`, { dados_entrada, type: error.type, code: error.code, raw: error.raw, stack: error.stack, timestamp: new Date().toISOString() })
    res.status(500).json({ success: false, error: error?.message || 'Failed to create payment intent', code: error?.code, type: error?.type })
  }
})
