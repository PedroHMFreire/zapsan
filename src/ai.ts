import fs from 'fs'
import path from 'path'
import { ReplyInput } from './types'
import { selectSections } from './knowledge'
import { logger } from './logger'
import YAML from 'yaml'
import { getUserBotConfig, getUserKnowledgeForAI } from './userProfiles'

// Fallback: load global config if user config not available
function loadGlobalBotConfig() {
  const file = path.join(process.cwd(), 'config', 'bot.yaml')
  const raw = fs.readFileSync(file, 'utf8')
  // Suporte simples a ${ENV}
  const templated = raw.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? '')
  const cfg = YAML.parse(templated)
  return cfg || {}
}

async function loadUserBotConfig(userId?: string) {
  if (!userId) {
    return loadGlobalBotConfig()
  }
  
  try {
    return await getUserBotConfig(userId)
  } catch (error) {
    console.warn(`Failed to load user config for ${userId}, using global:`, error)
    return loadGlobalBotConfig()
  }
}

function buildSystemPrompt(cfg: any) {
  const name = cfg?.profile?.name || process.env.BOT_NAME || 'Atendente Santê'
  const business = cfg?.profile?.business || process.env.BUSINESS_NAME || 'Santê Moda'
  const tone = cfg?.profile?.tone || 'Vendedor consultivo e simpático.'
  const products = (cfg?.profile?.products || []).join(', ')
  const rules = (cfg?.rules || []).map((r: string) => `- ${r}`).join('\n')
  const memory = (cfg?.memory || []).map((m: string) => `- ${m}`).join('\n')

  return `Você é ${name}, atendente do negócio ${business}.
Tom: ${tone}
Produtos/Serviços: ${products || 'moda praia e casual da Santê'}.
Regras de atendimento:
${rules || '- Seja claro, objetivo e prestativo.'}
Memória do negócio:
${memory || '- Sem memória adicional.'}

Objetivo: ajudar o cliente a escolher produtos de moda. Se necessário, peça tamanho/numeração e preferências. Sempre finalize com um próximo passo claro (CTA leve).`
}

// Simple knowledge selection for user-specific content
function selectKnowledgeSections(query: string, userKnowledge: Array<{ heading: string; content: string; raw: string; index: number }>): Array<{ heading: string; content: string; raw: string; index: number; score?: number }> {
  if (!query || userKnowledge.length === 0) {
    return []
  }
  
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  
  const scored = userKnowledge.map(section => {
    const contentLower = (section.heading + ' ' + section.content).toLowerCase()
    const score = queryWords.reduce((acc, word) => {
      const matches = (contentLower.match(new RegExp(word, 'g')) || []).length
      return acc + matches
    }, 0)
    
    return { ...section, score }
  }).filter(section => section.score > 0)
  
  // Sort by score descending, take top 3
  return scored.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3)
}

export async function reply(input: ReplyInput): Promise<string> {
  const cfg = await loadUserBotConfig(input.userId)
  const systemBase = buildSystemPrompt(cfg)
  
  // Selecionar seções relevantes da base de conhecimento do usuário
  let sections: any[] = []
  if (input.userId) {
    try {
      const userKnowledge = await getUserKnowledgeForAI(input.userId)
      sections = selectKnowledgeSections(input.text || '', userKnowledge)
    } catch (error) {
      console.warn(`Failed to load user knowledge for ${input.userId}, using global:`, error)
      sections = selectSections(input.text || '')
    }
  } else {
    sections = selectSections(input.text || '')
  }
  
  // 🛡️ CAMADA 1: CONTROLE DE CONTEXTO MÍNIMO
  if (sections.length === 0 || sections.every(s => (s.score || 0) === 0)) {
    logger.warn({ text: input.text, userId: input.userId }, '[ai][no_context]')
    return generateFallbackResponse(input.text, cfg)
  }
  
  const contextBlock = sections.map(s => `(Seção: ${s.heading})\n${s.content.trim()}`).join('\n\n')
  
  // 🛡️ CAMADA 2: PROMPT ULTRA-RESTRITIVO
  const system = `${systemBase}

REGRAS CRÍTICAS DE RESPOSTA:
1. Você DEVE responder APENAS com informações presentes no contexto abaixo
2. Se a informação não estiver no contexto, responda: "Preciso confirmar essa informação com nossa equipe. Posso te ajudar com algo que temos disponível?"
3. NUNCA invente: preços, produtos, políticas, horários, endereços ou qualquer informação
4. NUNCA use conhecimento geral da web ou treinamento anterior
5. Mantenha respostas focadas no negócio e objetivas
6. Se cliente perguntar algo fora do contexto, redirecione para opções disponíveis

CONTEXTO AUTORIZADO (ÚNICA FONTE DE VERDADE):
${contextBlock}

Responda como ${cfg?.profile?.name || 'Atendente'} baseado EXCLUSIVAMENTE no contexto acima.`
  
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

  // Fallback sem OpenAI
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY não definido — usando fallback controlado.')
    return generateContextualFallback(input.text, sections, cfg)
  }

  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: input.text }
      ],
      temperature: 0.3, // 🛡️ CAMADA 3: BAIXA CRIATIVIDADE
      max_tokens: 300,  // Respostas concisas
      top_p: 0.8       // Menos variabilidade
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const err = await res.text()
      logger.error({ err }, 'Erro OpenAI')
      return generateContextualFallback(input.text, sections, cfg)
    }
    
    const data = await res.json() as any
    let aiResponse = data.choices?.[0]?.message?.content?.trim()
    
    // 🛡️ CAMADA 4: VALIDAÇÃO PÓS-RESPOSTA
    if (!aiResponse) {
      return generateContextualFallback(input.text, sections, cfg)
    }
    
    // Detectar respostas muito genéricas ou fora do contexto
    if (isGenericResponse(aiResponse) || !hasContextualRelevance(aiResponse, sections)) {
      logger.warn({ response: aiResponse.slice(0, 50) }, '[ai][generic_detected]')
      return generateContextualFallback(input.text, sections, cfg)
    }
    
    return aiResponse
    
  } catch (error: any) {
    logger.error({ error: error.message }, 'Erro chamada OpenAI')
    return generateContextualFallback(input.text, sections, cfg)
  }
}

// 🎯 FALLBACK QUANDO SEM CONTEXTO
function generateFallbackResponse(text: string, cfg: any): string {
  const name = cfg?.profile?.name || 'Atendente'
  const business = cfg?.profile?.business || 'nossa loja'
  
  const responses = [
    `Oi! Sou ${name} da ${business}. No que posso te ajudar hoje?`,
    `Olá! Seja bem-vindo à ${business}. Em que posso ajudar?`,
    `Oi! Como posso ajudar você hoje na ${business}?`
  ]
  
  return responses[Math.floor(Math.random() * responses.length)]
}

// 🎯 FALLBACK CONTEXTUAL (com base nas seções encontradas)
function generateContextualFallback(text: string, sections: any[], cfg: any): string {
  const name = cfg?.profile?.name || 'Atendente'
  
  if (sections.length > 0) {
    const topSection = sections[0]
    return `Oi! Sou ${name}. Vi que você está interessado em algo relacionado a ${topSection.heading.toLowerCase()}. Posso te ajudar com mais detalhes sobre isso!`
  }
  
  return generateFallbackResponse(text, cfg)
}

// 🔍 DETECTAR RESPOSTAS GENÉRICAS
function isGenericResponse(response: string): boolean {
  const genericPhrases = [
    'posso ajudar com isso',
    'vou verificar para você',
    'deixe-me consultar',
    'vou checar nossa disponibilidade',
    'preciso verificar com',
    'como posso ajudar',
    'em que posso ajudar'
  ]
  
  const lowerResponse = response.toLowerCase()
  return genericPhrases.some(phrase => lowerResponse.includes(phrase)) && response.length < 100
}

// 🔍 VERIFICAR RELEVÂNCIA CONTEXTUAL
function hasContextualRelevance(response: string, sections: any[]): boolean {
  if (sections.length === 0) return false
  
  const responseWords = response.toLowerCase().split(/\s+/)
  const contextWords = sections
    .map(s => (s.heading + ' ' + s.content).toLowerCase())
    .join(' ')
    .split(/\s+/)
  
  const relevantWords = responseWords.filter(word => 
    word.length > 3 && contextWords.includes(word)
  )
  
  // Pelo menos 10% das palavras devem vir do contexto
  return relevantWords.length >= Math.max(1, responseWords.length * 0.1)
}