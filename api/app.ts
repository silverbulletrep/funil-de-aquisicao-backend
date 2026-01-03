import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import stripeRoutes from './routes/stripe.js'
import paypalRoutes from './routes/paypal.js'
import leadsRoutes from './routes/leads.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config()

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

const AUDIO_UPSELL_DIR = path.resolve(__dirname, '..', 'Audio - Upsell')
app.use('/static/audio-upsell', (req: Request, res: Response, next: NextFunction): void => {
  try {
    console.log(`[STATIC] Iniciando operação: serve_audio_upsell`, {
      method: req.method,
      url: req.originalUrl,
      dir: AUDIO_UPSELL_DIR
    })
  } catch {}
  next()
})
app.get('/static/audio-upsell/:file', (req: Request, res: Response): void => {
  const file = String(req.params.file || '')
  const full = path.resolve(AUDIO_UPSELL_DIR, file)
  res.setHeader('Content-Type', 'audio/mpeg')
  res.setHeader('Accept-Ranges', 'bytes')
  res.sendFile(full, (err) => {
    if (err) {
      console.error('[STATIC] Erro ao servir audio:', { file, full, message: (err as any)?.message })
      try {
        const status = (err as any)?.statusCode || (err as any)?.status || 500
        res.status(status).json({ success: false })
      } catch {}
    } else {
      console.log('[STATIC] Audio servido com sucesso:', { file })
    }
  })
})
app.use('/static/audio-upsell', express.static(AUDIO_UPSELL_DIR))

app.use('/api/auth', authRoutes)
app.use('/api/stripe', stripeRoutes)
app.use('/api/paypal', paypalRoutes)
app.use('/api/leads', leadsRoutes)

app.post('/api/player/status', (req: Request, res: Response): void => {
  const operacao = 'player.status'
  const dados_entrada = { status: (req as any).body?.status }
  try {
    console.log(`[PLAYER] Iniciando operação: ${operacao}`, { dados_entrada })
    const status = String((req as any).body?.status || '')
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

app.use('/api/health', (req: Request, res: Response, next: NextFunction): void => {
  const operacao = 'api.health_check'
  const dados_entrada = { method: req.method, url: req.originalUrl }
  try {
    console.log(`[HEALTH] Iniciando operação: ${operacao}`, { dados_entrada })
    res.status(200).json({ success: true, message: 'ok' })
    console.log(`[HEALTH] Operação concluída`, { timestamp: new Date().toISOString() })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[HEALTH] Erro na operação: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    next(error)
  }
})

app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, error: 'Server internal error' })
})

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'API not found' })
})

export default app
