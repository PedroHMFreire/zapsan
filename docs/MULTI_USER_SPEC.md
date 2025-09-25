# Multi-User AI Configuration System

## File Structure
```
data/
  users/
    {userId}/
      knowledge/
        main.md          # User-specific knowledge base
      config/
        bot.yaml         # User-specific bot configuration
      sessions/
        {sessionId}.json # Session data (already exists)
```

## Database Extensions
```sql
-- User profiles table
CREATE TABLE user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  bot_name VARCHAR(100) DEFAULT 'Atendente',
  business_name VARCHAR(200),
  bot_tone TEXT DEFAULT 'Vendedor consultivo e simpático',
  products TEXT[], -- Array of products
  rules TEXT[],    -- Array of rules
  memory TEXT[],   -- Array of memory items
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User knowledge base
CREATE TABLE user_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  section_title VARCHAR(200),
  section_content TEXT,
  section_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```