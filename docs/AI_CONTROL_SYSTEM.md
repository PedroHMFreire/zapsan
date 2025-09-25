# 🛡️ Sistema de Controle de IA - Prevenção de Respostas Genéricas

## 📋 **Problema Resolvido**
- ✅ IA não inventa mais informações
- ✅ Só responde com base no contexto da empresa
- ✅ Bloqueia respostas genéricas da web
- ✅ Fallback controlado quando sem contexto

## 🔒 **4 Camadas de Proteção**

### **CAMADA 1: Controle de Contexto Mínimo**
```typescript
if (sections.length === 0 || sections.every(s => (s.score || 0) === 0)) {
  logger.warn({ text: input.text }, '[ai][no_context]')
  return generateFallbackResponse(input.text, cfg)
}
```
**→ Se não tem contexto relevante, usa fallback da empresa**

### **CAMADA 2: Prompt Ultra-Restritivo**
```
REGRAS CRÍTICAS DE RESPOSTA:
1. Você DEVE responder APENAS com informações presentes no contexto abaixo
2. Se a informação não estiver no contexto, responda: "Preciso confirmar..."
3. NUNCA invente: preços, produtos, políticas, horários, endereços
4. NUNCA use conhecimento geral da web ou treinamento anterior
5. Mantenha respostas focadas no negócio e objetivas
```

### **CAMADA 3: Parâmetros OpenAI Restritivos**
```typescript
temperature: 0.3,  // Baixa criatividade
max_tokens: 300,   // Respostas concisas  
top_p: 0.8        // Menos variabilidade
```

### **CAMADA 4: Validação Pós-Resposta**
```typescript
if (isGenericResponse(aiResponse) || !hasContextualRelevance(aiResponse, sections)) {
  logger.warn({ response: aiResponse.slice(0, 50) }, '[ai][generic_detected]')
  return generateContextualFallback(input.text, sections, cfg)
}
```

## 🎯 **Tipos de Fallback**

### **1. Sem Contexto (Cliente novo)**
```
"Oi! Sou [Nome] da [Empresa]. No que posso te ajudar hoje?"
```

### **2. Contexto Parcial (Seção encontrada)**
```
"Oi! Sou [Nome]. Vi que você está interessado em [Seção]. 
Posso te ajudar com mais detalhes sobre isso!"
```

### **3. Erro OpenAI**
```
"Oi! Sou [Nome]. Vi que você está interessado em algo relacionado a [tópico]. 
Posso te ajudar com mais detalhes sobre isso!"
```

## 🔍 **Detecção de Problemas**

### **Respostas Genéricas Detectadas:**
- "posso ajudar com isso"
- "vou verificar para você" 
- "deixe-me consultar"
- "como posso ajudar"
- Respostas < 100 caracteres com essas frases

### **Relevância Contextual:**
- Pelo menos 10% das palavras devem vir do contexto
- Palavras com +3 caracteres são consideradas
- Compara resposta vs seções da base de conhecimento

## 📊 **Logs de Monitoramento**

```bash
# Ver quando não tem contexto
grep "[ai][no_context]" logs/

# Ver quando detecta resposta genérica  
grep "[ai][generic_detected]" logs/

# Ver erros da OpenAI
grep "Erro OpenAI" logs/
```

## 🚀 **Como Testar**

### **1. Pergunta SEM contexto:**
```
Cliente: "Oi"
Esperado: "Oi! Sou [Nome] da [Empresa]. No que posso te ajudar hoje?"
```

### **2. Pergunta COM contexto:**
```
Cliente: "Quais produtos vocês têm?"
Esperado: Resposta baseada na base de conhecimento
```

### **3. Pergunta FORA do contexto:**
```
Cliente: "Qual a capital do Brasil?"
Esperado: "Preciso confirmar essa informação com nossa equipe..."
```

## ⚙️ **Configurações**

### **Arquivo: `config/bot.yaml`**
```yaml
profile:
  name: "Ana"           # Nome do atendente
  business: "Loja XYZ"  # Nome da empresa
```

### **Base de Conhecimento: `data/knowledge/main.md`**
- Adicione seções com `## Título`
- Detalhe produtos, políticas, preços
- Use linguagem natural e específica

## 🔧 **Manutenção**

### **Para Adicionar Novo Conteúdo:**
1. Edite `data/knowledge/main.md`
2. Adicione seção com `## Novo Tópico`
3. Reinicie o servidor para recarregar

### **Para Ajustar Sensibilidade:**
- `temperature`: 0.1-0.5 (mais baixo = menos criativo)
- `relevantWords.length >= Math.max(1, responseWords.length * 0.X)`: 
  - 0.1 = 10% das palavras devem ser do contexto
  - 0.2 = 20% das palavras devem ser do contexto

### **Para Adicionar Novos Fallbacks:**
```typescript
const responses = [
  // Adicione novos templates aqui
  `Nova resposta com ${name} e ${business}`
]
```

---
**✅ Sistema Ativo:** A partir de agora, a IA só responderá com informações da sua base de conhecimento!