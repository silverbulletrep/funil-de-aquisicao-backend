// **Responsabilidade:** Regra de elegibilidade, prioridade e dispatch
// **Pergunta:** Como ele define elegibilidade? Prioridade? Dispatch?

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getRecoveryTemplateSourceLabel,
  isRecoveryTemplateSourceKey,
} from './recoveryTemplateCatalog.js'
import { buildRecoveryTemplatePayload } from './recoveryTemplateResolver.js'
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
  RecoveryMessageTemplate,
  RecoveryMessageType,
  RecoveryN8NPayload,
  RecoverySkippedLead,
  RecoveryTemplateBinding,
  RecoveryTemplateLookupResult,
  RecoveryTemplateResolutionMode,
  RecoveryTemplateRoute,
  RecoveryTemplateVariableDefinition,
} from './recoveryTypes.js'

// define FUNNEL ID que irá usar para capturar elegibilidade no recovery. Define quantidade de minutos para os disparos.
// 
const DEFAULT_FUNNEL_ID = process.env.RECOVERY_FUNNEL_ID || 'quiz_frequencia_01'
const TEN_MINUTES_MS = 10 * 60 * 1000
const TWENTY_FIVE_MINUTES_MS = 25 * 60 * 1000
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20
const RECOVERY_FETCH_SAFETY_MS = 2 * 60 * 1000
const POST_PITCH_STEP_ID = '/fim-pos-pitch'

type JsonRecord = Record<string, unknown>

type RecoveryTemplateRouteRow = {
  route_id: string
  message_type: RecoveryMessageType
  country: string
  template_id: string
  is_active: boolean
  metadata: Record<string, unknown> | null
}

type RecoveryTemplateBindingRow = {
  token: string
  source_key: string
  source_label: string
  resolution_mode: string
  value_map: Record<string, string> | null
  fallback_value: string | null
  required: boolean
}

type MessageTemplateRow = {
  template_id: string
  name: string | null
  template_category: 'inicializacao' | 'conversa' | null
  meta_template_id: string | null
  meta_language: string | null
  meta_payload: Record<string, unknown> | null
  variable_definitions: unknown
}

const RECOVERY_TEMPLATE_RESOLUTION_MODES: RecoveryTemplateResolutionMode[] = [
  'pass_through',
  'mapped_value',
]

// retorna limite
export function normalizeLimit(rawLimit: unknown, maxLimit: number = MAX_LIMIT): number {
  const parsed = Number(rawLimit)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(Math.trunc(parsed), maxLimit)
}

// retorna número, se for menor que zero ou não for finito, retorna null.
export function normalizeMaxEligibleAgeMs(rawValue: unknown): number | null {
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.trunc(parsed)
}

function resolveRecentLeadLookbackMs(maxEligibleAgeMs: number | null): number {
  const override = Number(process.env.RECOVERY_DISPATCH_RECENT_LOOKBACK_MS)
  if (Number.isFinite(override) && override > 0) {
    return Math.trunc(override)
  }

  return (maxEligibleAgeMs ?? 0) + TWENTY_FIVE_MINUTES_MS + RECOVERY_FETCH_SAFETY_MS
}

// normaliza texto
function normalizeText(value: unknown): string {
  // SE valor for tipo string, retorna o valor, sem espaços na frente e atrás.
  return typeof value === 'string' ? value.trim() : ''
}

// Retorna string em maiúsculo, se o valor for vazio, retorna vazio. Se o valor for "UN", retorna "unknown".
function normalizeCountry(value: unknown): string {
  // define valor em maiúsculo
  const normalized = normalizeText(value).toUpperCase()
  // se valor for null, ou false, retorna ''
  if (!normalized) return ''
  if (normalized === 'UN') return 'unknown'
  return normalized
}

// Remove tudo que não é número
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

function buildLeadContextKey(funnelId: string, leadId: string): string {
  return `${funnelId}:${leadId}`
}

function isRecoveryTemplateResolutionMode(value: string): value is RecoveryTemplateResolutionMode {
  return RECOVERY_TEMPLATE_RESOLUTION_MODES.includes(value as RecoveryTemplateResolutionMode)
}

function normalizeTemplateVariableDefinition(value: unknown): RecoveryTemplateVariableDefinition | null {
  if (!value || typeof value !== 'object') return null

  const token = normalizeText((value as { token?: unknown }).token)
  const index = Number((value as { index?: unknown }).index)

  if (!token || !Number.isInteger(index) || index <= 0) return null

  return {
    token,
    index,
    label: normalizeText((value as { label?: unknown }).label) || `Variavel ${index}`,
    example: normalizeText((value as { example?: unknown }).example) || undefined,
    required: typeof (value as { required?: unknown }).required === 'boolean'
      ? (value as { required: boolean }).required
      : true,
  }
}

function normalizeTemplateVariableDefinitions(value: unknown): RecoveryTemplateVariableDefinition[] {
  if (!Array.isArray(value)) return []

  return value
    .map((entry) => normalizeTemplateVariableDefinition(entry))
    .filter((entry): entry is RecoveryTemplateVariableDefinition => Boolean(entry))
    .sort((left, right) => left.index - right.index)
}

function normalizeTemplateBinding(row: RecoveryTemplateBindingRow): RecoveryTemplateBinding | null {
  if (!isRecoveryTemplateSourceKey(row.source_key)) return null
  if (!isRecoveryTemplateResolutionMode(row.resolution_mode)) return null

  return {
    token: normalizeText(row.token),
    source_key: row.source_key,
    source_label: normalizeText(row.source_label) || getRecoveryTemplateSourceLabel(row.source_key),
    resolution_mode: row.resolution_mode,
    value_map: toJsonRecord(row.value_map)
      ? Object.entries(row.value_map ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
        const normalizedKey = key.trim()
        const normalizedValue = normalizeText(value)
        if (!normalizedKey || !normalizedValue) return acc
        acc[normalizedKey] = normalizedValue
        return acc
      }, {})
      : {},
    fallback_value: normalizeText(row.fallback_value) || null,
    required: row.required !== false,
  }
}

function normalizeMessageTemplate(row: MessageTemplateRow): RecoveryMessageTemplate {
  return {
    template_id: row.template_id,
    name: normalizeText(row.name) || row.template_id,
    template_category: row.template_category ?? null,
    meta_template_id: normalizeText(row.meta_template_id) || null,
    meta_language: normalizeText(row.meta_language) || null,
    meta_payload: toJsonRecord(row.meta_payload),
    variable_definitions: normalizeTemplateVariableDefinitions(row.variable_definitions),
  }
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

function getFirstOfferRevealed(events: FunnelEventRow[]): FunnelEventRow | undefined {
  return events.find(
    (event) => event.event_type === 'offer_revealed' && normalizeText(event.step_id) === POST_PITCH_STEP_ID,
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

// Retorna candidato de recuperação, com número, , tipo de mensagem, trigger, email, nome e país mapeados.
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

// Função que categoriza e retorna o candidato de recuperação. ALTERAR AQUI SE precisar adicionar novas regras.
export function buildRecoveryCandidate(
  context: RecoveryLeadContext,
  now: Date = new Date(),
): { candidate?: RecoveryCandidate; skipped?: RecoverySkippedLead } {
  const leadId = context.compact.lead_id
  const funnelId = context.compact.funnel_id
  const events = [...context.events].sort((a, b) => parseEventTime(a) - parseEventTime(b))
  // captura bollean que verifica se existe purchase, seja no evento ou na compact.
  const hasPurchase = Boolean(context.compact.has_purchase) || events.some((event) => {
    if (event.event_type === 'purchase') return true
    return Boolean(event.purchase && Object.keys(event.purchase).length > 0)
  })

  // Se o lead tiver purchase, retorna skipped
  if (hasPurchase) {
    return {
      skipped: {
        lead_id: leadId,
        funnel_id: funnelId,
        reason: 'has_purchase',
      },
    }
  }

  // Verifica se existe evento de IC em CASHPAYMENT em até 10 minutos.
  const nowTs = now.getTime()
  const cashPaymentEvent = events.find((event) => {
    return (
      event.event_type === 'PURCHASE_BILLET_PRINTED' &&
      getEventPaymentType(event) === 'CASHPAYMENT' &&
      parseEventTime(event) <= nowTs - TEN_MINUTES_MS
    )
  })

  // Verifica se existe evento de checkout em até 10 minutos.
  const checkoutEvent = events.find((event) => {
    return event.event_type === 'checkout_start' && parseEventTime(event) <= nowTs - TEN_MINUTES_MS
  })

  // Verifica se existe qualquer evento de IC em CASHPAYMENT (independente de estar maduro ou não para disparo)
  // Isso evita que um checkout_no_purchase seja disparado se o lead já gerou um boleto/multibanco
  const hasAnyCashPayment = events.some((event) => {
    return (
      event.event_type === 'PURCHASE_BILLET_PRINTED' &&
      getEventPaymentType(event) === 'CASHPAYMENT'
    )
  })

  // Verifica se existe qualquer evento de checkout
  const hasAnyCheckout = events.some((event) => event.event_type === 'checkout_start')

  // Para no_checkout, só considera leads que passaram do pitch e viram a oferta.
  const noCheckoutBase = getFirstOfferRevealed(events)

  const noCheckoutDue = Boolean(
    !hasAnyCheckout &&
    !hasAnyCashPayment &&
    noCheckoutBase &&

    parseEventTime(noCheckoutBase) <= nowTs - TWENTY_FIVE_MINUTES_MS,
  )

  let candidate: RecoveryCandidate | undefined

  // define o tipo de mensagem com base em prioridade. Primeiro, boleto. Segundo, checkout. Terceiro, lead frio.
  if (cashPaymentEvent) {
    candidate = buildCandidateFromTrigger(
      context,
      'multibanco_reminder',
      cashPaymentEvent,
      TEN_MINUTES_MS,
      'cashpayment_due_after_10m',
    )
  } else if (checkoutEvent && !hasAnyCashPayment) {
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
      'no_checkout_due_after_25m_from_offer_revealed',
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

// Retorna os candidados 
export function buildRecoveryCandidates(
  contexts: RecoveryLeadContext[],
  now: Date = new Date(),
  options: { maxEligibleAgeMs?: number | null } = {},
): { candidates: RecoveryCandidate[]; skipped: RecoverySkippedLead[] } {
  // captura os candidatos
  const candidates: RecoveryCandidate[] = []
  // captura os candidatos pulados
  const skipped: RecoverySkippedLead[] = []
  
  // captura o tempo máximo de elegibilidade. 
  const maxEligibleAgeMs = normalizeMaxEligibleAgeMs(options.maxEligibleAgeMs)
  const nowTs = now.getTime()

  for (const context of contexts) {
    const evaluation = buildRecoveryCandidate(context, now)
    if (evaluation.candidate) {
      if (maxEligibleAgeMs !== null) {
        // retorna o tempo do evento + janela de tempo por tipo de disparo, ( 10 min, etc ). 
        const eligibleAtTs = new Date(evaluation.candidate.eligible_at).getTime()
        const eligibleAgeMs = nowTs - eligibleAtTs 
        // verifica se o candidato ficou elegível a MAIS tempo do que o tempo máximo de elegibilidade.
        if (Number.isFinite(eligibleAtTs) && eligibleAgeMs > maxEligibleAgeMs) {
          skipped.push({
            lead_id: evaluation.candidate.lead_id,
            funnel_id: evaluation.candidate.funnel_id,
            reason: 'eligible_window_expired',
          })
          continue
        }
      }
      // SE NAO foi pulado até aqui, adicionar na lista de candidatos.
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

function buildRecentLeadLowerBoundIso(now: Date, maxEligibleAgeMs: number | null): string {
  return new Date(now.getTime() - resolveRecentLeadLookbackMs(maxEligibleAgeMs)).toISOString()
}

async function fetchCompactLeadById(
  supabase: SupabaseClient,
  funnelId: string,
  leadId: string,
): Promise<CompactLeadRow[]> {
  const { data, error } = await supabase
    .from('vw_funnel_lead_compact')
    .select('funnel_id,lead_id,session_id,name,email,phone,age,gender,country,desire,has_purchase,last_event_at,perfil_image,auto_tag')
    .eq('funnel_id', funnelId)
    .eq('lead_id', leadId)

  if (error) {
    throw new Error(`Falha ao consultar vw_funnel_lead_compact por lead_id: ${error.message}`)
  }

  return (data || []).filter((row) => normalizeText(row.lead_id)) as CompactLeadRow[]
}

async function fetchCompactRowsRecentFirst(
  supabase: SupabaseClient,
  params: {
    funnelId: string
    fetchLeadCount: number
    now: Date
    maxEligibleAgeMs: number | null
  },
): Promise<CompactLeadRow[]> {
  const recentLowerBoundIso = buildRecentLeadLowerBoundIso(params.now, params.maxEligibleAgeMs)
  const backfillEnabled = String(process.env.RECOVERY_DISPATCH_BACKFILL_ENABLED || '').trim().toLowerCase() === 'true'

  const { data: recentRows, error: recentError } = await supabase
    .from('vw_funnel_lead_compact')
    .select('funnel_id,lead_id,session_id,name,email,phone,age,gender,country,desire,has_purchase,last_event_at,perfil_image,auto_tag')
    .eq('funnel_id', params.funnelId)
    .eq('has_purchase', false)
    .gte('last_event_at', recentLowerBoundIso)
    .order('last_event_at', { ascending: false })
    .limit(params.fetchLeadCount)

  if (recentError) {
    throw new Error(`Falha ao consultar lote recente de vw_funnel_lead_compact: ${recentError.message}`)
  }

  const deduped = new Map<string, CompactLeadRow>()
  for (const row of (recentRows || []) as CompactLeadRow[]) {
    if (!normalizeText(row.lead_id)) continue
    deduped.set(row.lead_id, row)
  }

  if (!backfillEnabled || deduped.size >= params.fetchLeadCount) {
    return [...deduped.values()]
  }

  const remaining = params.fetchLeadCount - deduped.size

  const { data: backfillRows, error: backfillError } = await supabase
    .from('vw_funnel_lead_compact')
    .select('funnel_id,lead_id,session_id,name,email,phone,age,gender,country,desire,has_purchase,last_event_at,perfil_image,auto_tag')
    .eq('funnel_id', params.funnelId)
    .eq('has_purchase', false)
    .lt('last_event_at', recentLowerBoundIso)
    .order('last_event_at', { ascending: true })
    .limit(remaining)

  if (backfillError) {
    throw new Error(`Falha ao consultar lote de backfill de vw_funnel_lead_compact: ${backfillError.message}`)
  }

  for (const row of (backfillRows || []) as CompactLeadRow[]) {
    if (!normalizeText(row.lead_id)) continue
    deduped.set(row.lead_id, row)
  }

  return [...deduped.values()]
}

async function fetchLeadContexts(
  supabase: SupabaseClient,
  params: {
    leadId?: string
    limit: number
    funnelId: string
    now: Date
    maxEligibleAgeMs: number | null
  },
): Promise<RecoveryLeadContext[]> {
  const fetchLeadCount = params.leadId ? 1 : Math.min(Math.max(params.limit * 5, params.limit), 250)
  const compactLeads = params.leadId
    ? await fetchCompactLeadById(supabase, params.funnelId, params.leadId)
    : await fetchCompactRowsRecentFirst(supabase, {
      funnelId: params.funnelId,
      fetchLeadCount,
      now: params.now,
      maxEligibleAgeMs: params.maxEligibleAgeMs,
    })

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

// Busca os dados do template de recuperação. Como país  template id, etc.
export async function fetchRecoveryTemplateLookup(
  supabase: SupabaseClient,
  candidate: RecoveryCandidate,
): Promise<RecoveryTemplateLookupResult | null> {
  const { data: routeRow, error: routeError } = await supabase
    .from('recovery_template_routes')
    .select('route_id, message_type, country, template_id, is_active, metadata')
    .eq('message_type', candidate.message_type)
    .eq('country', candidate.country)
    .eq('is_active', true)
    .maybeSingle()

  if (routeError) {
    throw new Error(`Falha ao consultar recovery_template_routes: ${routeError.message}`)
  }

  if (!routeRow) return null

  const route: RecoveryTemplateRoute = {
    route_id: (routeRow as RecoveryTemplateRouteRow).route_id,
    message_type: (routeRow as RecoveryTemplateRouteRow).message_type,
    country: normalizeCountry((routeRow as RecoveryTemplateRouteRow).country),
    template_id: (routeRow as RecoveryTemplateRouteRow).template_id,
    is_active: Boolean((routeRow as RecoveryTemplateRouteRow).is_active),
    metadata: toJsonRecord((routeRow as RecoveryTemplateRouteRow).metadata),
  }

  // Busca o template e os valores mapeados.
  const [{ data: templateRow, error: templateError }, { data: bindingRows, error: bindingError }] = await Promise.all([
    supabase
      .from('message_templates')
      .select('template_id, name, template_category, meta_template_id, meta_language, meta_payload, variable_definitions')
      .eq('template_id', route.template_id)
      .eq('channel', 'whatsapp')
      .maybeSingle(),
    supabase
      .from('recovery_template_bindings')
      .select('token, source_key, source_label, resolution_mode, value_map, fallback_value, required')
      .eq('route_id', route.route_id)
      .order('created_at', { ascending: true }),
  ])

  if (templateError) {
    throw new Error(`Falha ao consultar message_templates: ${templateError.message}`)
  }

  if (bindingError) {
    throw new Error(`Falha ao consultar recovery_template_bindings: ${bindingError.message}`)
  }

  if (!templateRow) return null

  return {
    route,
    template: normalizeMessageTemplate(templateRow as MessageTemplateRow),
    bindings: ((bindingRows ?? []) as RecoveryTemplateBindingRow[])
      .map((row) => normalizeTemplateBinding(row))
      .filter((row): row is RecoveryTemplateBinding => Boolean(row)),
  }
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

// Função que cria o payload enviado para o N8N, e executa o disparo.
export async function dispatchDueRecoveries(params: {

// Parâmetros de controle do disparo -- dry_run --> verifica se é teste, limit --> quantidade de leads processados
// leadId, FunnelId, id do lead, Funil, maxElegible --> tempo máximo para elegibilidade de disparo do lead. Supabase? --> Supabase do ambiente.
// now --> Momento atual, para simulações. sendToN8N --> Função que envia o payload para o N8N.
  dryRun?: boolean
  limit?: number
  leadId?: string
  funnelId?: string
  maxEligibleAgeMs?: number
  supabase?: SupabaseClient
  now?: Date
  // Função que envia o paylaod para o N8N
  sendToN8N?: (payload: RecoveryN8NPayload) => ReturnType<typeof sendRecoveryTemplateToN8N>
}): Promise<RecoveryDispatchSummary> {
  const dryRun = Boolean(params.dryRun)
  const limit = normalizeLimit(params.limit)
  const funnelId = normalizeText(params.funnelId) || DEFAULT_FUNNEL_ID
  const maxEligibleAgeMs = normalizeMaxEligibleAgeMs(
    params.maxEligibleAgeMs ?? process.env.RECOVERY_DISPATCH_MAX_ELIGIBLE_AGE_MS,
  )
  const supabase = params.supabase || getSupabaseAdmin()
  const now = params.now || new Date()
  const sendToN8N = params.sendToN8N || sendRecoveryTemplateToN8N

  // Busca pelo id e eventos do lead.
  const contexts = await fetchLeadContexts(supabase, {
    leadId: normalizeText(params.leadId) || undefined,
    limit,
    funnelId,
    now,
    maxEligibleAgeMs,
  })

  console.log('[RECOVERY] Context fetch summary', {
    funnel_id: funnelId,
    fetch_mode: params.leadId ? 'exact_lead' : 'recent_first',
    max_eligible_age_ms: maxEligibleAgeMs,
    recent_lookback_ms: params.leadId ? null : resolveRecentLeadLookbackMs(maxEligibleAgeMs),
    fetched_context_count: contexts.length,
  })

  const { candidates, skipped } = buildRecoveryCandidates(contexts, now, {
    maxEligibleAgeMs,
  })

  // Pega os candidatos dentro do limite selecionado de disparo
  const selectedCandidates = candidates.slice(0, limit)

  // Cria mapa de contexto por LEAD ID + Funnel ID.
  const contextByLeadKey = new Map(
    contexts.map((context) => [buildLeadContextKey(context.compact.funnel_id, context.compact.lead_id), context]),
  )

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

    // Se o idioma do lead não for identificado, não envia o disparo.
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

    // Cria o registro em whatsapp_recovery_dispatches, se não existir.
    const { dispatchId, alreadyDispatched } = await createPendingDispatch(supabase, candidate)

    // Se o registro já existir, não envia o disparo.
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

    // Se o dispatchId não for encontrado, não envia o disparo.
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

    // Se o lead tiver uma compra, não envia o disparo.
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

    // Pega o contexto do lead. Com base na leadKey mapeada anteriormente
    const context = contextByLeadKey.get(buildLeadContextKey(candidate.funnel_id, candidate.lead_id))
    if (!context) {
      await updateDispatchStatus(supabase, dispatchId, {
        n8n_status: 'failed',
        n8n_response: {
          reason: 'lead_context_not_found',
        },
      })

      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'failed',
        reason: 'lead_context_not_found',
        eligible_at: candidate.eligible_at,
        dispatch_id: dispatchId,
        n8n_status: 'failed',
      })
      continue
    }

    // Busca pelo template de recuperação, com base no tipo de mensagem e país.
    const templateLookup = await fetchRecoveryTemplateLookup(supabase, candidate)
    if (!templateLookup) {
      await updateDispatchStatus(supabase, dispatchId, {
        n8n_status: 'failed',
        n8n_response: {
          reason: 'missing_template_route',
          message_type: candidate.message_type,
          country: candidate.country,
        },
      })

      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'missing_template_route',
        reason: 'missing_template_route',
        eligible_at: candidate.eligible_at,
        dispatch_id: dispatchId,
        n8n_status: 'failed',
      })
      continue
    }

    // Constrói o payload do template.
    const payloadResult = buildRecoveryTemplatePayload({
      candidate,
      compactLead: context.compact,
      lookup: templateLookup,
    })

    if ('issues' in payloadResult) {
      const issues = payloadResult.issues

      await updateDispatchStatus(supabase, dispatchId, {
        n8n_status: 'failed',
        n8n_response: {
          reason: 'missing_required_template_variable',
          route_id: templateLookup.route.route_id,
          template_id: templateLookup.template.template_id,
          issues,
        },
      })

      results.push({
        lead_id: candidate.lead_id,
        funnel_id: candidate.funnel_id,
        message_type: candidate.message_type,
        status: 'missing_required_template_variable',
        reason: issues[0]?.message || 'missing_required_template_variable',
        eligible_at: candidate.eligible_at,
        dispatch_id: dispatchId,
        n8n_status: 'failed',
        response: issues,
      })
      continue
    }

    // Envia o payload para o N8N.
    const n8nResponse = await sendToN8N(payloadResult.payload)

    if (n8nResponse.ok) {
      await updateDispatchStatus(supabase, dispatchId, {
        n8n_status: 'sent',
        dispatched_at: new Date().toISOString(),
        n8n_response: {
          status: n8nResponse.status,
          data: n8nResponse.data,
          template_id: payloadResult.payload.metadata.template_id,
          template_variable_values: payloadResult.values,
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
