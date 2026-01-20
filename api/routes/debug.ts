import { Router, type Request, type Response } from 'express'
import { exec } from 'child_process'
import path from 'path'

const router = Router()

router.post('/simulate-conversion', async (req: Request, res: Response): Promise<void> => {
  const operacao = 'debug.simulate_conversion_php'
  const dados_entrada = { ...req.body }
  try {
    console.log(`[DEBUG] Iniciando operação via PHP: ${operacao}`, { dados_entrada })

    const phpScript = path.join(process.cwd(), 'meta-capi-php', 'simulate-conversion.php')
    
    // Preparar dados para o script PHP
    const inputData = JSON.stringify(req.body)

    // Executar script PHP
    const child = exec(`php "${phpScript}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`[DEBUG] Erro ao executar PHP: ${error.message}`, { stderr })
        res.status(500).json({ success: false, error: 'Falha na execução do backend PHP', details: stderr })
        return
      }

      try {
        const result = JSON.parse(stdout)
        console.log('[DEBUG] Resultado PHP:', result)
        res.status(200).json(result)
      } catch (parseError) {
        console.error('[DEBUG] Erro ao parsear resposta do PHP', { stdout })
        res.status(500).json({ success: false, error: 'Resposta inválida do backend PHP', raw_output: stdout })
      }
    })

    // Enviar JSON para o stdin do processo PHP
    if (child.stdin) {
      child.stdin.write(inputData)
      child.stdin.end()
    }

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
