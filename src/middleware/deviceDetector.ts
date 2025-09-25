import { Request, Response, NextFunction } from 'express'

export interface DeviceContext {
  isMobile: boolean
  isTablet: boolean
  isSlowConnection: boolean
  connectionType: 'slow' | 'medium' | 'fast'
  capabilities: {
    supportsWebP: boolean
    supportsModernJS: boolean
    prefersReducedData: boolean
  }
}

// Extender Request para incluir contexto
declare global {
  namespace Express {
    interface Request {
      deviceContext?: DeviceContext
    }
  }
}

export function deviceDetector(req: Request, res: Response, next: NextFunction) {
  const userAgent = req.headers['user-agent'] || ''
  const acceptEncoding = req.headers['accept-encoding'] || ''
  const connection = req.headers.connection || ''
  const saveData = req.headers['save-data']
  
  // Detectar tipo de dispositivo
  const isMobile = /Mobile|Android|iPhone|iPod|BlackBerry|Opera Mini/i.test(userAgent)
  const isTablet = /iPad|Android.*Tablet|Kindle|Silk/i.test(userAgent) && !isMobile
  
  // Detectar conexão lenta
  const isSlowConnection = 
    saveData === 'on' ||
    connection === 'close' ||
    /2G|3G|slow/i.test(req.headers['downlink'] as string || '') ||
    parseInt(req.headers['rtt'] as string || '0') > 300
  
  // Determinar tipo de conexão
  let connectionType: 'slow' | 'medium' | 'fast' = 'medium'
  const rtt = parseInt(req.headers['rtt'] as string || '0')
  const downlink = parseFloat(req.headers['downlink'] as string || '0')
  
  if (isSlowConnection || rtt > 500 || downlink < 1) {
    connectionType = 'slow'
  } else if (rtt < 100 && downlink > 5) {
    connectionType = 'fast'
  }
  
  // Detectar capacidades
  const capabilities = {
    supportsWebP: acceptEncoding.includes('webp') || userAgent.includes('Chrome'),
    supportsModernJS: !(/MSIE|Trident/i.test(userAgent)),
    prefersReducedData: saveData === 'on' || isSlowConnection
  }
  
  // Criar contexto
  const deviceContext: DeviceContext = {
    isMobile,
    isTablet,
    isSlowConnection,
    connectionType,
    capabilities
  }
  
  // Anexar ao request
  req.deviceContext = deviceContext
  
  // Headers de debug (opcional, apenas em desenvolvimento)
  if (process.env.NODE_ENV === 'development') {
    res.set('X-Device-Type', isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop')
    res.set('X-Connection-Type', connectionType)
  }
  
  next()
}