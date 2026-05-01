import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecoveryCandidate,
  buildRecoveryCandidates,
  normalizeLimit,
} from '../recoveryDispatcher.js'
import type { RecoveryLeadContext } from '../recoveryTypes.js'

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

test('normalizeLimit keeps values within safe max', () => {
  assert.equal(normalizeLimit(undefined), 20)
  assert.equal(normalizeLimit('7'), 7)
  assert.equal(normalizeLimit(999), 100)
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
