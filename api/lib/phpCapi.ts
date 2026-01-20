import { exec } from 'child_process'
import path from 'path'
import fs from 'fs'

interface PhpCapiPayload {
  email?: string
  fbp?: string
  fbc?: string
  user_agent?: string
  ip_address?: string
  event_source_url?: string
  event_id?: string
  currency?: string
  value?: number
  test_event_code?: string
}

export async function sendEventViaPhp(payload: PhpCapiPayload, scriptName: string = 'send-event.php'): Promise<any> {
  return new Promise((resolve, reject) => {
    // Estratégia de resolução de caminho baseada na estrutura de pastas (public_html)
    // A pasta meta-capi-php pode estar na raiz, ou irmã da pasta atual
    
    const candidates = [
      path.join(process.cwd(), 'meta-capi-php', scriptName),           // ./meta-capi-php
      path.join(process.cwd(), '..', 'meta-capi-php', scriptName),     // ../meta-capi-php (caso rode em /app)
      path.join(process.cwd(), '..', '..', 'meta-capi-php', scriptName) // ../../meta-capi-php
    ]

    let scriptPath = ''
    
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        scriptPath = candidate
        break
      }
    }

    // Se não encontrou em nenhum lugar, falha com erro descritivo
    if (!scriptPath) {
      console.error('[PHP-CAPI] Script não encontrado. Tentativas:', candidates)
      reject(new Error(`PHP script '${scriptName}' not found in expected locations. Checked: ${candidates.map(p => path.basename(path.dirname(p))).join(', ')}`))
      return
    }

    // Verificar se o PHP está instalado (check simples)
    exec('php -v', (vError) => {
      if (vError) {
        console.error('[PHP-CAPI] CRÍTICO: PHP não encontrado no PATH do sistema.')
        reject(new Error('PHP binary not found. Please install PHP to use CAPI features.'))
        return
      }

      const inputData = JSON.stringify(payload)
      const command = `php "${scriptPath}"`
      
      console.log(`[PHP-CAPI] Executando: ${command}`)

      const child = exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error(`[PHP-CAPI] Execution error: ${error.message}`, { stderr, stdout })
          // Não rejeitar imediatamente se houver stdout (pode ser warning + sucesso)
          if (!stdout) {
             reject(new Error(`PHP Execution failed: ${error.message} \nStderr: ${stderr}`))
             return
          }
        }

        try {
          // Tentar parsear o JSON, ignorando warnings do PHP que possam vir antes do JSON
          const firstBrace = stdout.indexOf('{')
          const lastBrace = stdout.lastIndexOf('}')
          
          if (firstBrace === -1 || lastBrace === -1) {
            throw new Error('No JSON found in PHP output')
          }

          const jsonStr = stdout.substring(firstBrace, lastBrace + 1)
          const result = JSON.parse(jsonStr)
          resolve(result)
        } catch (parseError) {
          console.error('[PHP-CAPI] Parse error', { stdout, stderr })
          reject(new Error('Failed to parse PHP response: ' + stdout))
        }
      })

      if (child.stdin) {
        child.stdin.write(inputData)
        child.stdin.end()
      }
    })
  })
}
