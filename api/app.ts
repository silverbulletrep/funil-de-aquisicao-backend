/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'node:path'
import authRoutes from './routes/auth.js'
import stripeRoutes from './routes/stripe.js'
import paypalRoutes from './routes/paypal.js'
import leadsRoutes from './routes/leads.js'

// for esm mode (reserved)

// load env
dotenv.config()

const app: express.Application = express()

// Stripe webhook precisa de corpo bruto para verificação de assinatura
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)
app.use('/api/stripe', stripeRoutes)
app.use('/api/paypal', paypalRoutes)
app.use('/api/leads', leadsRoutes)

app.use(
  '/static/audio-upsell',
  express.static(path.join(process.cwd(), 'Audio - Upsell'), {
    setHeaders: (res) => {
      try { res.setHeader('Access-Control-Allow-Origin', '*') } catch (e) { void e }
    },
  }),
)

app.post('/api/player/status', (req: Request, res: Response): void => {
  const operacao = 'player.status'
  const dados_entrada = { status: req.body?.status }
  try {
    console.log(`[PLAYER] Iniciando operação: ${operacao}`, { dados_entrada })
    const status = String(req.body?.status || '')
    console.log(`[PLAYER] Operação concluída com sucesso:`, {
      id_resultado: 'player_status',
      status: status === 'on' ? 'on' : 'off',
      timestamp: new Date().toISOString(),
    })
    res.status(200).json({ success: true })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[PLAYER] Erro na operação: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    res.status(500).json({ success: false, error: 'Falha ao registrar status do player' })
  }
})

/**
 * health
 */
app.use(
  '/api/health',
  (req: Request, res: Response, next: NextFunction): void => {
    const operacao = 'api.health_check'
    const dados_entrada = { method: req.method, url: req.originalUrl }
    try {
      console.log(`[HEALTH] Iniciando operação: ${operacao}`, { dados_entrada })
      res.status(200).json({
        success: true,
        message: 'ok',
      })
      console.log(`[HEALTH] Operação concluída`, {
        timestamp: new Date().toISOString(),
      })
    } catch (err: unknown) {
      const error = err as Error & { stack?: string }
      console.error(`[HEALTH] Erro na operação: ${error.message}`, {
        dados_entrada,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      })
      void next(error)
    }
  },
)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  void next
  res.status(500).json({
    success: false,
    error: 'Server internal error',
  })
})

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
