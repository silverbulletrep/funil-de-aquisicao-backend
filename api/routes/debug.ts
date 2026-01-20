import { Router, type Request, type Response } from 'express'
import { sendEventViaPhp } from '../lib/phpCapi.js'

const router = Router()

router.post('/simulate-conversion', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'debug.simulate_conversion_php'
  const dados_entrada = { ...req.body }
  try {
    console.log(`[DEBUG] Iniciando operação via PHP: ${operacao}`, { dados_entrada })

    // Usar bridge centralizada com validação de ambiente e caminho
    const result = await sendEventViaPhp(req.body, 'simulate-conversion.php')
    
    console.log('[DEBUG] Resultado PHP:', result)
    res.status(200).json(result)

  } catch (err: unknown) {
    const error = err as Error & { stack?: string }
    console.error(`[DEBUG] Erro na operação: ${operacao}: ${error.message}`, {
      dados_entrada,
      stack: error.stack,
    })
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
