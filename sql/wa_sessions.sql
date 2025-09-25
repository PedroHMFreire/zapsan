-- Tabela para armazenar credenciais do WhatsApp de forma persistente
-- Evita necessidade de reconexão a cada deploy

CREATE TABLE IF NOT EXISTS wa_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  creds JSONB NOT NULL,
  keys JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para busca rápida por session_id
CREATE INDEX IF NOT EXISTS idx_wa_sessions_session_id ON wa_sessions(session_id);

-- RLS (Row Level Security) para proteger credenciais
ALTER TABLE wa_sessions ENABLE ROW LEVEL SECURITY;

-- Política: apenas o sistema pode acessar (não usuários via client)
CREATE POLICY "System only access" ON wa_sessions
  FOR ALL
  TO service_role
  USING (true);

-- Comentários para documentação
COMMENT ON TABLE wa_sessions IS 'Armazena credenciais do WhatsApp para persistência entre deploys';
COMMENT ON COLUMN wa_sessions.session_id IS 'ID único da sessão WhatsApp';
COMMENT ON COLUMN wa_sessions.creds IS 'Credenciais de autenticação do Baileys';
COMMENT ON COLUMN wa_sessions.keys IS 'Chaves de sincronização de estado do WhatsApp';