import fs from 'fs'
import path from 'path'
import { ReplyInput } from './types'
import { selectSections } from './knowledge'
import { logger } from './logger'
import YAML from 'yaml'

function loadBotConfig() {
  const file = path.join(process.cwd(), 'config', 'bot.yaml')
  const raw = fs.readFileSync(file, 'utf8')
  // Suporte simples a ${ENV}
  const templated = raw.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? '')
  const cfg = YAML.parse(templated)
  return cfg || {}
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

export async function reply(input: ReplyInput): Promise<string> {
  const cfg = loadBotConfig()
  const systemBase = buildSystemPrompt(cfg)
  // Selecionar seções relevantes da base de conhecimento
  const sections = selectSections(input.text || '')
  const contextBlock = sections.length
    ? sections.map(s => `(Seção: ${s.heading})\n${s.content.trim()}`).join('\n\n')
    : 'Nenhuma seção relevante encontrada. Solicite gentilmente mais detalhes ao cliente.'
  const system = `${systemBase}\n\nINSTRUÇÕES DE CONTEXTO:\nVocê deve basear sua resposta SOMENTE no contexto abaixo.\nSe a informação não estiver presente, peça mais detalhes ou admita que precisa confirmar.\nNão invente produtos, políticas, tamanhos ou condições.\n\n[Contexto]\n${contextBlock}`
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

  // Fallback sem OpenAI
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY não definido — usando fallback local.')
    return `[${cfg?.profile?.name || 'Atendente'}] Entendi: "${input.text}". Temos ótimas opções! Qual seu tamanho/numeração e preferência de cor? Posso separar pra você 😉`
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input.text }
    ]
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
    return 'Tive um probleminha aqui na IA agora. Pode repetir sua pergunta?'
  }
  const data = await res.json() as any
  const msg = data.choices?.[0]?.message?.content?.trim()
  return msg || 'Posso te ajudar a escolher? Qual seu tamanho e cor preferida?'
}