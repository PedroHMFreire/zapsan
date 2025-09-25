-- Migration: Multi-User AI System
-- Create tables for user profiles and knowledge base

-- User profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  bot_name VARCHAR(100) DEFAULT 'Atendente',
  business_name VARCHAR(200) DEFAULT 'Minha Empresa', 
  bot_tone TEXT DEFAULT 'Vendedor consultivo e simpático',
  products TEXT[] DEFAULT '{}', -- Array of products
  rules TEXT[] DEFAULT '{}',    -- Array of rules
  memory TEXT[] DEFAULT '{}',   -- Array of memory items
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id) -- One profile per user
);

-- User knowledge base
CREATE TABLE IF NOT EXISTS user_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  section_title VARCHAR(200) NOT NULL,
  section_content TEXT NOT NULL,
  section_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_knowledge_user_id ON user_knowledge(user_id);
CREATE INDEX IF NOT EXISTS idx_user_knowledge_order ON user_knowledge(user_id, section_order);

-- Update trigger for user_profiles
CREATE OR REPLACE FUNCTION update_user_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER IF NOT EXISTS trigger_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_user_profiles_updated_at();

-- Update trigger for user_knowledge
CREATE OR REPLACE FUNCTION update_user_knowledge_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER IF NOT EXISTS trigger_user_knowledge_updated_at
    BEFORE UPDATE ON user_knowledge
    FOR EACH ROW
    EXECUTE FUNCTION update_user_knowledge_updated_at();