import { Router, type Request, type Response } from 'express'
import dotenv from 'dotenv'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

dotenv.config()

const router = Router()

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

let supabase: SupabaseClient | null = null
try {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[LEADS] Configuração inválida de Supabase. Verifique SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.')
  } else {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  }
} catch (error: any) {
  console.error('[LEADS] Falha ao inicializar Supabase:', { message: error?.message, stack: error?.stack })
}

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'leads.create_or_update_by_whatsapp'
  const dados_entrada = {
    genero: (req as any)?.body?.genero,
    idade: (req as any)?.body?.idade,
    problema_principal: (req as any)?.body?.problema_principal,
    respostas_quiz: (req as any)?.body?.respostas_quiz || {},
    whatsapp: (req as any)?.body?.whatsapp,
    estado_lead: (req as any)?.body?.estado_lead || 'aguardando_recuperacao',
    etapa_funil: (req as any)?.body?.etapa_funil || 'resultado',
  }
  try {
    console.log(`[LEADS] Iniciando operação: ${operacao}`, { dados_entrada })
    if (!supabase) { res.status(500).json({ success: false, error: 'Supabase não configurado no backend' }); return }
    const whatsapp = String(dados_entrada.whatsapp || '').replace(/\D/g, '')
    if (!whatsapp) { res.status(400).json({ success: false, error: 'WhatsApp é obrigatório' }); return }
    const { data: found, error: findErr } = await (supabase as SupabaseClient)
      .from('leads_funnel')
      .select('id_lead')
      .eq('whatsapp', whatsapp)
      .order('data_criacao', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (findErr) { console.warn('[LEADS] Erro ao buscar lead existente por whatsapp', { message: findErr.message }) }
    const timestamps = { data_criacao: new Date().toISOString(), data_ultima_atualizacao: new Date().toISOString() }
    let result: any = null
    if (found?.id_lead) {
      const { data, error } = await (supabase as SupabaseClient)
        .from('leads_funnel')
        .update({
          genero: dados_entrada.genero,
          idade: dados_entrada.idade,
          problema_principal: dados_entrada.problema_principal,
          respostas_quiz: dados_entrada.respostas_quiz,
          whatsapp,
          estado_lead: dados_entrada.estado_lead,
          etapa_funil: dados_entrada.etapa_funil,
          data_ultima_atualizacao: timestamps.data_ultima_atualizacao,
        })
        .eq('id_lead', found.id_lead)
        .select()
        .single()
      if (error) { console.error('[LEADS] Erro ao atualizar lead existente', { error }); res.status(500).json({ success: false, error: (error as any).message }); return }
      result = data
    } else {
      const { data, error } = await (supabase as SupabaseClient)
        .from('leads_funnel')
        .insert({
          genero: dados_entrada.genero,
          idade: dados_entrada.idade,
          problema_principal: dados_entrada.problema_principal,
          respostas_quiz: dados_entrada.respostas_quiz,
          whatsapp,
          estado_lead: dados_entrada.estado_lead,
          etapa_funil: dados_entrada.etapa_funil,
          data_criacao: timestamps.data_criacao,
          data_ultima_atualizacao: timestamps.data_ultima_atualizacao,
        })
        .select()
        .single()
      if (error) { console.error('[LEADS] Erro ao inserir novo lead', { error }); res.status(500).json({ success: false, error: (error as any).message }); return }
      result = data
    }
    console.log('[LEADS] Operação concluída com sucesso', { id_resultado: (result as any)?.id_lead || (result as any)?.id || (result as any)?.uuid })
    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    console.error(`[LEADS] Erro na operação: ${operacao}`, { message: error?.message, stack: error?.stack })
    res.status(500).json({ success: false, error: error?.message || 'Falha ao criar/atualizar lead' })
  }
})

router.post('/purchase', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'leads.update_purchase'
  const dados_entrada = { id_lead: (req as any)?.body?.id_lead, whatsapp: (req as any)?.body?.whatsapp, dados_compra: (req as any)?.body?.dados_compra || {} }
  try {
    console.log(`[LEADS] Iniciando operação: ${operacao}`, { dados_entrada })
    if (!supabase) { res.status(500).json({ success: false, error: 'Supabase não configurado no backend' }); return }
    let id_lead = String(dados_entrada.id_lead || '').trim()
    if (!id_lead) {
      const whatsapp = String(dados_entrada.whatsapp || '').replace(/\D/g, '')
      if (!whatsapp) { res.status(400).json({ success: false, error: 'id_lead ou whatsapp é obrigatório' }); return }
      const { data: found, error: findErr } = await (supabase as SupabaseClient)
        .from('leads_funnel')
        .select('id_lead')
        .eq('whatsapp', whatsapp)
        .order('data_criacao', { ascending: false })
        .limit(1)
        .single()
      if (findErr) { res.status(500).json({ success: false, error: (findErr as any).message }); return }
      if (!(found as any)?.id_lead) { res.status(404).json({ success: false, error: 'Lead não encontrado para atualizar compra' }); return }
      id_lead = (found as any).id_lead
    }
    const email_compra = (typeof (dados_entrada as any)?.dados_compra?.email === 'string') ? (dados_entrada as any).dados_compra.email : null
    const { error } = await (supabase as SupabaseClient)
      .from('leads_funnel')
      .update({ estado_lead: 'compra_concluida', dados_compra: dados_entrada.dados_compra, email: email_compra, data_conversao: new Date().toISOString(), data_ultima_atualizacao: new Date().toISOString() })
      .eq('id_lead', id_lead)
    if (error) { console.error('[LEADS] Erro ao atualizar compra', { error }); res.status(500).json({ success: false, error: (error as any).message }); return }
    console.log('[LEADS] Compra registrada com sucesso', { id_lead })
    res.status(200).json({ success: true, id_lead })
  } catch (error: any) {
    console.error(`[LEADS] Erro na operação: ${operacao}`, { message: error?.message, stack: error?.stack })
    res.status(500).json({ success: false, error: error?.message || 'Falha ao atualizar compra' })
  }
})

export default router
