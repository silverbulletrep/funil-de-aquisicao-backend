import dotenv from 'dotenv'

dotenv.config()

const META_ENDPOINT = 'https://fundaris.space/meta-capi-php/events.php'

export type MetaCapiPayload = {
  event_name: 'Purchase'
  event_id: string
  event_time: number
  event_source_url: string
  action_source?: 'website'
  fbp?: string | null
  fbc?: string | null
  user_agent?: string | null
  ip_address?: string | null
  custom_data?: { currency?: string; value?: number }
  test_event_code?: string
}

export async function checkMetaEndpointHealth(): Promise<{ ok: boolean; status?: number; error?: string }>
{
  const operacao = 'meta_capi.health'
  const dados_entrada = { endpoint: META_ENDPOINT }
  try {
    console.log(`[CAPI] Iniciando operação: ${operacao}`, { dados_entrada })
    const healthUrl = `${META_ENDPOINT}?health=1`
    const res = await fetch(healthUrl, { method: 'GET' })
    const ok = res.ok
    console.log('[CAPI] Operação concluída com sucesso:', {
      id_resultado: ok,
      status: res.status,
      timestamp: new Date().toISOString(),
    })
    return { ok, status: res.status }
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[CAPI] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    return { ok: false, error: error.message || 'GET health falhou' }
  }
}

export async function sendMetaPurchaseEvent(payload: MetaCapiPayload): Promise<{ success: boolean; status?: number; error?: string }>
{
  const operacao = 'meta_capi.send_purchase'
  const dados_entrada = { event_id: payload.event_id, event_time: payload.event_time, event_source_url: payload.event_source_url }
  try {
    console.log(`[CAPI] Iniciando operação: ${operacao}`, { dados_entrada })
    const health = await checkMetaEndpointHealth()
    if (!health.ok) {
      console.warn('[CAPI] Endpoint health falhou, continuando com tentativa de POST', health)
    }
    const body = JSON.stringify(payload)
    const res = await fetch(META_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const ok = res.ok
    console.log('[CAPI] Operação concluída com sucesso:', {
      id_resultado: ok,
      status: res.status,
      timestamp: new Date().toISOString(),
    })
    if (!ok) {
      const text = await res.text().catch(() => '')
      return { success: false, status: res.status, error: text || `POST falhou (${res.status})` }
    }
    return { success: true, status: res.status }
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[CAPI] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    })
    return { success: false, error: error.message || 'Falha na chamada ao endpoint' }
  }
}

export function buildMetaPurchasePayload(params: {
  event_id: string
  event_time: number | Date
  event_source_url: string
  action_source?: 'website'
  fbp?: string | null
  fbc?: string | null
  user_agent?: string | null
  ip_address?: string | null
  currency?: string
  value?: number | string | null
  test_event_code?: string
}): MetaCapiPayload
{
  const event_time = typeof params.event_time === 'number' ? params.event_time : Math.floor(new Date(params.event_time).getTime() / 1000)
  let valueNum: number | undefined
  if (typeof params.value === 'number' && Number.isFinite(params.value)) {
    valueNum = params.value
  } else if (typeof params.value === 'string') {
    const v = Number(params.value)
    valueNum = Number.isFinite(v) ? v : undefined
  }
  const payload: MetaCapiPayload = {
    event_name: 'Purchase',
    event_id: params.event_id,
    event_time,
    event_source_url: normalizeUrl(params.event_source_url),
    action_source: 'website',
    fbp: params.fbp || null,
    fbc: params.fbc || null,
    user_agent: params.user_agent || null,
    ip_address: params.ip_address || null,
    custom_data: { currency: normalizeCurrency(params.currency), value: valueNum },
  }
  if (params.test_event_code) payload.test_event_code = params.test_event_code
  return payload
}

export function normalizeUrl(url: string | null | undefined): string
{
  const s = String(url || '')
  if (!s) return ''
  return s.replace(/\/$/, '')
}

export function normalizeCurrency(cur: string | null | undefined): string | undefined
{
  const s = String(cur || '').trim().toUpperCase()
  if (!s) return undefined
  return s
}
