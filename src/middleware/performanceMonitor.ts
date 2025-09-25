import { Request, Response, NextFunction } from 'express'
import os from 'os'

export interface PerformanceMetrics {
  responseTime: number
  cpuUsage: number
  memoryUsage: {
    used: number
    free: number
    percentage: number
  }
  requestCount: number
  errorCount: number
  activeConnections: number
  timestamp: number
}

export interface AdaptiveSettings {
  shouldThrottle: boolean
  recommendedTimeout: number
  recommendedLimit: number
  reason: string
}

// Métricas globais
let globalMetrics = {
  totalRequests: 0,
  totalErrors: 0,
  responseTimeSum: 0,
  activeConnections: 0,
  recentResponseTimes: [] as number[],
  lastReset: Date.now()
}

// Configurações adaptativas baseadas em performance
const PERFORMANCE_THRESHOLDS = {
  CPU_HIGH: 80,
  MEMORY_HIGH: 85,
  RESPONSE_TIME_HIGH: 2000, // 2s
  CONNECTIONS_HIGH: 100
}

export function performanceMonitor() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = Date.now()
    globalMetrics.totalRequests++
    globalMetrics.activeConnections++
    
    // Interceptar resposta para capturar métricas
    const originalSend = res.send
    res.send = function(data: any) {
      const responseTime = Date.now() - startTime
      globalMetrics.activeConnections--
      globalMetrics.responseTimeSum += responseTime
      
      // Manter histórico de tempos de resposta (últimos 100)
      globalMetrics.recentResponseTimes.push(responseTime)
      if (globalMetrics.recentResponseTimes.length > 100) {
        globalMetrics.recentResponseTimes.shift()
      }
      
      // Detectar erros
      if (res.statusCode >= 400) {
        globalMetrics.totalErrors++
      }
      
      // Anexar métricas básicas no header para debug
      if (req.query.debug === 'performance') {
        res.setHeader('X-Response-Time', responseTime)
        res.setHeader('X-Active-Connections', globalMetrics.activeConnections)
      }
      
      return originalSend.call(this, data)
    }
    
    next()
  }
}

// Coletar métricas atuais do sistema
export function getCurrentMetrics(): PerformanceMetrics {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  
  // Calcular CPU médio (simplificado)
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0)
    const idle = cpu.times.idle
    return acc + ((total - idle) / total) * 100
  }, 0) / cpus.length
  
  // Tempo de resposta médio
  const avgResponseTime = globalMetrics.totalRequests > 0 
    ? globalMetrics.responseTimeSum / globalMetrics.totalRequests
    : 0
  
  return {
    responseTime: avgResponseTime,
    cpuUsage: Math.round(cpuUsage * 100) / 100,
    memoryUsage: {
      used: usedMem,
      free: freeMem,
      percentage: Math.round((usedMem / totalMem) * 100 * 100) / 100
    },
    requestCount: globalMetrics.totalRequests,
    errorCount: globalMetrics.totalErrors,
    activeConnections: globalMetrics.activeConnections,
    timestamp: Date.now()
  }
}

// Gerar recomendações adaptativas baseadas em performance
export function getAdaptiveSettings(req: Request): AdaptiveSettings {
  const metrics = getCurrentMetrics()
  const config = req.adaptiveConfig
  
  let shouldThrottle = false
  let recommendedTimeout = config?.timeouts?.sseTimeout || 60000
  let recommendedLimit = config?.pagination?.messageLimit || 50
  let reason = 'optimal_performance'
  
  // Análise de CPU
  if (metrics.cpuUsage > PERFORMANCE_THRESHOLDS.CPU_HIGH) {
    shouldThrottle = true
    recommendedTimeout = Math.max(30000, recommendedTimeout * 0.7)
    recommendedLimit = Math.max(10, Math.floor(recommendedLimit * 0.6))
    reason = 'high_cpu_usage'
  }
  
  // Análise de memória
  if (metrics.memoryUsage.percentage > PERFORMANCE_THRESHOLDS.MEMORY_HIGH) {
    shouldThrottle = true
    recommendedLimit = Math.max(5, Math.floor(recommendedLimit * 0.5))
    reason = reason === 'optimal_performance' ? 'high_memory_usage' : 'high_cpu_memory'
  }
  
  // Análise de tempo de resposta
  const recentAvgTime = globalMetrics.recentResponseTimes.length > 0
    ? globalMetrics.recentResponseTimes.reduce((a, b) => a + b, 0) / globalMetrics.recentResponseTimes.length
    : 0
    
  if (recentAvgTime > PERFORMANCE_THRESHOLDS.RESPONSE_TIME_HIGH) {
    shouldThrottle = true
    recommendedLimit = Math.max(3, Math.floor(recommendedLimit * 0.4))
    reason = reason === 'optimal_performance' ? 'slow_response_time' : 'multiple_issues'
  }
  
  // Análise de conexões ativas
  if (metrics.activeConnections > PERFORMANCE_THRESHOLDS.CONNECTIONS_HIGH) {
    shouldThrottle = true
    recommendedTimeout = Math.max(20000, recommendedTimeout * 0.5)
    reason = reason === 'optimal_performance' ? 'high_connections' : 'multiple_issues'
  }
  
  return {
    shouldThrottle,
    recommendedTimeout,
    recommendedLimit,
    reason
  }
}

// Endpoint para dashboard de performance
export function performanceHandler(req: Request, res: Response): void {
  try {
    const metrics = getCurrentMetrics()
    const adaptive = getAdaptiveSettings(req)
    
    // Dados históricos simples (últimos 10 minutos)
    const historical = {
      recentResponseTimes: globalMetrics.recentResponseTimes.slice(-20),
      errorRate: globalMetrics.totalRequests > 0 
        ? (globalMetrics.totalErrors / globalMetrics.totalRequests) * 100 
        : 0,
      requestsPerMinute: globalMetrics.totalRequests / ((Date.now() - globalMetrics.lastReset) / 60000)
    }
    
    res.json({
      current: metrics,
      adaptive,
      historical,
      thresholds: PERFORMANCE_THRESHOLDS,
      recommendations: generateRecommendations(metrics, adaptive)
    })
  } catch (error: any) {
    res.status(500).json({
      error: 'performance_metrics_failed',
      message: error.message
    })
  }
}

// Gerar recomendações práticas
function generateRecommendations(metrics: PerformanceMetrics, adaptive: AdaptiveSettings): string[] {
  const recommendations: string[] = []
  
  if (adaptive.shouldThrottle) {
    recommendations.push(`⚠️ Sistema sob pressão: ${adaptive.reason}`)
  }
  
  if (metrics.cpuUsage > 70) {
    recommendations.push('🔥 CPU alto: considere escalar horizontalmente')
  }
  
  if (metrics.memoryUsage.percentage > 80) {
    recommendations.push('💾 Memória alta: verificar vazamentos ou aumentar RAM')
  }
  
  if (globalMetrics.recentResponseTimes.some(t => t > 3000)) {
    recommendations.push('🐌 Respostas lentas detectadas: revisar queries e cache')
  }
  
  if (metrics.activeConnections > 80) {
    recommendations.push('🌐 Muitas conexões: implementar pool de conexões')
  }
  
  if (recommendations.length === 0) {
    recommendations.push('✅ Sistema operando normalmente')
  }
  
  return recommendations
}

// Reset das métricas (util para testes)
export function resetMetrics(): void {
  globalMetrics = {
    totalRequests: 0,
    totalErrors: 0,
    responseTimeSum: 0,
    activeConnections: 0,
    recentResponseTimes: [],
    lastReset: Date.now()
  }
}

// Auto-otimização: ajustar configuração baseado em métricas
export function autoOptimizeMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const adaptive = getAdaptiveSettings(req)
    
    // Aplicar otimizações automáticas
    if (adaptive.shouldThrottle && req.adaptiveConfig) {
      req.adaptiveConfig.pagination.messageLimit = Math.min(
        req.adaptiveConfig.pagination.messageLimit,
        adaptive.recommendedLimit
      )
      req.adaptiveConfig.timeouts.sseTimeout = Math.min(
        req.adaptiveConfig.timeouts.sseTimeout,
        adaptive.recommendedTimeout
      )
      
      // Adicionar header informativo
      res.setHeader('X-Auto-Optimized', adaptive.reason)
    }
    
    next()
  }
}