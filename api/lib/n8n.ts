import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n-n8n.6jcwzd.easypanel.host/webhook/producao'
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS) || 20000

export interface N8NPurchasePayload {
  email: string
  lead_id?: string
  journey_type: 'front' | 'upsell' | 'recovery'
  gross_revenue: number
  currency: string
  provider: 'stripe' | 'paypal'
  product_id: 'elevate_front' | 'elevate_up01'
  checkout_origin: string
}

/**
 * Envia o evento de compra enriquecido para o webhook do N8N.
 * @param payload Objeto contendo os dados da compra e do cliente
 * @returns true se sucesso, false caso contrário
 */
export async function sendPurchaseToN8N(payload: N8NPurchasePayload): Promise<boolean> {
    try {
        console.log('[N8N] Enviando webhook enriquecido...', {
            url: N8N_WEBHOOK_URL,
            payload
        })

        const response = await axios.post(
            N8N_WEBHOOK_URL,
            payload,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: N8N_TIMEOUT_MS
            }
        )

        console.log('[N8N] Webhook enviado com sucesso', {
            status: response.status,
            data: response.data
        })
        return true
    } catch (error: unknown) {
        const e = error as { message?: string, response?: { status?: number, data?: unknown } }
        console.error('[N8N] Erro ao enviar webhook', {
            message: e.message,
            status: e.response?.status,
            data: e.response?.data
        })
        return false
    }
}
