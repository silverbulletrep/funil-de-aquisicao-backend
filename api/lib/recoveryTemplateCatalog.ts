/**
 * Defines the fixed recovery template source-key catalog and resolves raw values
 * from vw_funnel_lead_compact, including supported desire subpaths.
 */
import type { CompactLeadRow, RecoveryTemplateSourceKey } from './recoveryTypes.js'

type JsonRecord = Record<string, unknown>

export interface RecoveryTemplateSourceDefinition {
  key: RecoveryTemplateSourceKey
  label: string
}

export const RECOVERY_TEMPLATE_SOURCE_CATALOG: RecoveryTemplateSourceDefinition[] = [
  { key: 'name', label: 'Nome completo' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefone' },
  { key: 'age', label: 'Idade' },
  { key: 'gender', label: 'Genero' },
  { key: 'country', label: 'Pais' },
  { key: 'auto_tag', label: 'Auto tag atual' },
  { key: 'desire.question', label: 'Pergunta do desejo' },
  { key: 'desire.response[0]', label: 'Primeiro desejo' },
  { key: 'desire.response[1]', label: 'Segundo desejo' },
]

const sourceLabels = new Map(
  RECOVERY_TEMPLATE_SOURCE_CATALOG.map((entry) => [entry.key, entry.label]),
)

function normalizeText(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized ? normalized : null
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return null
}

function toJsonRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

function getDesireResponseValues(lead: CompactLeadRow): string[] {
  const desire = toJsonRecord(lead.desire)
  const rawResponse = desire?.response

  if (Array.isArray(rawResponse)) {
    return rawResponse
      .map((entry) => normalizeText(entry))
      .filter((entry): entry is string => Boolean(entry))
  }

  const singleValue = normalizeText(rawResponse)
  return singleValue ? [singleValue] : []
}

export function isRecoveryTemplateSourceKey(value: string): value is RecoveryTemplateSourceKey {
  return RECOVERY_TEMPLATE_SOURCE_CATALOG.some((entry) => entry.key === value)
}

export function getRecoveryTemplateSourceLabel(sourceKey: RecoveryTemplateSourceKey): string {
  return sourceLabels.get(sourceKey) ?? sourceKey
}

export function readRecoveryTemplateSourceValue(
  lead: CompactLeadRow,
  sourceKey: RecoveryTemplateSourceKey,
): string | null {
  switch (sourceKey) {
    case 'name':
      return normalizeText(lead.name)
    case 'email':
      return normalizeText(lead.email)
    case 'phone':
      return normalizeText(lead.phone)
    case 'age':
      return normalizeText(lead.age)
    case 'gender':
      return normalizeText(lead.gender)
    case 'country':
      return normalizeText(lead.country)
    case 'auto_tag':
      return normalizeText(lead.auto_tag)
    case 'desire.question':
      return normalizeText(toJsonRecord(lead.desire)?.question)
    case 'desire.response[0]':
      return getDesireResponseValues(lead)[0] ?? null
    case 'desire.response[1]':
      return getDesireResponseValues(lead)[1] ?? null
    default:
      return null
  }
}
