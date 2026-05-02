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
            const leftValue = left[state.orderBy?.column]
            const rightValue = right[state.orderBy?.column]
            const compare = String(leftValue ?? '').localeCompare(String(rightValue ?? ''))
            return state.orderBy?.ascending ? compare : -compare
          })
        }

        if (typeof state.limit === 'number') {
          rows = rows.slice(0, state.limit)
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

test('no_checkout uses /resultado lead_identified after 25 minutes', () => {
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
    ],
  })

  const evaluation = buildRecoveryCandidate(context, new Date('2026-04-30T11:30:01.000Z'))
  assert.ok(evaluation.candidate)
  assert.equal(evaluation.candidate?.message_type, 'no_checkout')
  assert.equal(evaluation.candidate?.language, 'unknown')
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
