import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from './supabaseAdmin.js'
import { sendRecoveryTemplateToN8N } from './recoveryN8N.js'
import type {
  CompactLeadRow,
  FunnelEventRow,
  FunnelLeadRow,
  RecoveryCandidate,
  RecoveryDispatchResult,
  RecoveryDispatchSummary,
  RecoveryLeadContext,
  RecoveryMessageType,
  RecoveryN8NPayload,
  RecoverySkippedLead,
} from './recoveryTypes.js'

const DEFAULT_FUNNEL_ID = process.env.RECOVERY_FUNNEL_ID || 'quiz_frequencia_01'
const TEN_MINUTES_MS = 10 * 60 * 1000
const TWENTY_FIVE_MINUTES_MS = 25 * 60 * 1000
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

type JsonRecord = Record<string, unknown>

export function normalizeLimit(rawLimit: unknown, maxLimit: number = MAX_LIMIT): number {
  const parsed = Number(rawLimit)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(Math.trunc(parsed), maxLimit)
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeCountry(value: unknown): string {
  const normalized = normalizeText(value).toUpperCase()
  if (!normalized) return ''
  if (normalized === 'UN') return 'unknown'
  return normalized
}

function normalizePhone(value: unknown): string {
  const digits = String(value || '').replace(/\D/g, '')
  return digits
}

function isValidPhone(phone: string): boolean {
  return phone.length >= 8 && phone.length <= 15
}

function toJsonRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

function readJsonText(record: JsonRecord | null | undefined, ...keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    const text = normalizeText(value)
    if (text) return text
  }
  return ''
}

function parseEventTime(event: Pick<FunnelEventRow, 'event_timestamp'>): number {
  return new Date(event.event_timestamp).getTime()
}

function inferCountryFromPagePaths(events: FunnelEventRow[]): string {
  for (const event of events) {
    const pagePath = normalizeText(event.page_path).toLowerCase()
    if (!pagePath) continue
    if (pagePath.includes('/de/')) return 'DE'
    if (pagePath.includes('/pt/')) return 'PT'
  }
  return ''
}

function deriveLanguage(country: string, events: FunnelEventRow[]): 'pt' | 'de' | 'unknown' {
  const normalizedCountry = normalizeCountry(country)
  if (normalizedCountry === 'PT') return 'pt'
  if (normalizedCountry === 'DE') return 'de'

  const inferredCountry = inferCountryFromPagePaths(events)
  if (inferredCountry === 'PT') return 'pt'
  if (inferredCountry === 'DE') return 'de'
  return 'unknown'
}

function getEventPaymentType(event: FunnelEventRow | undefined): string | null {
  const attributes = toJsonRecord(event?.attributes)
  const paymentType = readJsonText(attributes, 'payment_type')
  return paymentType ? paymentType.toUpperCase() : null
}

function resolveCountry(context: RecoveryLeadContext): {
  country: string
  source_country: RecoveryCandidate['source_country']
} {
  const fromView = normalizeCountry(context.compact.country)
  if (fromView && fromView !== 'unknown') {
    return { country: fromView, source_country: 'view' }
  }

  const fromLeadMetadata = normalizeCountry(
    readJsonText(toJsonRecord(context.funnelLead?.metadata), 'country'),
  )
  if (fromLeadMetadata && fromLeadMetadata !== 'unknown') {
    return { country: fromLeadMetadata, source_country: 'metadata' }
  }

  const fromPaths = inferCountryFromPagePaths(context.events)
  if (fromPaths) {
    return { country: fromPaths, source_country: 'page_path' }
  }

  return { country: 'unknown', source_country: 'unknown' }
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const text = normalizeText(value)
    if (text) return text
  }
  return null
}

function getLatestLeadIdentified(events: FunnelEventRow[]): FunnelEventRow | undefined {
  const filtered = events.filter(
    (event) => event.event_type === 'lead_identified' && normalizeText(event.step_id) === '/resultado',
  )
  return filtered[filtered.length - 1]
}

function getFirstLeadIdentified(events: FunnelEventRow[]): FunnelEventRow | undefined {
  return events.find(
    (event) => event.event_type === 'lead_identified' && normalizeText(event.step_id) === '/resultado',
  )
}

function resolveContact(context: RecoveryLeadContext): {
  phone: string
  email: string | null
  name: string | null
} {
  const latestLeadIdentified = getLatestLeadIdentified(context.events)
  const leadIdentifiedAttributes = toJsonRecord(latestLeadIdentified?.attributes)
  const funnelLeadAttributes = toJsonRecord(context.funnelLead?.attributes)
  const funnelLeadMetadata = toJsonRecord(context.funnelLead?.metadata)

  const phoneCandidates = [
    normalizePhone(context.compact.phone),
    normalizePhone(readJsonText(leadIdentifiedAttributes, 'phone')),
    normalizePhone(readJsonText(funnelLeadAttributes, 'phone', 'whatsapp')),
    normalizePhone(readJsonText(funnelLeadMetadata, 'phone', 'whatsapp')),
  ]

  const phone = phoneCandidates.find((candidate) => isValidPhone(candidate)) || ''

  const email = pickFirstNonEmpty(
    context.compact.email,
    readJsonText(leadIdentifiedAttributes, 'email'),
    readJsonText(funnelLeadAttributes, 'email'),
    readJsonText(funnelLeadMetadata, 'email'),
  )

  const name = pickFirstNonEmpty(
    context.compact.name,
    readJsonText(leadIdentifiedAttributes, 'name'),
    readJsonText(funnelLeadAttributes, 'name'),
    readJsonText(funnelLeadMetadata, 'name'),
  )

  return { phone, email, name }
}

function buildCandidateFromTrigger(
  context: RecoveryLeadContext,
  messageType: RecoveryMessageType,
  trigger: FunnelEventRow,
  dueWindowMs: number,
  reason: string,
): RecoveryCandidate {
  const { country, source_country } = resolveCountry(context)
  const { phone, email, name } = resolveContact(context)

  return {
    lead_id: context.compact.lead_id,
    funnel_id: context.compact.funnel_id,
    message_type: messageType,
    country,
    language: deriveLanguage(country, context.events),
    phone,
    email,
    name,
    eligible_at: new Date(parseEventTime(trigger) + dueWindowMs).toISOString(),
    reason,
    source_country,
    trigger: {
      event_id: trigger.event_id || null,
      event_type: trigger.event_type,
      event_timestamp: trigger.event_timestamp,
      payment_type: getEventPaymentType(trigger),
      step_id: trigger.step_id || null,
      page_path: trigger.page_path || null,
    },
  }
}

export function buildRecoveryCandidate(
  context: RecoveryLeadContext,
  now: Date = new Date(),
): { candidate?: RecoveryCandidate; skipped?: RecoverySkippedLead } {
  const leadId = context.compact.lead_id
  const funnelId = context.compact.funnel_id
  const events = [...context.events].sort((a, b) => parseEventTime(a) - parseEventTime(b))
  const hasPurchase = Boolean(context.compact.has_purchase) || events.some((event) => {
    if (event.event_type === 'purchase') return true
    return Boolean(event.purchase && Object.keys(event.purchase).length > 0)
  })

  if (hasPurchase) {
    return {
      skipped: {
        lead_id: leadId,
        funnel_id: funnelId,
        reason: 'has_purchase',
      },
    }
  }

  const nowTs = now.getTime()
  const cashPaymentEvent = events.find((event) => {
    return (
      event.event_type === 'PURCHASE_BILLET_PRINTED' &&
      getEventPaymentType(event) === 'CASHPAYMENT' &&
      parseEventTime(event) <= nowTs - TEN_MINUTES_MS
    )
  })

  const checkoutEvent = events.find((event) => {
    return event.event_type === 'checkout_start' && parseEventTime(event) <= nowTs - TEN_MINUTES_MS
  })

  const hasAnyCheckout = events.some((event) => event.event_type === 'checkout_start')
  const baseLeadIdentified = getFirstLeadIdentified(events)
  const fallbackBaseEvent = events[0]
  const noCheckoutBase = baseLeadIdentified || fallbackBaseEvent
  const noCheckoutDue = Boolean(
    !hasAnyCheckout &&
    noCheckoutBase &&
    parseEventTime(noCheckoutBase) <= nowTs - TWENTY_FIVE_MINUTES_MS,
  )

  let candidate: RecoveryCandidate | undefined

  if (cashPaymentEvent) {
    candidate = buildCandidateFromTrigger(
      context,
      'multibanco_reminder',
      cashPaymentEvent,
      TEN_MINUTES_MS,
      'cashpayment_due_after_10m',
    )
  } else if (checkoutEvent) {
    candidate = buildCandidateFromTrigger(
      context,
      'checkout_no_purchase',
      checkoutEvent,
      TEN_MINUTES_MS,
      'checkout_due_after_10m_without_purchase',
    )
  } else if (noCheckoutDue && noCheckoutBase) {
    candidate = buildCandidateFromTrigger(
      context,
      'no_checkout',
      noCheckoutBase,
      TWENTY_FIVE_MINUTES_MS,
      baseLeadIdentified
        ? 'no_checkout_due_after_25m_from_result'
        : 'no_checkout_due_after_25m_from_first_event',
    )
  }

  if (!candidate) {
    return {
      skipped: {
        lead_id: leadId,
        funnel_id: funnelId,
        reason: 'not_due',
      },
    }
  }

  if (!isValidPhone(candidate.phone)) {
    return {
      skipped: {
        lead_id: leadId,
        funnel_id: funnelId,
        reason: 'missing_valid_phone',
      },
    }
  }

  return { candidate }
}

export function buildRecoveryCandidates(
  contexts: RecoveryLeadContext[],
  now: Date = new Date(),
): { candidates: RecoveryCandidate[]; skipped: RecoverySkippedLead[] } {
  const candidates: RecoveryCandidate[] = []
  const skipped: RecoverySkippedLead[] = []

  for (const context of contexts) {
    const evaluation = buildRecoveryCandidate(context, now)
    if (evaluation.candidate) {
      candidates.push(evaluation.candidate)
    } else if (evaluation.skipped) {
      skipped.push(evaluation.skipped)
    }
  }

  candidates.sort((left, right) => {
    const leftTime = new Date(left.eligible_at).getTime()
    const rightTime = new Date(right.eligible_at).getTime()
    if (leftTime !== rightTime) return leftTime - rightTime

    const priority: Record<RecoveryMessageType, number> = {
      multibanco_reminder: 1,
      checkout_no_purchase: 2,
      no_checkout: 3,
    }

    return priority[left.message_type] - priority[right.message_type]
  })

  return { candidates, skipped }
}

async function fetchLeadContexts(
  supabase: SupabaseClient,
  params: { leadId?: string; limit: number; funnelId: string },
): Promise<RecoveryLeadContext[]> {
  const fetchLeadCount = params.leadId ? 1 : Math.min(Math.max(params.limit * 5, params.limit), 250)

  let compactQuery = supabase
    .from('vw_funnel_lead_compact')
    .select('funnel_id,lead_id,session_id,name,email,phone,age,gender,country,has_purchase,last_event_at,perfil_image,auto_tag')
    .eq('funnel_id', params.funnelId)
    .order('last_event_at', { ascending: true })

  if (params.leadId) {
    compactQuery = compactQuery.eq('lead_id', params.leadId)
  } else {
    compactQuery = compactQuery.eq('has_purchase', false).limit(fetchLeadCount)
  }

  const { data: compactRows, error: compactError } = await compactQuery

  if (compactError) {
    throw new Error(`Falha ao consultar vw_funnel_lead_compact: ${compactError.message}`)
  }

  const compactLeads = (compactRows || []).filter((row) => normalizeText(row.lead_id)) as CompactLeadRow[]
  if (!compactLeads.length) return []

  const leadIds = [...new Set(compactLeads.map((row) => row.lead_id))]

  const { data: funnelLeads, error: funnelLeadsError } = await supabase
    .from('funnel_leads')
    .select('funnel_id,lead_id,attributes,metadata')
    .eq('funnel_id', params.funnelId)
    .in('lead_id', leadIds)

  if (funnelLeadsError) {
    throw new Error(`Falha ao consultar funnel_leads: ${funnelLeadsError.message}`)
  }

  const { data: events, error: eventsError } = await supabase
    .from('funnel_events')
    .select('event_id,funnel_id,lead_id,event_type,event_timestamp,received_at,step_id,page_path,attributes,purchase,metadata')
    .eq('funnel_id', params.funnelId)
    .in('lead_id', leadIds)
    .order('event_timestamp', { ascending: true })

  if (eventsError) {
    throw new Error(`Falha ao consultar funnel_events: ${eventsError.message}`)
  }

  const funnelLeadByLeadId = new Map<string, FunnelLeadRow>()
  for (const funnelLead of (funnelLeads || []) as FunnelLeadRow[]) {
    funnelLeadByLeadId.set(funnelLead.lead_id, funnelLead)
  }

  const eventsByLeadId = new Map<string, FunnelEventRow[]>()
  for (const event of (events || []) as FunnelEventRow[]) {
    const current = eventsByLeadId.get(event.lead_id) || []
    current.push(event)
    eventsByLeadId.set(event.lead_id, current)
  }

  return compactLeads.map((compact) => ({
    compact,
    funnelLead: funnelLeadByLeadId.get(compact.lead_id) || null,
    events: eventsByLeadId.get(compact.lead_id) || [],
  }))
}

async function hasPurchaseEvent(
  supabase: SupabaseClient,
  funnelId: string,
  leadId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('funnel_events')
    .select('event_id')
    .eq('funnel_id', funnelId)
    .eq('lead_id', leadId)
    .eq('event_type', 'purchase')
    .limit(1)

  if (error) {
    throw new Error(`Falha ao revalidar purchase do lead ${leadId}: ${error.message}`)
  }

  return Array.isArray(data) && data.length > 0
}

async function createPendingDispatch(
  supabase: SupabaseClient,
  candidate: RecoveryCandidate,
): Promise<{ dispatchId: string | null; alreadyDispatched: boolean }> {
  const { data, error } = await supabase
    .from('whatsapp_recovery_dispatches')
    .insert({
      lead_id: candidate.lead_id,
      funnel_id: candidate.funnel_id,
      message_type: candidate.message_type,
      country: candidate.country,
      trigger_event_id: candidate.trigger.event_id,
      eligible_at: candidate.eligible_at,
      n8n_status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { dispatchId: null, alreadyDispatched: true }
    }
    throw new Error(`Falha ao inserir dispatch pendente: ${error.message}`)
  }

  return { dispatchId: (data as { id?: string } | null)?.id || null, alreadyDispatched: false }
}

async function updateDispatchStatus(
  supabase: SupabaseClient,
  dispatchId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('whatsapp_recovery_dispatches')
    .update(patch)
    .eq('id', dispatchId)

  if (error) {
    throw new Error(`Falha ao atualizar dispatch ${dispatchId}: ${error.message}`)
  }
}

function buildN8NPayload(candidate: RecoveryCandidate): RecoveryN8NPayload {
  return {
    lead_id: candidate.lead_id,
    message_type: candidate.message_type,
    country: candidate.country,
    language: candidate.language,
    phone: candidate.phone,
    email: candidate.email,
    name: candidate.name,
    funnel_id: candidate.funnel_id,
    trigger: candidate.trigger,
  }
}

export async function dispatchDueRecoveries(params: {
  dryRun?: boolean
  limit?: number
  leadId?: string
  funnelId?: string
  supabase?: SupabaseClient
  now?: Date
}): Promise<RecoveryDispatchSummary> {
  const dryRun = Boolean(params.dryRun)
  const limit = normalizeLimit(params.limit)
  const funnelId = normalizeText(params.funnelId) || DEFAULT_FUNNEL_ID
  const supabase = params.supabase || getSupabaseAdmin()
  const now = params.now || new Date()

  const contexts = await fetchLeadContexts(supabase, {
    leadId: normalizeText(params.leadId) || undefined,
    limit,
    funnelId,
  })

  const { candidates, skipped } = buildRecoveryCandidates(contexts, now)
  const selectedCandidates = candidates.slice(0, limit)

  if (dryRun) {
    return {
      dry_run: true,
      candidate_count: selectedCandidates.length,
      candidates: selectedCandidates,
      skipped,
      results: [],
    }
  }

  const results: RecoveryDispatchResult[] = []

  for (const candidate of selectedCandidates) {
    if (candidate.language === 'unknown') {
      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'unknown_language',
        reason: 'language_unknown_blocked_real_send',
        eligible_at: candidate.eligible_at,
        n8n_status: null,
      })
      continue
    }

    const { dispatchId, alreadyDispatched } = await createPendingDispatch(supabase, candidate)

    if (alreadyDispatched) {
      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'already_dispatched',
        reason: 'unique_conflict_lead_message_type',
        eligible_at: candidate.eligible_at,
        dispatch_id: null,
        n8n_status: null,
      })
      continue
    }

    if (!dispatchId) {
      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'failed',
        reason: 'dispatch_id_missing_after_insert',
        eligible_at: candidate.eligible_at,
        dispatch_id: null,
        n8n_status: 'failed',
      })
      continue
    }

    const purchaseFound = await hasPurchaseEvent(supabase, candidate.funnel_id, candidate.lead_id)
    if (purchaseFound) {
      await updateDispatchStatus(supabase, dispatchId, {
        n8n_status: 'skipped_purchase_found',
        n8n_response: {
          reason: 'purchase_found_before_send',
        },
      })

      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'skipped_purchase_found',
        reason: 'purchase_found_before_send',
        eligible_at: candidate.eligible_at,
        dispatch_id: dispatchId,
        n8n_status: 'skipped_purchase_found',
      })
      continue
    }

    const n8nPayload = buildN8NPayload(candidate)
    const n8nResponse = await sendRecoveryTemplateToN8N(n8nPayload)

    if (n8nResponse.ok) {
      await updateDispatchStatus(supabase, dispatchId, {
        n8n_status: 'sent',
        dispatched_at: new Date().toISOString(),
        n8n_response: {
          status: n8nResponse.status,
          data: n8nResponse.data,
        },
      })

      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'sent',
        reason: 'n8n_accepted_payload',
        eligible_at: candidate.eligible_at,
        dispatch_id: dispatchId,
        n8n_status: 'sent',
        response: n8nResponse.data,
      })
      continue
    }

    await updateDispatchStatus(supabase, dispatchId, {
      n8n_status: 'failed',
      n8n_response: {
        status: n8nResponse.status,
        error: n8nResponse.error,
        data: n8nResponse.data,
      },
    })

    results.push({
      lead_id: candidate.lead_id,
      funnel_id: candidate.funnel_id,
      message_type: candidate.message_type,
      status: 'failed',
      reason: n8nResponse.error || 'n8n_request_failed',
      eligible_at: candidate.eligible_at,
      dispatch_id: dispatchId,
      n8n_status: 'failed',
      response: n8nResponse.data,
    })
  }

  return {
    dry_run: false,
    candidate_count: selectedCandidates.length,
    candidates: selectedCandidates,
    skipped,
    results,
  }
}
