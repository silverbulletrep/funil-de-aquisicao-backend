/**
 * Leads route: insere/atualiza dados do funil no Supabase via backend
 * Mantém as chaves seguras no servidor (não expõe no frontend).
 */
import { Router, type Request, type Response } from 'express'
import dotenv from 'dotenv'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// garantir env carregado
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
} catch (err: unknown) {
  const error = err as Error & { stack?: string }
  console.error('[LEADS] Falha ao inicializar Supabase:', { message: error.message, stack: error.stack })
}

/**
 * POST /api/leads
 * Insere ou atualiza (por whatsapp) um lead no funil.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'leads.create_or_update_by_whatsapp'
  const dados_entrada = {
    genero: req.body?.genero,
    idade: req.body?.idade,
    problema_principal: req.body?.problema_principal,
    respostas_quiz: req.body?.respostas_quiz || {},
    whatsapp: req.body?.whatsapp,
    estado_lead: req.body?.estado_lead || 'aguardando_recuperacao',
    etapa_funil: req.body?.etapa_funil || 'resultado',
  }

  try {
    console.log(`[LEADS] Iniciando operação: ${operacao}`, { dados_entrada })

    if (!supabase) {
      res.status(500).json({ success: false, error: 'Supabase não configurado no backend' })
      return
    }

    const whatsapp = String(dados_entrada.whatsapp || '').replace(/\D/g, '')
    if (!whatsapp) {
      res.status(400).json({ success: false, error: 'WhatsApp é obrigatório' })
      return
    }

    // Tenta localizar lead existente pelo whatsapp (evita duplicidade)
    const { data: found, error: findErr } = await supabase
      .from('leads_funnel')
      .select('id_lead')
      .eq('whatsapp', whatsapp)
      .order('data_criacao', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (findErr) {
      console.warn('[LEADS] Erro ao buscar lead existente por whatsapp', { message: findErr.message })
    }

    const timestamps = {
      data_criacao: new Date().toISOString(),
      data_ultima_atualizacao: new Date().toISOString(),
    }

    let result: { id_lead?: string; id?: string; uuid?: string } | null = null
    if (found?.id_lead) {
      // Atualiza registro existente
      const { data, error } = await supabase
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

      if (error) {
        console.error('[LEADS] Erro ao atualizar lead existente', { error })
        res.status(500).json({ success: false, error: error.message })
        return
      }
      result = data
    } else {
      // Insere novo registro
      const { data, error } = await supabase
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

      if (error) {
        console.error('[LEADS] Erro ao inserir novo lead', { error })
        res.status(500).json({ success: false, error: error.message })
        return
      }
      result = data
    }

    console.log('[LEADS] Operação concluída com sucesso', {
      id_resultado: result?.id_lead || result?.id || result?.uuid,
    })

    res.status(200).json({ success: true, data: result })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[LEADS] Erro na operação: ${operacao}`, { message: error.message, stack: error.stack })
    res.status(500).json({ success: false, error: error.message || 'Falha ao criar/atualizar lead' })
  }
})

/**
 * POST /api/leads/purchase
 * Atualiza compra de um lead (marca conversão)
 */
  router.post('/purchase', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'leads.update_purchase'
  const dados_entrada = {
    id_lead: req.body?.id_lead,
    whatsapp: req.body?.whatsapp,
    dados_compra: req.body?.dados_compra || {},
  }

  try {
    console.log(`[LEADS] Iniciando operação: ${operacao}`, { dados_entrada })

    if (!supabase) {
      res.status(500).json({ success: false, error: 'Supabase não configurado no backend' })
      return
    }

    let id_lead = String(dados_entrada.id_lead || '').trim()

    if (!id_lead) {
      const whatsapp = String(dados_entrada.whatsapp || '').replace(/\D/g, '')
      if (!whatsapp) {
        res.status(400).json({ success: false, error: 'id_lead ou whatsapp é obrigatório' })
        return
      }
      const { data: found, error: findErr } = await supabase
        .from('leads_funnel')
        .select('id_lead')
        .eq('whatsapp', whatsapp)
        .order('data_criacao', { ascending: false })
        .limit(1)
        .single()
      if (findErr) {
        res.status(500).json({ success: false, error: findErr.message })
        return
      }
      if (!found?.id_lead) {
        res.status(404).json({ success: false, error: 'Lead não encontrado para atualizar compra' })
        return
      }
      id_lead = found.id_lead
    }

    const email_compra = (typeof dados_entrada.dados_compra?.email === 'string')
      ? dados_entrada.dados_compra.email
      : null

    const { error } = await supabase
      .from('leads_funnel')
      .update({
        estado_lead: 'compra_concluida',
        dados_compra: dados_entrada.dados_compra,
        email: email_compra, // Salva o email extraído
        data_conversao: new Date().toISOString(),
        data_ultima_atualizacao: new Date().toISOString(),
      })
      .eq('id_lead', id_lead)

    if (error) {
      console.error('[LEADS] Erro ao atualizar compra', { error })
      res.status(500).json({ success: false, error: error.message })
      return
    }

    console.log('[LEADS] Compra registrada com sucesso', { id_lead })
    res.status(200).json({ success: true, id_lead })
  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[LEADS] Erro na operação: ${operacao}`, { message: error.message, stack: error.stack })
    res.status(500).json({ success: false, error: error.message || 'Falha ao atualizar compra' })
  }
})

export default router
