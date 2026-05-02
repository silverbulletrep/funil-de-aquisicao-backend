import axios from 'axios'
import dotenv from 'dotenv'
import type { RecoveryN8NPayload, RecoveryN8NSendResult } from './recoveryTypes.js'

dotenv.config()

const N8N_META_TEMPLATE_WEBHOOK_URL = process.env.N8N_META_TEMPLATE_WEBHOOK_URL || ''
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS) || 20000

export async function sendRecoveryTemplateToN8N(
  payload: RecoveryN8NPayload,
): Promise<RecoveryN8NSendResult> {
  if (!N8N_META_TEMPLATE_WEBHOOK_URL) {
    return {
      ok: false,
      status: null,
      data: null,
      error: 'N8N_META_TEMPLATE_WEBHOOK_URL não configurada',
    }
  }

  try {
    console.log('[RECOVERY_N8N] Enviando payload de recovery', {
      lead_id: payload.lead_id,
      message_type: payload.message_type,
      destination: payload.destination,
      country: payload.country,
      language: payload.language,
      template_id: payload.metadata.template_id,
      meta_template_id: payload.metadata.meta_template_id,
      variable_count: payload.metadata.template_variable_definitions.length,
    })

    const response = await axios.post(N8N_META_TEMPLATE_WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: N8N_TIMEOUT_MS,
      validateStatus: () => true,
    })

    if (response.status >= 200 && response.status < 300) {
      console.log('[RECOVERY_N8N] Payload enviado com sucesso', {
        lead_id: payload.lead_id,
        message_type: payload.message_type,
        status: response.status,
      })

      return {
        ok: true,
        status: response.status,
        data: response.data,
        error: null,
      }
    }

    console.error('[RECOVERY_N8N] Webhook retornou erro', {
      lead_id: payload.lead_id,
      message_type: payload.message_type,
      status: response.status,
      data: response.data,
    })

    return {
      ok: false,
      status: response.status,
      data: response.data,
      error: `N8N retornou status ${response.status}`,
    }
  } catch (error: unknown) {
    const err = error as { message?: string; response?: { status?: number; data?: unknown } }
    console.error('[RECOVERY_N8N] Falha ao enviar payload', {
      lead_id: payload.lead_id,
      message_type: payload.message_type,
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
    })

    return {
      ok: false,
      status: err.response?.status || null,
      data: err.response?.data || null,
      error: err.message || 'Falha ao enviar payload ao N8N',
    }
  }
}
