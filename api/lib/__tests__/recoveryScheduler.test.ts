import test from 'node:test'
import assert from 'node:assert/strict'
import { getRecoverySchedulerConfig, startRecoveryScheduler } from '../recoveryScheduler.js'

test('getRecoverySchedulerConfig keeps scheduler disabled unless env is exactly true', () => {
  const disabled = getRecoverySchedulerConfig({
    RECOVERY_DISPATCH_ENABLED: 'false',
    RECOVERY_DISPATCH_INTERVAL_MS: '120000',
    RECOVERY_DISPATCH_LIMIT: '7',
  } as NodeJS.ProcessEnv)

  assert.equal(disabled.enabled, false)
  assert.equal(disabled.intervalMs, 120000)
  assert.equal(disabled.limit, 7)

  const enabled = getRecoverySchedulerConfig({
    RECOVERY_DISPATCH_ENABLED: 'true',
    RECOVERY_DISPATCH_INTERVAL_MS: '3000',
    RECOVERY_DISPATCH_LIMIT: '999',
  } as NodeJS.ProcessEnv)

  assert.equal(enabled.enabled, true)
  assert.equal(enabled.intervalMs, 60000)
  assert.equal(enabled.limit, 100)
})

test('disabled scheduler does not allocate interval', () => {
  const originalEnabled = process.env.RECOVERY_DISPATCH_ENABLED
  process.env.RECOVERY_DISPATCH_ENABLED = 'false'

  let intervalAllocated = false
  const scheduler = startRecoveryScheduler({
    setIntervalFn: ((...args: Parameters<typeof setInterval>) => {
      intervalAllocated = true
      return setInterval(...args)
    }) as unknown as typeof setInterval,
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  assert.equal(intervalAllocated, false)
  assert.equal(scheduler.getStatus().enabled, false)

  scheduler.stop()

  if (typeof originalEnabled === 'string') process.env.RECOVERY_DISPATCH_ENABLED = originalEnabled
  else delete process.env.RECOVERY_DISPATCH_ENABLED
})

test('enabled scheduler allocates interval and uses in-memory lock', async () => {
  const previousEnabled = process.env.RECOVERY_DISPATCH_ENABLED
  const previousInterval = process.env.RECOVERY_DISPATCH_INTERVAL_MS
  const previousLimit = process.env.RECOVERY_DISPATCH_LIMIT

  process.env.RECOVERY_DISPATCH_ENABLED = 'true'
  process.env.RECOVERY_DISPATCH_INTERVAL_MS = '6000'
  process.env.RECOVERY_DISPATCH_LIMIT = '3'

  let intervalMsSeen = 0
  let dispatchCallCount = 0
  let releaseDispatch: (() => void) | null = null

  const dispatchPromise = new Promise<void>((resolve) => {
    releaseDispatch = resolve
  })

  const scheduler = startRecoveryScheduler({
    dispatchDueRecoveries: (async () => {
      dispatchCallCount += 1
      await dispatchPromise
      return {
        dry_run: false,
        candidate_count: 0,
        candidates: [],
        skipped: [],
        results: [],
      }
    }) as never,
    setIntervalFn: ((...args: Parameters<typeof setInterval>) => {
      const [, ms] = args
      intervalMsSeen = Number(ms || 0)
      return setInterval(...args)
    }) as unknown as typeof setInterval,
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  })

  assert.equal(scheduler.getStatus().enabled, true)
  assert.equal(intervalMsSeen, 6000)

  const firstRun = scheduler.runOnce()
  const secondRun = scheduler.runOnce()

  await Promise.resolve()
  assert.equal(dispatchCallCount, 1)

  releaseDispatch?.()
  await firstRun
  await secondRun

  scheduler.stop()

  if (typeof previousEnabled === 'string') process.env.RECOVERY_DISPATCH_ENABLED = previousEnabled
  else delete process.env.RECOVERY_DISPATCH_ENABLED

  if (typeof previousInterval === 'string') process.env.RECOVERY_DISPATCH_INTERVAL_MS = previousInterval
  else delete process.env.RECOVERY_DISPATCH_INTERVAL_MS

  if (typeof previousLimit === 'string') process.env.RECOVERY_DISPATCH_LIMIT = previousLimit
  else delete process.env.RECOVERY_DISPATCH_LIMIT
})
