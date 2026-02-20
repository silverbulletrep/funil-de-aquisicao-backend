import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n-n8n.6jcwzd.easypanel.host/webhook/producao'
const N8N_TIMEOUT_MS = Number(process.env.N8N_TIMEOUT_MS) || 20000

/**
 * Envia o email de compra para o webhook do N8N.
 * @param email Email do cliente
 * @returns true se sucesso, false caso contrário
 */
export async function sendPurchaseToN8N(email: string): Promise<boolean> {
    try {
        // Payload simples conforme solicitado pelo usuário: { email }
        const payload = { email }

        console.log('[N8N] Enviando webhook...', {
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
