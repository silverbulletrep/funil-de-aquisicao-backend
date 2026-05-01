import { Router, type Request, type Response } from 'express'
import dotenv from 'dotenv'
import { dispatchDueRecoveries, normalizeLimit } from '../lib/recoveryDispatcher.js'

dotenv.config()

const router = Router()

function parseDryRun(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes'
  }
  return false
}

router.post('/dispatch-due', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'recovery.dispatch_due'
  const configuredSecret = process.env.RECOVERY_DISPATCH_SECRET || ''
  const providedSecret = String(req.header('x-recovery-dispatch-secret') || '')
  const dryRun = parseDryRun(req.body?.dry_run)
  const limit = normalizeLimit(req.body?.limit)
  const leadId = typeof req.body?.lead_id === 'string' ? req.body.lead_id.trim() : ''

  try {
    console.log('[RECOVERY] Iniciando operação', {
      operacao,
      dry_run: dryRun,
      limit,
      lead_id: leadId || null,
    })

    if (!configuredSecret) {
      res.status(503).json({
        success: false,
        error: 'RECOVERY_DISPATCH_SECRET não configurado no backend',
      })
      return
    }

    if (!providedSecret) {
      res.status(401).json({
        success: false,
        error: 'x-recovery-dispatch-secret é obrigatório',
      })
      return
    }

    if (providedSecret !== configuredSecret) {
      res.status(403).json({
        success: false,
        error: 'Segredo operacional inválido',
      })
      return
    }

    const summary = await dispatchDueRecoveries({
      dryRun,
      limit,
      leadId: leadId || undefined,
    })

    console.log('[RECOVERY] Operação concluída com sucesso', {
      dry_run: summary.dry_run,
      candidate_count: summary.candidate_count,
      result_count: summary.results.length,
      skipped_count: summary.skipped.length,
    })

    res.status(200).json({
      success: true,
      ...summary,
    })
  } catch (error: unknown) {
    const err = error as Error & { stack?: string }
    console.error('[RECOVERY] Erro na operação', {
      operacao,
      message: err.message,
      stack: err.stack,
    })

    res.status(500).json({
      success: false,
      error: err.message || 'Falha ao executar dispatcher de recovery',
    })
  }
})

export default router
