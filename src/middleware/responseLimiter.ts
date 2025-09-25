import { Request, Response, NextFunction } from 'express'

interface ResponseLimiterOptions {
  maxSize: number // bytes
  skipPaths?: string[]
  mobileMaxSize?: number
}

export function responseLimiter(options: ResponseLimiterOptions) {
  const { maxSize, skipPaths = [], mobileMaxSize } = options
  
  return (req: Request, res: Response, next: NextFunction) => {
    // Pular paths específicos (uploads, downloads, etc)
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next()
    }
    
    // Detectar dispositivo móvel
    const isMobile = /Mobile|Android|iPhone|iPad/i.test(req.headers['user-agent'] || '')
    const limit = isMobile && mobileMaxSize ? mobileMaxSize : maxSize
    
    // Interceptar res.json para verificar tamanho
    const originalJson = res.json.bind(res)
    res.json = function(body: any) {
      const jsonString = JSON.stringify(body)
      const size = Buffer.byteLength(jsonString, 'utf8')
      
      if (size > limit) {
        // Log para monitoramento
        console.warn(`[ResponseLimiter] Response too large: ${size} bytes (limit: ${limit})`, {
          path: req.path,
          isMobile,
          userAgent: req.headers['user-agent']
        })
        
        // Retornar erro apropriado
        return originalJson({
          error: 'response_too_large',
          message: `Response size (${Math.round(size/1024)}KB) exceeds limit (${Math.round(limit/1024)}KB)`,
          suggested_actions: [
            'Use pagination with smaller page size',
            'Apply filters to reduce data',
            'Use streaming endpoints for large datasets'
          ]
        })
      }
      
      // Response OK, seguir normal
      return originalJson(body)
    }
    
    next()
  }
}