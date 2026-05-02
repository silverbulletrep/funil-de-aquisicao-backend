export const RECOVERY_MESSAGE_TYPES = [
  'multibanco_reminder',
  'checkout_no_purchase',
  'no_checkout',
] as const

export type RecoveryMessageType = typeof RECOVERY_MESSAGE_TYPES[number]

export const RECOVERY_TEMPLATE_SOURCE_KEYS = [
  'name',
  'email',
  'phone',
  'age',
  'gender',
  'country',
  'auto_tag',
  'desire.question',
  'desire.response[0]',
  'desire.response[1]',
] as const

export type RecoveryTemplateSourceKey = typeof RECOVERY_TEMPLATE_SOURCE_KEYS[number]
export type RecoveryTemplateResolutionMode = 'pass_through' | 'mapped_value'

export type RecoveryDispatchStatus =
  | 'dry_run'
  | 'sent'
  | 'failed'
  | 'skipped_purchase_found'
  | 'already_dispatched'
  | 'unknown_language'
  | 'ineligible_missing_phone'
  | 'not_due'
  | 'missing_template_route'
  | 'missing_template_config'
  | 'missing_required_template_variable'

export interface RecoveryDispatchTrigger {
  event_id: string | null
  event_type: string
  event_timestamp: string
  payment_type: string | null
  step_id?: string | null
  page_path?: string | null
}

export interface RecoveryTemplateVariableDefinition {
  token: string
  index: number
  label: string
  example?: string
  required: boolean
}

export interface RecoveryTemplateBinding {
  token: string
  source_key: RecoveryTemplateSourceKey
  source_label: string
  resolution_mode: RecoveryTemplateResolutionMode
  value_map: Record<string, string>
  fallback_value: string | null
  required: boolean
}

export interface RecoveryTemplateRoute {
  route_id: string
  message_type: RecoveryMessageType
  country: string
  template_id: string
  is_active: boolean
  metadata: Record<string, unknown> | null
}

export interface RecoveryMessageTemplate {
  template_id: string
  name: string | null
  template_category: 'inicializacao' | 'conversa' | null
  meta_template_id: string | null
  meta_language: string | null
  meta_payload: Record<string, unknown> | null
  variable_definitions: RecoveryTemplateVariableDefinition[]
}

export interface RecoveryTemplateLookupResult {
  route: RecoveryTemplateRoute
  template: RecoveryMessageTemplate
  bindings: RecoveryTemplateBinding[]
}

export interface RecoveryCandidate {
  lead_id: string
  funnel_id: string
  message_type: RecoveryMessageType
  country: string
  language: 'pt' | 'de' | 'unknown'
  phone: string
  email: string | null
  name: string | null
  eligible_at: string
  reason: string
  source_country: 'view' | 'metadata' | 'page_path' | 'unknown'
  trigger: RecoveryDispatchTrigger
}

export interface RecoveryDispatchResult {
  lead_id: string
  funnel_id: string
  message_type: RecoveryMessageType
  status: RecoveryDispatchStatus
  reason: string
  dispatch_id?: string | null
  eligible_at?: string
  n8n_status?: 'pending' | 'sent' | 'failed' | 'skipped_purchase_found' | null
  response?: unknown
}

export interface RecoverySkippedLead {
  lead_id: string
  funnel_id: string
  reason: string
}

export interface RecoveryN8NPayload {
  lead_id: string
  message_type: RecoveryMessageType
  destination: string
  country: string
  language: 'pt' | 'de' | 'unknown'
  phone: string
  email: string | null
  name: string | null
  funnel_id: string
  trigger: RecoveryDispatchTrigger
  metadata: {
    template_id: string
    meta_template_id: string | null
    template_name: string | null
    template_category: 'inicializacao' | 'conversa' | null
    meta_language: string | null
    meta_payload: Record<string, unknown> | null
    template_variable_definitions: RecoveryTemplateVariableDefinition[]
    template_variable_values: Record<string, string>
  }
}

export interface RecoveryN8NSendResult {
  ok: boolean
  status: number | null
  data: unknown
  error: string | null
}

export interface RecoveryDispatchSummary {
  dry_run: boolean
  candidate_count: number
  candidates: RecoveryCandidate[]
  skipped: RecoverySkippedLead[]
  results: RecoveryDispatchResult[]
}

export interface CompactLeadRow {
  funnel_id: string
  lead_id: string
  session_id?: string | null
  name?: string | null
  email?: string | null
  phone?: string | null
  age?: string | number | null
  gender?: string | null
  country?: string | null
  desire?: Record<string, unknown> | null
  has_purchase?: boolean | null
  last_event_at?: string | null
  perfil_image?: string | null
  auto_tag?: string | null
}

export interface FunnelLeadRow {
  funnel_id: string
  lead_id: string
  attributes?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

export interface FunnelEventRow {
  event_id?: string | null
  funnel_id: string
  lead_id: string
  event_type: string
  event_timestamp: string
  received_at?: string | null
  step_id?: string | null
  page_path?: string | null
  attributes?: Record<string, unknown> | null
  purchase?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

export interface RecoveryLeadContext {
  compact: CompactLeadRow
  funnelLead: FunnelLeadRow | null
  events: FunnelEventRow[]
}
