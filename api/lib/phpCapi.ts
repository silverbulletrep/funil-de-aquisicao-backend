import { exec } from 'child_process'
import path from 'path'

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

export async function sendEventViaPhp(payload: PhpCapiPayload): Promise<any> {
  return new Promise((resolve, reject) => {
    const phpScript = path.join(process.cwd(), 'meta-capi-php', 'send-event.php')
    const inputData = JSON.stringify(payload)

    const child = exec(`php "${phpScript}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`[PHP-CAPI] Execution error: ${error.message}`, { stderr })
        // Não rejeitar imediatamente, tentar ver se saiu algo no stdout (as vezes warnings saem no stderr)
      }

      try {
        // Tentar parsear o JSON, ignorando warnings do PHP que possam vir antes do JSON
        // Encontra o primeiro '{' e o último '}'
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
}
