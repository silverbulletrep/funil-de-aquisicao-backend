/**
 * Resolves recovery template bindings into final template variable values and
 * produces the enriched payload expected by the N8N Meta template webhook.
 */
import {
  getRecoveryTemplateSourceLabel,
  readRecoveryTemplateSourceValue,
} from './recoveryTemplateCatalog.js'
import type {
  CompactLeadRow,
  RecoveryCandidate,
  RecoveryMessageTemplate,
  RecoveryN8NPayload,
  RecoveryTemplateBinding,
  RecoveryTemplateLookupResult,
  RecoveryTemplateVariableDefinition,
} from './recoveryTypes.js'

export interface RecoveryTemplateResolutionIssue {
  token: string
  required: boolean
  source_key?: RecoveryTemplateBinding['source_key']
  reason: 'missing_binding' | 'missing_required_value'
  message: string
}

export interface RecoveryTemplateValuesResolution {
  values: Record<string, string>
  issues: RecoveryTemplateResolutionIssue[]
}

type RecoveryTemplatePayloadResult =
  | {
    ok: true
    payload: RecoveryN8NPayload
    values: Record<string, string>
  }
  | {
    ok: false
    issues: RecoveryTemplateResolutionIssue[]
  }

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeNameForPassThrough(value: string): string {
  const firstToken = value.trim().split(/\s+/).find(Boolean) ?? ''
  if (!firstToken) return ''

  const lower = firstToken.toLocaleLowerCase()
  return `${lower.charAt(0).toLocaleUpperCase()}${lower.slice(1)}`
}

function normalizeValueMap(valueMap: Record<string, string>): Record<string, string> {
  return Object.entries(valueMap).reduce<Record<string, string>>((acc, [rawValue, mappedValue]) => {
    const normalizedKey = rawValue.trim()
    const normalizedValue = mappedValue.trim()

    if (!normalizedKey || !normalizedValue) return acc

    acc[normalizedKey] = normalizedValue
    return acc
  }, {})
}

function resolveBindingValue(
  lead: CompactLeadRow,
  binding: RecoveryTemplateBinding,
): string | null {
  const rawValue = readRecoveryTemplateSourceValue(lead, binding.source_key)
  const fallbackValue = normalizeText(binding.fallback_value)

  if (binding.resolution_mode === 'mapped_value') {
    const normalizedRawValue = normalizeText(rawValue)
    if (!normalizedRawValue) return fallbackValue || null

    const mappedValue = normalizeValueMap(binding.value_map)[normalizedRawValue]
    return mappedValue ?? (fallbackValue || null)
  }

  if (!rawValue) return fallbackValue || null

  if (binding.source_key === 'name') {
    const normalizedName = normalizeNameForPassThrough(rawValue)
    return normalizedName || fallbackValue || null
  }

  return rawValue
}

export function resolveRecoveryTemplateValues(
  lead: CompactLeadRow,
  definitions: RecoveryTemplateVariableDefinition[],
  bindings: RecoveryTemplateBinding[],
): RecoveryTemplateValuesResolution {
  const values: Record<string, string> = {}
  const issues: RecoveryTemplateResolutionIssue[] = []
  const bindingsByToken = new Map(bindings.map((binding) => [binding.token, binding]))

  for (const definition of [...definitions].sort((left, right) => left.index - right.index)) {
    const binding = bindingsByToken.get(definition.token)
    const label = definition.label || definition.token

    if (!binding) {
      if (definition.required) {
        issues.push({
          token: definition.token,
          required: true,
          reason: 'missing_binding',
          message: `Binding ausente para ${label}.`,
        })
      } else {
        values[definition.token] = ''
      }
      continue
    }

    const required = binding.required
    const resolvedValue = resolveBindingValue(lead, binding)

    if (!resolvedValue) {
      if (required) {
        issues.push({
          token: definition.token,
          required,
          source_key: binding.source_key,
          reason: 'missing_required_value',
          message: `Variavel obrigatoria ${label} ficou sem valor final para ${getRecoveryTemplateSourceLabel(binding.source_key)}.`,
        })
      } else {
        values[definition.token] = ''
      }
      continue
    }

    values[definition.token] = resolvedValue
  }

  return { values, issues }
}

export function buildRecoveryTemplatePayload(args: {
  candidate: RecoveryCandidate
  compactLead: CompactLeadRow
  lookup: RecoveryTemplateLookupResult
}): RecoveryTemplatePayloadResult {
  const { candidate, compactLead, lookup } = args
  const { values, issues } = resolveRecoveryTemplateValues(
    compactLead,
    lookup.template.variable_definitions,
    lookup.bindings,
  )

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    }
  }

  return {
    ok: true,
    values,
    payload: {
      lead_id: candidate.lead_id,
      message_type: candidate.message_type,
      destination: candidate.phone,
      phone: candidate.phone,
      country: candidate.country,
      language: candidate.language,
      email: candidate.email,
      name: candidate.name,
      funnel_id: candidate.funnel_id,
      trigger: candidate.trigger,
      metadata: {
        template_id: lookup.template.template_id,
        meta_template_id: lookup.template.meta_template_id,
        template_name: lookup.template.name,
        template_category: lookup.template.template_category,
        meta_language: lookup.template.meta_language,
        meta_payload: lookup.template.meta_payload,
        template_variable_definitions: lookup.template.variable_definitions,
        template_variable_values: values,
      },
    },
  }
}
