import dotenv from 'dotenv'
import { dispatchDueRecoveries, normalizeLimit } from './recoveryDispatcher.js'

dotenv.config()

export interface RecoverySchedulerConfig {
  enabled: boolean
  intervalMs: number
  limit: number
  funnelId?: string
}

export interface RecoverySchedulerRuntime {
  stop: () => void
  runOnce: () => Promise<void>
  getStatus: () => {
    enabled: boolean
    intervalMs: number
    limit: number
    isRunning: boolean
    ticks: number
  }
}

export interface RecoverySchedulerDeps {
  dispatchDueRecoveries?: typeof dispatchDueRecoveries
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  logger?: Pick<Console, 'log' | 'error' | 'warn'>
}

const DEFAULT_INTERVAL_MS = 60000
const MIN_INTERVAL_MS = 5000

// Retorna configurações do scheduler
export function getRecoverySchedulerConfig(env: NodeJS.ProcessEnv = process.env): RecoverySchedulerConfig {
  // captura env que define se o scheduler está habilitado. Ele estará habilitado se ENV for "true".
  const enabled = String(env.RECOVERY_DISPATCH_ENABLED || '').trim().toLowerCase() === 'true'
  // captura env que define o intervalo de execução do scheduler. O valor padrão é 60000 (1 minuto) e o mínimo é 5000 (5 segundos).
  const rawIntervalMs = Number(env.RECOVERY_DISPATCH_INTERVAL_MS)
  // verifica se o intervalo é menor que o tipo definido, se não for retorna o valor definido no env.
  const intervalMs = Number.isFinite(rawIntervalMs) && rawIntervalMs >= MIN_INTERVAL_MS
    ? Math.trunc(rawIntervalMs)
    : DEFAULT_INTERVAL_MS

  // Retorna um limite de dispatch, garantindo que esteja dentro do limite configurado.
  const limit = normalizeLimit(env.RECOVERY_DISPATCH_LIMIT)

  // Captura o ID do funil, definido no env. Se não estiver definido, retorna undefined.
  const funnelId = typeof env.RECOVERY_FUNNEL_ID === 'string' && env.RECOVERY_FUNNEL_ID.trim()
    ? env.RECOVERY_FUNNEL_ID.trim()
    : undefined

  return {
    enabled,
    intervalMs,
    limit,
    funnelId,
  }
}

export function startRecoveryScheduler(
  deps: RecoverySchedulerDeps = {},
): RecoverySchedulerRuntime {
  const config = getRecoverySchedulerConfig()
  const dispatch = deps.dispatchDueRecoveries || dispatchDueRecoveries
  const setIntervalFn = deps.setIntervalFn || setInterval
  const clearIntervalFn = deps.clearIntervalFn || clearInterval
  const logger = deps.logger || console

  let running = false
  let ticks = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const runOnce = async () => {
    if (running) {
      logger.warn('[RECOVERY_SCHEDULER] Ciclo ignorado porque outro ainda está em execução')
      return
    }

    running = true
    ticks += 1

    try {
      logger.log('[RECOVERY_SCHEDULER] Iniciando ciclo', {
        tick: ticks,
        limit: config.limit,
        interval_ms: config.intervalMs,
        funnel_id: config.funnelId || null,
      })

      const summary = await dispatch({
        dryRun: false,
        limit: config.limit,
        funnelId: config.funnelId,
      })

      logger.log('[RECOVERY_SCHEDULER] Ciclo concluído', {
        tick: ticks,
        candidate_count: summary.candidate_count,
        result_count: summary.results.length,
        skipped_count: summary.skipped.length,
      })
    } catch (error: unknown) {
      const err = error as Error & { stack?: string }
      logger.error('[RECOVERY_SCHEDULER] Falha no ciclo', {
        message: err.message,
        stack: err.stack,
      })
    } finally {
      running = false
    }
  }

  if (!config.enabled) {
    logger.log('[RECOVERY_SCHEDULER] Scheduler desabilitado', {
      enabled: false,
      interval_ms: config.intervalMs,
      limit: config.limit,
    })

    return {
      stop: () => undefined,
      runOnce,
      getStatus: () => ({
        enabled: false,
        intervalMs: config.intervalMs,
        limit: config.limit,
        isRunning: running,
        ticks,
      }),
    }
  }

  logger.log('[RECOVERY_SCHEDULER] Scheduler habilitado', {
    enabled: true,
    interval_ms: config.intervalMs,
    limit: config.limit,
    funnel_id: config.funnelId || null,
  })

  timer = setIntervalFn(() => {
    void runOnce()
  }, config.intervalMs)

  const stop = () => {
    if (timer) {
      clearIntervalFn(timer)
      timer = null
      logger.log('[RECOVERY_SCHEDULER] Scheduler parado')
    }
  }

  return {
    stop,
    runOnce,
    getStatus: () => ({
      enabled: true,
      intervalMs: config.intervalMs,
      limit: config.limit,
      isRunning: running,
      ticks,
    }),
  }
}
