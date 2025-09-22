# ZapSan

Servidor único (Express) que concentra:
- WhatsApp via **Baileys** (QR + envio de mensagens)
- Rotas REST
- Páginas web responsivas (QR + chat)
- IA (OpenAI ou fallback local)

## Como rodar localmente (desenvolvimento)

Pré-requisitos:
1. Node.js >= 18 (necessário para `fetch` nativo usado na chamada OpenAI)
2. Conta OpenAI (opcional – somente se quiser respostas reais da IA)
3. WhatsApp no celular para escanear o QR code

Passos:
```bash
# 1. Clonar (se ainda não)
# git clone <repo>
cd ZapSan

# 2. Criar arquivo de ambiente
cp .env.example .env

# 3. (Opcional) Editar .env e adicionar sua OPENAI_API_KEY
vi .env

# 4. Instalar dependências
npm install

# 5. Rodar em modo desenvolvimento (TS direto)
npm run dev
```

Abra: `http://localhost:${PORT:-3000}` (padrão 3000).

### Fluxo para ativar uma sessão WhatsApp
1. Envie uma requisição para criar a sessão:
	- POST `http://localhost:3000/sessions/create` body JSON: `{ "session_id": "loja1" }`
	- Resposta esperada: `{ ok: true, status: "creating" }`
2. Pegue o QR:
	- GET `http://localhost:3000/sessions/loja1/qr`
	- Enquanto a sessão não autenticou, retorna `{ dataUrl: "data:image/png;base64,..." }`
	- Renderize/cole a dataURL em uma tag `<img>` ou use a página `public/qr.html` adaptando.
3. Escaneie com o app WhatsApp (Aparelhos Conectados).
4. Após autenticar, o endpoint de QR passa a retornar 404 (QR some) indicando conexão aberta.

### Enviar mensagem
POST `http://localhost:3000/messages/send`
```json
{ "session_id": "loja1", "to": "<numero>@s.whatsapp.net", "text": "Olá!" }
```
Formato do campo `to` (internacional): `5599XXXXXXXX@s.whatsapp.net`.

### Testar resposta automática com IA
Depois que alguém mandar mensagem para o número conectado, o bot:
1. Lê o texto.
2. Monta o prompt com base em `config/bot.yaml` + variáveis de ambiente.
3. Responde via OpenAI (se `OPENAI_API_KEY` definido) ou fallback local.

Logs no terminal mostrarão eventos de conexão, atualização de QR e respostas.

## Build & produção
```bash
npm run build
npm start
```

## Endpoints
- `GET /health`
- `POST /sessions/create` → `{ session_id }`
- `GET /sessions/:id/qr`
- `GET /sessions/:id/status`
- `GET /sessions/:id/debug`
- `GET /sessions/:id/messages?limit=100&before=TIMESTAMP&after=TIMESTAMP&from=JID&direction=in|out&search=texto`
- `POST /messages/media` (multipart: file, session_id, to, caption?)
- `GET /sessions/:id/search?q=texto&limit=20` (busca índice invertido)
- `GET /sessions/:id/stream` (SSE eventos: message, message_status)
- `POST /messages/send` → `{ session_id, to, text }`

## Configurar o bot
Edite `config/bot.yaml` (perfil, regras, memória).

Pode usar variáveis no formato `${VAR}` que serão substituídas se existirem em `.env`.

## Variáveis de ambiente (.env)
| Nome | Descrição | Padrão |
|------|-----------|--------|
| PORT | Porta HTTP | 3000 |
| OPENAI_API_KEY | Chave para chamadas reais à OpenAI | (vazio => fallback) |
| OPENAI_MODEL | Modelo da API Chat | gpt-4o-mini |
| BOT_NAME | Nome do atendente | Atendente Santê |
| BUSINESS_NAME | Nome do negócio | Santê Moda |
| SYNC_FULL_HISTORY | Se =1, tenta sincronizar histórico completo ao conectar sessão | 0 |
| SAVE_MEDIA | Se =1, baixa mídias recebidas em `data/media/<session>` | 0 |
| WEBHOOK_URL | URL (http/https) para POST em cada mensagem recebida | (vazio) |
| ENABLE_SSE | Futuro controle (não obrigatório) para ligar/desligar SSE | (não usado) |

## Estrutura principal
| Caminho | Função |
|---------|--------|
| `src/server.ts` | Bootstrap Express + estáticos + rotas |
| `src/routes.ts` | Endpoints REST (sessões, mensagens, health) |
| `src/wa.ts` | Gerencia sessões Baileys, QR e mensagens recebidas |
| `src/ai.ts` | Monta prompt e chama OpenAI (ou fallback) |
| `config/bot.yaml` | Perfil, regras e memória do bot |
| `sessions/` | Credenciais multi-arquivo do Baileys por sessão |

## Troubleshooting
1. QR não aparece: confirme que chamou `POST /sessions/create` antes de `GET /sessions/:id/qr`.
2. Retorna 404 no QR imediatamente: sessão já autenticada (tudo certo) ou ID errado.
3. Mensagem não envia: formato do número deve terminar com `@s.whatsapp.net` e a sessão deve estar conectada.
4. IA sempre mesma resposta: provavelmente sem `OPENAI_API_KEY`, está usando fallback local.
5. Erro de modelo: troque `OPENAI_MODEL` para um modelo válido que sua conta suporta.

## Próximas melhorias sugeridas
Ver seção "Sugestões" ao final (ou PRs são bem-vindos!).

---

## Sugestões (roadmap curto)
- Endpoint para listar todas as sessões ativas.
- Rate limit básico nos endpoints públicos.
- Validação de payload com Zod ou similar.
- Suporte a IA responder com base em mídia (OCR / legendas).
- Persistência em banco (SQLite / Postgres) para mensagens.
- Fila de envio e retentativas com status detalhado.
- Reindex parcial com TTL / compressão de índice.
- Mecanismo de autenticação para SSE e uploads.

## Deploy sugerido (Render)
- Build: `npm i && npm run build`
- Start: `npm run start`