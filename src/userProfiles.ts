import { supa } from './db'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'

export interface UserProfile {
  id: string
  userId: string
  botName: string
  businessName: string
  botTone: string
  products: string[]
  rules: string[]
  memory: string[]
  createdAt: Date
  updatedAt: Date
}

export interface UserKnowledgeSection {
  id: string
  userId: string
  sectionTitle: string
  sectionContent: string
  sectionOrder: number
  createdAt: Date
  updatedAt: Date
}

// 🏢 === USER PROFILE MANAGEMENT ===

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  try {
    const { data, error } = await supa
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single()
    
    if (error || !data) return null
    
    return {
      id: data.id,
      userId: data.user_id,
      botName: data.bot_name || 'Atendente',
      businessName: data.business_name || 'Minha Empresa',
      botTone: data.bot_tone || 'Vendedor consultivo e simpático',
      products: data.products || [],
      rules: data.rules || [],
      memory: data.memory || [],
      createdAt: data.created_at,
      updatedAt: data.updated_at
    }
  } catch (error) {
    console.error('Error fetching user profile:', error)
    return null
  }
}

export async function createOrUpdateUserProfile(userId: string, profile: Partial<UserProfile>): Promise<UserProfile> {
  try {
    const existing = await getUserProfile(userId)
    
    const profileData = {
      user_id: userId,
      bot_name: profile.botName || existing?.botName || 'Atendente',
      business_name: profile.businessName || existing?.businessName || 'Minha Empresa',
      bot_tone: profile.botTone || existing?.botTone || 'Vendedor consultivo e simpático',
      products: profile.products || existing?.products || [],
      rules: profile.rules || existing?.rules || [],
      memory: profile.memory || existing?.memory || [],
      updated_at: new Date().toISOString()
    }
    
    const { data, error } = await supa
      .from('user_profiles')
      .upsert(profileData, { onConflict: 'user_id' })
      .select('*')
      .single()
    
    if (error) throw error
    
    return {
      id: data.id,
      userId: data.user_id,
      botName: data.bot_name,
      businessName: data.business_name,
      botTone: data.bot_tone,
      products: data.products,
      rules: data.rules,
      memory: data.memory,
      createdAt: data.created_at,
      updatedAt: data.updated_at
    }
  } catch (error) {
    console.error('Error creating/updating user profile:', error)
    throw error
  }
}

// 📚 === USER KNOWLEDGE BASE ===

export async function getUserKnowledge(userId: string): Promise<UserKnowledgeSection[]> {
  try {
    const { data, error } = await supa
      .from('user_knowledge')
      .select('*')
      .eq('user_id', userId)
      .order('section_order', { ascending: true })
    
    if (error) throw error
    
    return (data || []).map(item => ({
      id: item.id,
      userId: item.user_id,
      sectionTitle: item.section_title,
      sectionContent: item.section_content,
      sectionOrder: item.section_order,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    }))
  } catch (error) {
    console.error('Error fetching user knowledge:', error)
    return []
  }
}

export async function updateUserKnowledge(userId: string, sections: Array<{
  title: string
  content: string
  order?: number
}>): Promise<UserKnowledgeSection[]> {
  try {
    // Delete existing sections for this user
    await supa.from('user_knowledge').delete().eq('user_id', userId)
    
    // Insert new sections
    const newSections = sections.map((section, index) => ({
      user_id: userId,
      section_title: section.title,
      section_content: section.content,
      section_order: section.order ?? index
    }))
    
    if (newSections.length > 0) {
      const { data, error } = await supa
        .from('user_knowledge')
        .insert(newSections)
        .select('*')
        .order('section_order', { ascending: true })
      
      if (error) throw error
      
      return (data || []).map(item => ({
        id: item.id,
        userId: item.user_id,
        sectionTitle: item.section_title,
        sectionContent: item.section_content,
        sectionOrder: item.section_order,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }))
    }
    
    return []
  } catch (error) {
    console.error('Error updating user knowledge:', error)
    throw error
  }
}

// 🤖 === AI CONFIGURATION HELPERS ===

export async function getUserBotConfig(userId: string): Promise<any> {
  const profile = await getUserProfile(userId)
  
  if (!profile) {
    // Return default config if no profile exists
    return {
      profile: {
        name: 'Atendente',
        business: 'Minha Empresa',
        tone: 'Vendedor consultivo e simpático'
      },
      rules: ['Seja prestativo e claro'],
      memory: ['Sem informações específicas']
    }
  }
  
  return {
    profile: {
      name: profile.botName,
      business: profile.businessName,
      tone: profile.botTone,
      products: profile.products
    },
    rules: profile.rules,
    memory: profile.memory
  }
}

export async function getUserKnowledgeForAI(userId: string): Promise<Array<{
  heading: string
  content: string
  raw: string
  index: number
}>> {
  const sections = await getUserKnowledge(userId)
  
  return sections.map((section, index) => ({
    heading: section.sectionTitle,
    content: section.sectionContent,
    raw: `## ${section.sectionTitle}\n${section.sectionContent}`,
    index
  }))
}

// 📁 === FILE SYSTEM HELPERS (for backward compatibility) ===

export async function createUserDataStructure(userId: string): Promise<void> {
  const userDataDir = path.join(process.cwd(), 'data', 'users', userId)
  const knowledgeDir = path.join(userDataDir, 'knowledge')
  const configDir = path.join(userDataDir, 'config')
  
  try {
    fs.mkdirSync(knowledgeDir, { recursive: true })
    fs.mkdirSync(configDir, { recursive: true })
    
    // Create default knowledge file if doesn't exist
    const knowledgeFile = path.join(knowledgeDir, 'main.md')
    if (!fs.existsSync(knowledgeFile)) {
      fs.writeFileSync(knowledgeFile, '# Base de Conhecimento\n\nAdicione aqui as informações específicas do seu negócio.')
    }
    
    // Create default config file if doesn't exist  
    const configFile = path.join(configDir, 'bot.yaml')
    if (!fs.existsSync(configFile)) {
      const defaultConfig = {
        profile: {
          name: 'Atendente',
          business: 'Minha Empresa',
          tone: 'Vendedor consultivo e simpático'
        },
        rules: ['Seja prestativo e claro'],
        memory: ['Sem informações específicas']
      }
      fs.writeFileSync(configFile, YAML.stringify(defaultConfig))
    }
  } catch (error) {
    console.error(`Error creating user data structure for ${userId}:`, error)
  }
}

// 🔄 === MIGRATION HELPERS ===

export async function migrateUserDataToDatabase(userId: string): Promise<void> {
  const userDataDir = path.join(process.cwd(), 'data', 'users', userId)
  
  try {
    // Migrate config
    const configFile = path.join(userDataDir, 'config', 'bot.yaml')
    if (fs.existsSync(configFile)) {
      const configContent = fs.readFileSync(configFile, 'utf8')
      const config = YAML.parse(configContent)
      
      await createOrUpdateUserProfile(userId, {
        botName: config?.profile?.name,
        businessName: config?.profile?.business,
        botTone: config?.profile?.tone,
        products: config?.profile?.products || [],
        rules: config?.rules || [],
        memory: config?.memory || []
      })
    }
    
    // Migrate knowledge
    const knowledgeFile = path.join(userDataDir, 'knowledge', 'main.md')
    if (fs.existsSync(knowledgeFile)) {
      const knowledgeContent = fs.readFileSync(knowledgeFile, 'utf8')
      
      // Simple parsing - split by ## headers
      const sections: Array<{ title: string; content: string }> = []
      const lines = knowledgeContent.split('\n')
      let currentSection: { title: string; content: string } | null = null
      
      for (const line of lines) {
        const headerMatch = line.match(/^##\s+(.+)/)
        if (headerMatch) {
          if (currentSection) {
            sections.push(currentSection)
          }
          currentSection = { title: headerMatch[1], content: '' }
        } else if (currentSection) {
          currentSection.content += line + '\n'
        }
      }
      
      if (currentSection) {
        sections.push(currentSection)
      }
      
      if (sections.length > 0) {
        await updateUserKnowledge(userId, sections)
      }
    }
    
    console.log(`Successfully migrated user data for ${userId}`)
  } catch (error) {
    console.error(`Error migrating user data for ${userId}:`, error)
  }
}