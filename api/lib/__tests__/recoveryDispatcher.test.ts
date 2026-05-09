import test from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildRecoveryCandidate,
  buildRecoveryCandidates,
  dispatchDueRecoveries,
  fetchRecoveryTemplateLookup,
  normalizeLimit,
  normalizeMaxEligibleAgeMs,
} from '../recoveryDispatcher.js'
import type { RecoveryLeadContext, RecoveryN8NPayload } from '../recoveryTypes.js'

function makeContext(overrides?: Partial<RecoveryLeadContext>): RecoveryLeadContext {
  return {
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_test',
      name: 'Lead Test',
      email: 'lead@test.com',
      phone: '351912345678',
      country: 'PT',
      has_purchase: false,
      last_event_at: '2026-04-30T11:30:00.000Z',
    },
    funnelLead: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_test',
      attributes: {},
      metadata: {},
    },
    events: [],
    ...overrides,
  }
}

type TableRow = Record<string, unknown>

function createSupabaseMock(seed?: {
  compactRows?: TableRow[]
  funnelLeadRows?: TableRow[]
  eventRows?: TableRow[]
  routeRows?: TableRow[]
  bindingRows?: TableRow[]
  templateRows?: TableRow[]
  defaultSelectLimits?: Record<string, number>
}) {
  const tables: Record<string, TableRow[]> = {
    vw_funnel_lead_compact: seed?.compactRows ? [...seed.compactRows] : [],
    funnel_leads: seed?.funnelLeadRows ? [...seed.funnelLeadRows] : [],
    funnel_events: seed?.eventRows ? [...seed.eventRows] : [],
    recovery_template_routes: seed?.routeRows ? [...seed.routeRows] : [],
    recovery_template_bindings: seed?.bindingRows ? [...seed.bindingRows] : [],
    message_templates: seed?.templateRows ? [...seed.templateRows] : [],
    whatsapp_recovery_dispatches: [],
  }

  const updates: Array<{ table: string; patch: Record<string, unknown>; count: number }> = []

  const applyFilters = (
    rows: TableRow[],
    predicates: Array<(row: TableRow) => boolean>,
  ) => predicates.reduce((acc, predicate) => acc.filter(predicate), rows)

  const compareValues = (left: unknown, right: unknown): number => {
    if (typeof left === 'number' && typeof right === 'number') return left - right

    const leftDate = Date.parse(String(left ?? ''))
    const rightDate = Date.parse(String(right ?? ''))
    if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) return leftDate - rightDate

    return String(left ?? '').localeCompare(String(right ?? ''))
  }

  const supabase = {
    updates,
    tables,
    from(table: string) {
      const state: {
        op: 'select' | 'insert' | 'update' | 'delete'
        predicates: Array<(row: TableRow) => boolean>
        orderBy: { column: string; ascending: boolean } | null
        limit: number | null
        payload: Record<string, unknown> | Array<Record<string, unknown>> | null
        single: 'single' | 'maybeSingle' | null
      } = {
        op: 'select',
        predicates: [],
        orderBy: null,
        limit: null,
        payload: null,
        single: null,
      }

      const builder = {
        select() {
          return builder
        },
        eq(column: string, value: unknown) {
          state.predicates.push((row) => row[column] === value)
          return builder
        },
        in(column: string, values: unknown[]) {
          state.predicates.push((row) => values.includes(row[column]))
          return builder
        },
        gte(column: string, value: unknown) {
          state.predicates.push((row) => compareValues(row[column], value) >= 0)
          return builder
        },
        lt(column: string, value: unknown) {
          state.predicates.push((row) => compareValues(row[column], value) < 0)
          return builder
        },
        order(column: string, options?: { ascending?: boolean }) {
          state.orderBy = {
            column,
            ascending: options?.ascending !== false,
          }
          return builder
        },
        limit(value: number) {
          state.limit = value
          return builder
        },
        maybeSingle() {
          state.single = 'maybeSingle'
          return builder
        },
        single() {
          state.single = 'single'
          return builder
        },
        insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
          state.op = 'insert'
          state.payload = payload
          return builder
        },
        update(patch: Record<string, unknown>) {
          state.op = 'update'
          state.payload = patch
          return builder
        },
        delete() {
          state.op = 'delete'
          return builder
        },
        then(resolve: (value: unknown) => void, reject?: (reason?: unknown) => void) {
          Promise.resolve(execute()).then(resolve, reject)
        },
      }

      const execute = () => {
        if (state.op === 'insert') {
          const rows = Array.isArray(state.payload) ? state.payload : [state.payload ?? {}]
          const insertedRows = rows.map((row, index) => ({
            id: `dispatch-${tables.whatsapp_recovery_dispatches.length + index + 1}`,
            ...row,
          }))
          tables[table].push(...insertedRows)
          return {
            data: state.single ? insertedRows[0] ?? null : insertedRows,
            error: null,
          }
        }

        if (state.op === 'update') {
          const rows = applyFilters(tables[table], state.predicates)
          rows.forEach((row) => Object.assign(row, state.payload ?? {}))
          updates.push({
            table,
            patch: (state.payload ?? {}) as Record<string, unknown>,
            count: rows.length,
          })
          return { data: null, error: null }
        }

        if (state.op === 'delete') {
          const rows = applyFilters(tables[table], state.predicates)
          tables[table] = tables[table].filter((row) => !rows.includes(row))
          return { data: null, error: null }
        }

        let rows = applyFilters(tables[table], state.predicates)
        if (state.orderBy) {
          rows = [...rows].sort((left, right) => {
            const compare = compareValues(left[state.orderBy?.column], right[state.orderBy?.column])
            return state.orderBy?.ascending ? compare : -compare
          })
        }

        const defaultSelectLimit = seed?.defaultSelectLimits?.[table]
        if (typeof state.limit === 'number') {
          rows = rows.slice(0, state.limit)
        } else if (typeof defaultSelectLimit === 'number') {
          rows = rows.slice(0, defaultSelectLimit)
        }

        if (state.single === 'single' || state.single === 'maybeSingle') {
          return { data: rows[0] ?? null, error: null }
        }

        return { data: rows, error: null }
      }

      return builder
    },
  }

  return supabase as typeof supabase & { updates: Array<{ table: string; patch: Record<string, unknown>; count: number }> }
}

test('normalizeLimit keeps values within safe max', () => {
  assert.equal(normalizeLimit(undefined), 20)
  assert.equal(normalizeLimit('7'), 7)
  assert.equal(normalizeLimit(999), 100)
})

test('normalizeMaxEligibleAgeMs disables stale filter for invalid values', () => {
  assert.equal(normalizeMaxEligibleAgeMs(undefined), null)
  assert.equal(normalizeMaxEligibleAgeMs('0'), null)
  assert.equal(normalizeMaxEligibleAgeMs('-1'), null)
  assert.equal(normalizeMaxEligibleAgeMs('600000'), 600000)
})

test('multibanco_reminder has priority over checkout_no_purchase', () => {
  const context = makeContext({
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_test',
        event_id: 'evt-1',
        event_type: 'PURCHASE_BILLET_PRINTED',
        event_timestamp: '2026-04-30T11:00:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: { payment_type: 'CASHPAYMENT' },
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_test',
        event_id: 'evt-2',
        event_type: 'checkout_start',
        event_timestamp: '2026-04-30T11:05:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
      },
    ],
  })

  const evaluation = buildRecoveryCandidate(context, new Date('2026-04-30T11:20:00.000Z'))
  assert.ok(evaluation.candidate)
  assert.equal(evaluation.candidate?.message_type, 'multibanco_reminder')
})

test('no_checkout uses offer_revealed after 10 minutes', () => {
  const context = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_no_checkout',
      country: null,
      phone: null,
      email: null,
      name: null,
      has_purchase: false,
      last_event_at: '2026-04-30T11:20:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_no_checkout',
        event_id: 'evt-3',
        event_type: 'lead_identified',
        event_timestamp: '2026-04-30T11:00:00.000Z',
        step_id: '/resultado',
        page_path: null,
        attributes: {
          phone: '351934567890',
          email: 'no-checkout@test.com',
          name: 'No Checkout',
        },
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_no_checkout',
        event_id: 'evt-offer',
        event_type: 'offer_revealed',
        event_timestamp: '2026-04-30T11:05:00.000Z',
        step_id: '/fim-pos-pitch',
        page_path: '/pt/fim',
        attributes: {
          source: 'gatingComplete',
          gate: 'fim_below_fold',
        },
      },
    ],
  })

  const evaluation = buildRecoveryCandidate(context, new Date('2026-04-30T11:30:01.000Z'))
  assert.ok(evaluation.candidate)
  assert.equal(evaluation.candidate?.message_type, 'no_checkout')
  assert.equal(evaluation.candidate?.reason, 'no_checkout_due_after_25m_from_offer_revealed')
  assert.equal(evaluation.candidate?.trigger.event_type, 'offer_revealed')
  assert.equal(evaluation.candidate?.eligible_at, '2026-04-30T11:15:00.000Z')
  assert.equal(evaluation.candidate?.language, 'pt')
})

test('no_checkout skips leads that have not reached post-pitch offer', () => {
  const context = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_pre_pitch',
      country: 'PT',
      phone: null,
      email: null,
      name: null,
      has_purchase: false,
      last_event_at: '2026-04-30T11:20:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_pre_pitch',
        event_id: 'evt-pre-pitch',
        event_type: 'lead_identified',
        event_timestamp: '2026-04-30T11:00:00.000Z',
        step_id: '/resultado',
        page_path: null,
        attributes: {
          phone: '351934567890',
          email: 'pre-pitch@test.com',
          name: 'Pre Pitch',
        },
      },
    ],
  })

  const evaluation = buildRecoveryCandidate(context, new Date('2026-04-30T11:30:01.000Z'))
  assert.equal(evaluation.candidate, undefined)
  assert.equal(evaluation.skipped?.reason, 'not_due')
})

test('purchase blocks recovery candidate', () => {
  const context = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_purchase',
      has_purchase: true,
      country: 'PT',
      last_event_at: '2026-04-30T11:20:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_purchase',
        event_id: 'evt-4',
        event_type: 'purchase',
        event_timestamp: '2026-04-30T11:10:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
      },
    ],
  })

  const evaluation = buildRecoveryCandidate(context, new Date('2026-04-30T11:40:00.000Z'))
  assert.equal(evaluation.candidate, undefined)
  assert.equal(evaluation.skipped?.reason, 'has_purchase')
})

test('buildRecoveryCandidates filters invalid phone leads into skipped', () => {
  const validContext = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_valid',
      country: 'PT',
      phone: '351912345678',
      has_purchase: false,
      last_event_at: '2026-04-30T11:20:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_valid',
        event_id: 'evt-5',
        event_type: 'checkout_start',
        event_timestamp: '2026-04-30T11:00:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
      },
    ],
  })

  const invalidPhoneContext = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_invalid_phone',
      country: 'PT',
      phone: '123',
      has_purchase: false,
      last_event_at: '2026-04-30T11:20:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_invalid_phone',
        event_id: 'evt-6',
        event_type: 'checkout_start',
        event_timestamp: '2026-04-30T11:00:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
      },
    ],
  })

  const summary = buildRecoveryCandidates(
    [validContext, invalidPhoneContext],
    new Date('2026-04-30T11:20:00.000Z'),
  )

  assert.equal(summary.candidates.length, 1)
  assert.equal(summary.skipped.length, 1)
  assert.equal(summary.skipped[0]?.reason, 'missing_valid_phone')
})

test('buildRecoveryCandidates skips leads with expired eligible window', () => {
  const staleContext = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_stale',
      country: 'PT',
      phone: '351912345678',
      has_purchase: false,
      last_event_at: '2026-04-30T11:20:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_stale',
        event_id: 'evt-7',
        event_type: 'checkout_start',
        event_timestamp: '2026-04-30T11:00:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
      },
    ],
  })

  const freshContext = makeContext({
    compact: {
      funnel_id: 'quiz_frequencia_01',
      lead_id: 'lead_fresh',
      country: 'PT',
      phone: '351912345678',
      has_purchase: false,
      last_event_at: '2026-04-30T11:28:00.000Z',
    },
    events: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_fresh',
        event_id: 'evt-8',
        event_type: 'checkout_start',
        event_timestamp: '2026-04-30T11:20:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
      },
    ],
  })

  const summary = buildRecoveryCandidates(
    [staleContext, freshContext],
    new Date('2026-04-30T11:35:00.000Z'),
    { maxEligibleAgeMs: 10 * 60 * 1000 },
  )

  assert.equal(summary.candidates.length, 1)
  assert.equal(summary.candidates[0]?.lead_id, 'lead_fresh')
  assert.equal(summary.skipped.length, 1)
  assert.equal(summary.skipped[0]?.lead_id, 'lead_stale')
  assert.equal(summary.skipped[0]?.reason, 'eligible_window_expired')
})

test('dispatchDueRecoveries prioritizes recent leads before old backlog', async () => {
  const supabase = createSupabaseMock({
    compactRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_old',
        name: 'Lead Old',
        email: 'old@test.com',
        phone: '351911111111',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-03-10T19:40:00.000Z',
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_recent',
        name: 'Lead Recent',
        email: 'recent@test.com',
        phone: '351922222222',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-05-03T16:10:14.610Z',
      },
    ],
    funnelLeadRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_old',
        attributes: {},
        metadata: {},
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_recent',
        attributes: {},
        metadata: {},
      },
    ],
    eventRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_old',
        event_id: 'evt-old',
        event_type: 'checkout_start',
        event_timestamp: '2026-03-10T19:30:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
        purchase: null,
        metadata: null,
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_recent',
        event_id: 'evt-recent',
        event_type: 'PURCHASE_BILLET_PRINTED',
        event_timestamp: '2026-05-03T16:10:14.610Z',
        step_id: 'checkout_front',
        page_path: '/pt/fim',
        attributes: { payment_type: 'CASHPAYMENT' },
        purchase: null,
        metadata: null,
      },
    ],
  })

  const previousLookback = process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  const previousBackfill = process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED
  process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = '3600000'
  process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED = 'false'

  const summary = await dispatchDueRecoveries({
    dryRun: true,
    limit: 1,
    funnelId: 'quiz_frequencia_01',
    supabase: supabase as unknown as SupabaseClient,
    now: new Date('2026-05-03T16:30:00.000Z'),
  })

  assert.equal(summary.candidate_count, 1)
  assert.equal(summary.candidates[0]?.lead_id, 'lead_recent')
  assert.equal(summary.candidates[0]?.message_type, 'multibanco_reminder')

  if (typeof previousLookback === 'string') process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = previousLookback
  else delete process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  if (typeof previousBackfill === 'string') process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED = previousBackfill
  else delete process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED
})

test('dispatchDueRecoveries filters batch events before default response cap', async () => {
  const oldIrrelevantEvents = Array.from({ length: 1000 }, (_, index) => ({
    funnel_id: 'quiz_frequencia_01',
    lead_id: 'lead_noisy',
    event_id: `evt-noisy-${index}`,
    event_type: 'step_view',
    event_timestamp: new Date(Date.parse('2026-04-01T00:00:00.000Z') + index * 1000).toISOString(),
    step_id: '/noise',
    page_path: '/pt/noise',
    attributes: null,
    purchase: null,
    metadata: null,
  }))

  const supabase = createSupabaseMock({
    defaultSelectLimits: {
      funnel_events: 1000,
    },
    compactRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_noisy',
        name: 'Lead Noisy',
        email: 'noisy@test.com',
        phone: '351911111111',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-05-09T06:37:00.000Z',
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_audited',
        name: 'Lead Audited',
        email: 'audited@test.com',
        phone: '351934776684',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-05-09T06:13:02.530Z',
      },
    ],
    funnelLeadRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_noisy',
        attributes: {},
        metadata: {},
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_audited',
        attributes: {},
        metadata: {},
      },
    ],
    eventRows: [
      ...oldIrrelevantEvents,
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_audited',
        event_id: 'evt-audited-contact',
        event_type: 'lead_identified',
        event_timestamp: '2026-05-09T05:58:20.048Z',
        step_id: '/resultado',
        page_path: null,
        attributes: {
          phone: '351934776684',
        },
        purchase: null,
        metadata: null,
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_audited',
        event_id: 'evt-audited-offer',
        event_type: 'offer_revealed',
        event_timestamp: '2026-05-09T06:13:02.530Z',
        step_id: '/fim-pos-pitch',
        page_path: null,
        attributes: {
          source: 'gatingComplete',
          gate: 'fim_below_fold',
        },
        purchase: null,
        metadata: null,
      },
    ],
  })

  const previousLookback = process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  const previousBackfill = process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED
  process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = '3600000'
  process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED = 'false'

  const summary = await dispatchDueRecoveries({
    dryRun: true,
    limit: 10,
    funnelId: 'quiz_frequencia_01',
    supabase: supabase as unknown as SupabaseClient,
    now: new Date('2026-05-09T06:40:00.000Z'),
  })

  assert.equal(summary.candidates.some((candidate) => candidate.lead_id === 'lead_audited'), true)
  assert.equal(summary.skipped.some((skipped) => (
    skipped.lead_id === 'lead_audited' && skipped.reason === 'not_due'
  )), false)

  if (typeof previousLookback === 'string') process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = previousLookback
  else delete process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  if (typeof previousBackfill === 'string') process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED = previousBackfill
  else delete process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED
})

test('dispatchDueRecoveries keeps exact lead lookup unchanged', async () => {
  const supabase = createSupabaseMock({
    compactRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_specific',
        name: 'Lead Specific',
        email: 'specific@test.com',
        phone: '351933333333',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-03-10T19:40:00.000Z',
      },
    ],
    funnelLeadRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_specific',
        attributes: {},
        metadata: {},
      },
    ],
    eventRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_specific',
        event_id: 'evt-specific',
        event_type: 'checkout_start',
        event_timestamp: '2026-03-10T19:30:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
        purchase: null,
        metadata: null,
      },
    ],
  })

  const previousLookback = process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = '60000'

  const summary = await dispatchDueRecoveries({
    dryRun: true,
    limit: 1,
    leadId: 'lead_specific',
    funnelId: 'quiz_frequencia_01',
    supabase: supabase as unknown as SupabaseClient,
    now: new Date('2026-05-03T16:30:00.000Z'),
  })

  assert.equal(summary.candidate_count, 1)
  assert.equal(summary.candidates[0]?.lead_id, 'lead_specific')
  assert.equal(summary.candidates[0]?.message_type, 'checkout_no_purchase')

  if (typeof previousLookback === 'string') process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = previousLookback
  else delete process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
})

test('dispatchDueRecoveries appends backfill only after recent-first fetch', async () => {
  const supabase = createSupabaseMock({
    compactRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_old',
        name: 'Lead Old',
        email: 'old@test.com',
        phone: '351911111111',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-03-10T19:40:00.000Z',
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_recent',
        name: 'Lead Recent',
        email: 'recent@test.com',
        phone: '351922222222',
        country: 'PT',
        has_purchase: false,
        last_event_at: '2026-05-03T16:10:14.610Z',
      },
    ],
    funnelLeadRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_old',
        attributes: {},
        metadata: {},
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_recent',
        attributes: {},
        metadata: {},
      },
    ],
    eventRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_old',
        event_id: 'evt-old',
        event_type: 'checkout_start',
        event_timestamp: '2026-03-10T19:30:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
        purchase: null,
        metadata: null,
      },
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_recent',
        event_id: 'evt-recent',
        event_type: 'PURCHASE_BILLET_PRINTED',
        event_timestamp: '2026-05-03T16:10:14.610Z',
        step_id: 'checkout_front',
        page_path: '/pt/fim',
        attributes: { payment_type: 'CASHPAYMENT' },
        purchase: null,
        metadata: null,
      },
    ],
  })

  const previousLookback = process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  const previousBackfill = process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED
  process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = '60000'
  process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED = 'true'

  const summary = await dispatchDueRecoveries({
    dryRun: true,
    limit: 2,
    funnelId: 'quiz_frequencia_01',
    supabase: supabase as unknown as SupabaseClient,
    now: new Date('2026-05-03T16:30:00.000Z'),
  })

  assert.equal(summary.candidate_count, 2)
  assert.deepEqual(
    summary.candidates.map((candidate) => candidate.lead_id).sort(),
    ['lead_old', 'lead_recent'],
  )

  if (typeof previousLookback === 'string') process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS = previousLookback
  else delete process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS
  if (typeof previousBackfill === 'string') process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED = previousBackfill
  else delete process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED
})

test('fetchRecoveryTemplateLookup loads active route, template and bindings by message_type + country', async () => {
  const supabase = createSupabaseMock({
    routeRows: [
      {
        route_id: 'route-1',
        message_type: 'checkout_no_purchase',
        country: 'PT',
        template_id: 'template-1',
        is_active: true,
        metadata: {},
      },
    ],
    bindingRows: [
      {
        route_id: 'route-1',
        token: '{{1}}',
        source_key: 'name',
        source_label: 'Nome completo',
        resolution_mode: 'pass_through',
        value_map: {},
        fallback_value: 'Cliente',
        required: true,
      },
    ],
    templateRows: [
      {
        template_id: 'template-1',
        name: 'Template PT',
        channel: 'whatsapp',
        template_category: 'inicializacao',
        meta_template_id: 'meta-1',
        meta_language: 'pt_PT',
        meta_payload: { components: [] },
        variable_definitions: [{ token: '{{1}}', index: 1, label: 'Nome', required: true }],
      },
    ],
  })

  const lookup = await fetchRecoveryTemplateLookup(
    supabase as unknown as SupabaseClient,
    makeContext().compact
      ? {
        lead_id: 'lead_test',
        funnel_id: 'quiz_frequencia_01',
        message_type: 'checkout_no_purchase',
        country: 'PT',
        language: 'pt',
        phone: '351912345678',
        email: 'lead@test.com',
        name: 'Lead Test',
        eligible_at: '2026-05-02T05:00:00.000Z',
        reason: 'checkout_due_after_10m_without_purchase',
        source_country: 'view',
        trigger: {
          event_id: 'evt-1',
          event_type: 'checkout_start',
          event_timestamp: '2026-05-02T04:50:00.000Z',
          payment_type: null,
          step_id: '/fim',
          page_path: '/pt/fim',
        },
      }
      : assert.fail('unreachable'),
  )

  assert.ok(lookup)
  assert.equal(lookup?.route.route_id, 'route-1')
  assert.equal(lookup?.template.meta_language, 'pt_PT')
  assert.equal(lookup?.bindings[0]?.source_key, 'name')
})

test('dispatchDueRecoveries sends enriched template payload and audits successful send', async () => {
  const supabase = createSupabaseMock({
    compactRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_dispatch',
        name: 'mAria da silva',
        email: 'lead@test.com',
        phone: '351912345678',
        country: 'PT',
        desire: { question: 'Qual seu desejo?', response: ['riqueza'] },
        has_purchase: false,
        last_event_at: '2026-05-02T05:15:00.000Z',
      },
    ],
    funnelLeadRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_dispatch',
        attributes: {},
        metadata: {},
      },
    ],
    eventRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_dispatch',
        event_id: 'evt-1',
        event_type: 'checkout_start',
        event_timestamp: '2026-05-02T05:00:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
        purchase: null,
        metadata: null,
      },
    ],
    routeRows: [
      {
        route_id: 'route-1',
        message_type: 'checkout_no_purchase',
        country: 'PT',
        template_id: 'template-1',
        is_active: true,
        metadata: {},
      },
    ],
    bindingRows: [
      {
        route_id: 'route-1',
        token: '{{1}}',
        source_key: 'name',
        source_label: 'Nome completo',
        resolution_mode: 'pass_through',
        value_map: {},
        fallback_value: 'Cliente',
        required: true,
      },
      {
        route_id: 'route-1',
        token: '{{2}}',
        source_key: 'desire.response[0]',
        source_label: 'Primeiro desejo',
        resolution_mode: 'mapped_value',
        value_map: { riqueza: 'Riqueza' },
        fallback_value: 'Fallback desejo',
        required: true,
      },
    ],
    templateRows: [
      {
        template_id: 'template-1',
        name: 'Template PT',
        channel: 'whatsapp',
        template_category: 'inicializacao',
        meta_template_id: 'meta-1',
        meta_language: 'pt_PT',
        meta_payload: { components: [] },
        variable_definitions: [
          { token: '{{1}}', index: 1, label: 'Nome', required: true },
          { token: '{{2}}', index: 2, label: 'Desejo', required: true },
        ],
      },
    ],
  })

  let sentPayload: RecoveryN8NPayload | null = null

  const summary = await dispatchDueRecoveries({
    limit: 5,
    funnelId: 'quiz_frequencia_01',
    supabase: supabase as unknown as SupabaseClient,
    now: new Date('2026-05-02T05:20:00.000Z'),
    sendToN8N: async (payload) => {
      sentPayload = payload
      return {
        ok: true,
        status: 200,
        data: { ok: true },
        error: null,
      }
    },
  })

  assert.equal(summary.results.length, 1)
  assert.equal(summary.results[0]?.status, 'sent')
  assert.equal(sentPayload?.metadata.template_id, 'template-1')
  assert.equal(sentPayload?.metadata.template_variable_values['{{1}}'], 'Maria')
  assert.equal(sentPayload?.metadata.template_variable_values['{{2}}'], 'Riqueza')
  assert.equal(
    supabase.updates.some((entry) =>
      entry.patch.n8n_status === 'sent'
      && typeof entry.patch.n8n_response === 'object'
      && entry.patch.n8n_response !== null,
    ),
    true,
  )
})

test('dispatchDueRecoveries marks missing required template value as auditable failure', async () => {
  const supabase = createSupabaseMock({
    compactRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_missing_value',
        name: null,
        email: 'lead@test.com',
        phone: '351912345678',
        country: 'PT',
        desire: { question: 'Qual seu desejo?', response: [] },
        has_purchase: false,
        last_event_at: '2026-05-02T05:15:00.000Z',
      },
    ],
    funnelLeadRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_missing_value',
        attributes: {},
        metadata: {},
      },
    ],
    eventRows: [
      {
        funnel_id: 'quiz_frequencia_01',
        lead_id: 'lead_missing_value',
        event_id: 'evt-2',
        event_type: 'checkout_start',
        event_timestamp: '2026-05-02T05:00:00.000Z',
        step_id: '/fim',
        page_path: '/pt/fim',
        attributes: null,
        purchase: null,
        metadata: null,
      },
    ],
    routeRows: [
      {
        route_id: 'route-2',
        message_type: 'checkout_no_purchase',
        country: 'PT',
        template_id: 'template-2',
        is_active: true,
        metadata: {},
      },
    ],
    bindingRows: [
      {
        route_id: 'route-2',
        token: '{{1}}',
        source_key: 'name',
        source_label: 'Nome completo',
        resolution_mode: 'pass_through',
        value_map: {},
        fallback_value: null,
        required: true,
      },
    ],
    templateRows: [
      {
        template_id: 'template-2',
        name: 'Template PT',
        channel: 'whatsapp',
        template_category: 'inicializacao',
        meta_template_id: 'meta-2',
        meta_language: 'pt_PT',
        meta_payload: { components: [] },
        variable_definitions: [{ token: '{{1}}', index: 1, label: 'Nome', required: true }],
      },
    ],
  })

  let sendCalled = false

  const summary = await dispatchDueRecoveries({
    limit: 5,
    funnelId: 'quiz_frequencia_01',
    supabase: supabase as unknown as SupabaseClient,
    now: new Date('2026-05-02T05:20:00.000Z'),
    sendToN8N: async () => {
      sendCalled = true
      return {
        ok: true,
        status: 200,
        data: { ok: true },
        error: null,
      }
    },
  })

  assert.equal(sendCalled, false)
  assert.equal(summary.results[0]?.status, 'missing_required_template_variable')
  assert.equal(summary.results[0]?.n8n_status, 'failed')
  assert.equal(
    supabase.updates.some((entry) => entry.patch.n8n_status === 'failed'),
    true,
  )
})
