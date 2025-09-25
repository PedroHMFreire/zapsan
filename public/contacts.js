/**
 * Sistema de Gerenciamento de Contatos - ZapSan
 * Gerencia agenda interna com importação de planilhas
 */

class ContactManager {
  constructor() {
    this.contacts = new Map()
    this.storageKey = 'zapsan-contacts'
    this.loadContacts()
  }

  // 💾 Persistência
  loadContacts() {
    try {
      const stored = localStorage.getItem(this.storageKey)
      if (stored) {
        const data = JSON.parse(stored)
        this.contacts = new Map(Object.entries(data))
      }
    } catch (error) {
      console.warn('Erro ao carregar contatos:', error)
    }
  }

  saveContacts() {
    try {
      const data = Object.fromEntries(this.contacts)
      localStorage.setItem(this.storageKey, JSON.stringify(data))
    } catch (error) {
      console.error('Erro ao salvar contatos:', error)
    }
  }

  // 📞 Formatação de números
  formatPhone(phone) {
    // Remove todos os caracteres não numéricos
    const clean = phone.replace(/\D/g, '')
    
    // Adiciona código do país se não tiver
    if (clean.length === 11 && clean.startsWith('0')) {
      return '55' + clean.substring(1) // Remove 0 e adiciona 55
    }
    if (clean.length === 11 && !clean.startsWith('55')) {
      return '55' + clean
    }
    if (clean.length === 10 && !clean.startsWith('55')) {
      return '55' + clean
    }
    
    return clean
  }

  // ➕ Adicionar/Atualizar contato
  addContact(phone, name, tags = [], notes = undefined) {
    const formattedPhone = this.formatPhone(phone)
    const now = Date.now()
    
    const existing = this.contacts.get(formattedPhone)
    const contact = {
      phone: formattedPhone,
      name: name.trim(),
      tags: [...new Set(tags)], // Remove duplicatas
      notes: notes?.trim(),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
    
    this.contacts.set(formattedPhone, contact)
    this.saveContacts()
    
    return contact
  }

  // 🗑️ Remover contato
  removeContact(phone) {
    const formattedPhone = this.formatPhone(phone)
    const removed = this.contacts.delete(formattedPhone)
    if (removed) {
      this.saveContacts()
    }
    return removed
  }

  // 🔍 Buscar contatos
  searchContacts(query) {
    const lowerQuery = query.toLowerCase().trim()
    if (!lowerQuery) return this.getAllContacts()
    
    return this.getAllContacts().filter(contact => 
      contact.name.toLowerCase().includes(lowerQuery) ||
      contact.phone.includes(lowerQuery) ||
      contact.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      contact.notes?.toLowerCase().includes(lowerQuery)
    )
  }

  // 📋 Obter contatos
  getAllContacts() {
    return Array.from(this.contacts.values())
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  getContact(phone) {
    const formattedPhone = this.formatPhone(phone)
    return this.contacts.get(formattedPhone)
  }

  getContactName(phone) {
    const contact = this.getContact(phone)
    return contact?.name || phone
  }

  // 📊 Estatísticas
  getStats() {
    const contacts = this.getAllContacts()
    const allTags = contacts.flatMap(c => c.tags)
    const uniqueTags = [...new Set(allTags)].sort()
    
    return {
      total: contacts.length,
      withNotes: contacts.filter(c => c.notes).length,
      tags: uniqueTags
    }
  }

  // 📤 Exportar contatos
  exportContacts() {
    const contacts = this.getAllContacts()
    const headers = ['Nome', 'Telefone', 'Tags', 'Notas']
    const rows = contacts.map(c => [
      c.name,
      c.phone,
      c.tags.join('; '),
      c.notes || ''
    ])
    
    const csv = [headers, ...rows]
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n')
    
    return csv
  }

  // 📥 Importar de planilha
  async importFromFile(file) {
    const result = { success: 0, errors: [] }
    
    try {
      const text = await this.readFileAsText(file)
      const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
      
      if (lines.length === 0) {
        result.errors.push('Arquivo vazio')
        return result
      }

      // Detectar formato (CSV ou TSV)
      const separator = text.includes('\t') ? '\t' : ','
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (i === 0 && this.isHeaderLine(line)) continue // Pular cabeçalho
        
        try {
          const contact = this.parseContactLine(line, separator)
          if (contact) {
            this.addContact(contact.phone, contact.name, contact.tags, contact.notes)
            result.success++
          }
        } catch (error) {
          result.errors.push(`Linha ${i + 1}: ${error.message}`)
        }
      }
      
    } catch (error) {
      result.errors.push(`Erro ao processar arquivo: ${error.message}`)
    }
    
    return result
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = e => resolve(e.target?.result)
      reader.onerror = () => reject(new Error('Erro ao ler arquivo'))
      reader.readAsText(file, 'utf-8')
    })
  }

  isHeaderLine(line) {
    const lower = line.toLowerCase()
    return lower.includes('nome') || lower.includes('name') || 
           lower.includes('telefone') || lower.includes('phone')
  }

  parseContactLine(line, separator) {
    const fields = this.parseCSVLine(line, separator)
    if (fields.length < 2) return null
    
    // Tentar diferentes formatos de coluna
    let name = '', phone = '', tags = '', notes = ''
    
    if (fields.length >= 2) {
      // Formato: Nome, Telefone, ...
      name = fields[0]?.trim()
      phone = fields[1]?.trim()
      tags = fields[2]?.trim() || ''
      notes = fields[3]?.trim() || ''
    }
    
    if (!name || !phone) return null
    
    return {
      name,
      phone,
      tags: tags ? tags.split(/[;,]/).map(t => t.trim()).filter(Boolean) : [],
      notes: notes || undefined
    }
  }

  parseCSVLine(line, separator) {
    const result = []
    let current = ''
    let inQuotes = false
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === separator && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
    
    result.push(current)
    return result
  }

  // 🧹 Limpar dados
  clearAllContacts() {
    this.contacts.clear()
    localStorage.removeItem(this.storageKey)
  }
}

// Instância global
const contactManager = new ContactManager()

// Disponibilizar globalmente
if (typeof window !== 'undefined') {
  window.contactManager = contactManager
}