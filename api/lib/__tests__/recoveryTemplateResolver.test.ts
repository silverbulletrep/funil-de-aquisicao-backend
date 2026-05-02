/**
 * Verifies recovery template variable resolution rules, including desire access,
 * fallback behavior, mapped values, and the special first-name normalization.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRecoveryTemplatePayload, resolveRecoveryTemplateValues } from '../recoveryTemplateResolver.js'
import type {
  CompactLeadRow,
  RecoveryCandidate,
  RecoveryTemplateLookupResult,
} from '../recoveryTypes.js'

function makeLookup(overrides?: Partial<RecoveryTemplateLookupResult>): RecoveryTemplateLookupResult {
  return {
    route: {
      route_id: 'route-1',
      message_type: 'checkout_no_purchase',
      country: 'PT',
      template_id: 'template-1',
      is_active: true,
      metadata: null,
    },
    template: {
      template_id: 'template-1',
      name: 'Template PT',
      template_category: 'inicializacao',
      meta_template_id: 'meta-123',
      meta_language: 'pt_PT',
      meta_payload: { components: [] },
      variable_definitions: [
        { token: '{{1}}', index: 1, label: 'Nome', required: true },
        { token: '{{2}}', index: 2, label: 'Desejo', required: true },
      ],
    },
    bindings: [
      {
        token: '{{1}}',
        source_key: 'name',
        source_label: 'Nome completo',
        resolution_mode: 'pass_through',
        value_map: {},
        fallback_value: 'Cliente',
        required: true,
      },
      {
        token: '{{2}}',
        source_key: 'desire.response[0]',
        source_label: 'Primeiro desejo',
        resolution_mode: 'mapped_value',
        value_map: { riqueza: 'Riqueza' },
        fallback_value: 'Fallback desejo',
        required: true,
      },
    ],
    ...overrides,
  }
}

function makeLead(overrides?: Partial<CompactLeadRow>): CompactLeadRow {
  return {
    funnel_id: 'quiz_frequencia_01',
    lead_id: 'lead-1',
    name: 'mAria   da silva',
    email: 'lead@test.com',
    phone: '351912345678',
    country: 'PT',
    desire: {
      question: 'Qual seu desejo?',
      response: ['riqueza', 'liberdade'],
    },
    auto_tag: 'EM RECUPERACAO',
    has_purchase: false,
    last_event_at: '2026-05-02T05:00:00.000Z',
    ...overrides,
  }
}

function makeCandidate(overrides?: Partial<RecoveryCandidate>): RecoveryCandidate {
  return {
    lead_id: 'lead-1',
    funnel_id: 'quiz_frequencia_01',
    message_type: 'checkout_no_purchase',
    country: 'PT',
    language: 'pt',
    phone: '351912345678',
    email: 'lead@test.com',
    name: 'Maria da Silva',
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
    ...overrides,
  }
}

test('resolveRecoveryTemplateValues reads desire subpaths and mapped values', () => {
  const resolution = resolveRecoveryTemplateValues(
    makeLead(),
    makeLookup().template.variable_definitions,
    makeLookup().bindings,
  )

  assert.deepEqual(resolution.issues, [])
  assert.equal(resolution.values['{{1}}'], 'Maria')
  assert.equal(resolution.values['{{2}}'], 'Riqueza')
})

test('resolveRecoveryTemplateValues falls back for mapped_value when there is no match', () => {
  const lookup = makeLookup({
    bindings: [
      makeLookup().bindings[0],
      {
        ...makeLookup().bindings[1],
        value_map: { abundancia: 'Abundancia' },
      },
    ],
  })

  const resolution = resolveRecoveryTemplateValues(
    makeLead(),
    lookup.template.variable_definitions,
    lookup.bindings,
  )

  assert.deepEqual(resolution.issues, [])
  assert.equal(resolution.values['{{2}}'], 'Fallback desejo')
})

test('resolveRecoveryTemplateValues falls back for pass_through when source value is missing', () => {
  const lookup = makeLookup({
    bindings: [
      {
        ...makeLookup().bindings[0],
        source_key: 'email',
        source_label: 'E-mail',
        fallback_value: 'fallback@email.test',
      },
      makeLookup().bindings[1],
    ],
  })

  const resolution = resolveRecoveryTemplateValues(
    makeLead({ email: null }),
    lookup.template.variable_definitions,
    lookup.bindings,
  )

  assert.deepEqual(resolution.issues, [])
  assert.equal(resolution.values['{{1}}'], 'fallback@email.test')
})

test('buildRecoveryTemplatePayload returns auditable issue when a required value stays empty', () => {
  const result = buildRecoveryTemplatePayload({
    candidate: makeCandidate(),
    compactLead: makeLead({
      name: null,
      desire: { question: 'Qual seu desejo?', response: [] },
    }),
    lookup: makeLookup({
      bindings: [
        {
          ...makeLookup().bindings[0],
          fallback_value: null,
        },
        {
          ...makeLookup().bindings[1],
          fallback_value: null,
        },
      ],
    }),
  })

  assert.equal(result.ok, false)
  if (result.ok) {
    assert.fail('Expected resolution to fail when required variables remain empty')
  }

  assert.equal(result.issues.length, 2)
  assert.equal(result.issues[0]?.reason, 'missing_required_value')
})

test('buildRecoveryTemplatePayload produces enriched N8N metadata', () => {
  const result = buildRecoveryTemplatePayload({
    candidate: makeCandidate(),
    compactLead: makeLead(),
    lookup: makeLookup(),
  })

  assert.equal(result.ok, true)
  if (!result.ok) {
    assert.fail('Expected payload generation to succeed')
  }

  assert.equal(result.payload.destination, '351912345678')
  assert.equal(result.payload.metadata.template_id, 'template-1')
  assert.equal(result.payload.metadata.template_variable_values['{{1}}'], 'Maria')
  assert.equal(result.payload.metadata.template_variable_values['{{2}}'], 'Riqueza')
})
