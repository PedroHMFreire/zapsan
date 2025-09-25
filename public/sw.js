/**
 * Service Worker para ZapSan PWA
 * Implementa cache offline e background sync
 */

const CACHE_VERSION = 'zapsan-v1.2.2-render-fix'
const STATIC_CACHE = `${CACHE_VERSION}-static`
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`
const API_CACHE = `${CACHE_VERSION}-api`

// Recursos para cache imediato (removido login.html para permitir redirects)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/chat.html',
  '/styles.css',
  '/mobile-enhancements.css',
  '/login.js',
  '/virtual-scroller.js',
  '/lazy-loader.js',
  '/api-batch-manager.js',
  '/mobile-gestures.js',
  '/manifest.json'
]

// APIs para cache com estratégia
const API_ROUTES = {
  '/me/profile': { strategy: 'networkFirst', ttl: 300000 }, // 5min
  '/me/session': { strategy: 'networkFirst', ttl: 60000 },  // 1min
  '/knowledge': { strategy: 'cacheFirst', ttl: 600000 },    // 10min
  '/messages': { strategy: 'networkFirst', ttl: 30000 },    // 30s
  '/sessions': { strategy: 'networkFirst', ttl: 120000 }    // 2min
}

// Install - Cache recursos estáticos
self.addEventListener('install', event => {
  console.log('🔧 SW: Installing...')
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('💾 SW: Caching static assets...')
        return cache.addAll(STATIC_ASSETS)
      })
      .then(() => {
        console.log('✅ SW: Static assets cached')
        return self.skipWaiting() // Força ativação imediata
      })
      .catch(error => {
        console.error('❌ SW: Install failed:', error)
      })
  )
})

// Activate - Limpa caches antigos
self.addEventListener('activate', event => {
  console.log('🚀 SW: Activating...')
  
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name.includes('zapsan-') && !name.includes(CACHE_VERSION))
            .map(name => {
              console.log(`🗑️ SW: Deleting old cache: ${name}`)
              return caches.delete(name)
            })
        )
      })
      .then(() => {
        console.log('✅ SW: Activated and old caches cleaned')
        return self.clients.claim() // Toma controle imediato
      })
  )
})

// Fetch - Estratégias de cache inteligentes
self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  // Ignorar requests externos e chrome-extension
  if (url.origin !== self.location.origin) return

  // Rotas que nunca devem ser interceptadas pelo SW (para evitar erro de redirect)
  const excludedRoutes = [
    '/', '/index.html', '/login.html', '/auth/', '/logout', '/api/auth/', '/me/', '/health', '/healthz'
  ];

  // Se for navegação principal (destination=document), nunca interceptar
  if (request.destination === 'document') {
    // Se for rota excluída OU ambiente de produção, não intercepta
    if (excludedRoutes.some(route => url.pathname === route || url.pathname.startsWith(route)) || self.location.hostname.includes('onrender.com') || self.location.hostname.includes('render.com')) {
      return;
    }
  }

  // Estratégia baseada no tipo de recurso
  if (request.method === 'GET') {
    event.respondWith(handleGetRequest(request))
  } else if (request.method === 'POST') {
    event.respondWith(handlePostRequest(request))
  }
})

// Estratégias para GET requests
async function handleGetRequest(request) {
  const url = new URL(request.url)
  
  // Recursos estáticos - Cache First
  if (STATIC_ASSETS.some(asset => url.pathname === asset || url.pathname.endsWith(asset))) {
    return cacheFirst(request, STATIC_CACHE)
  }
  
  // APIs específicas - Estratégia configurada
  const apiRoute = Object.keys(API_ROUTES).find(route => url.pathname.startsWith(route))
  if (apiRoute) {
    const config = API_ROUTES[apiRoute]
    
    switch (config.strategy) {
      case 'networkFirst':
        return networkFirst(request, API_CACHE, config.ttl)
      case 'cacheFirst':
        return cacheFirst(request, API_CACHE, config.ttl)
      case 'networkOnly':
        return fetch(request)
      case 'cacheOnly':
        return caches.match(request)
      default:
        return networkFirst(request, API_CACHE, config.ttl)
    }
  }
  
  // Outros recursos - Network First com fallback
  return networkFirst(request, DYNAMIC_CACHE)
}

// Cache First Strategy
async function cacheFirst(request, cacheName, ttl = null) {
  try {
    const cache = await caches.open(cacheName)
    const cached = await cache.match(request)
    
    if (cached) {
      // Verificar TTL se especificado
      if (ttl) {
        const cachedTime = cached.headers.get('sw-cached-time')
        if (cachedTime && (Date.now() - parseInt(cachedTime)) > ttl) {
          // Cache expirado, buscar da rede
          return networkFirst(request, cacheName, ttl)
        }
      }
      
      console.log(`💾 SW: Cache hit for ${request.url}`)
      return cached
    }
    
    // Não está em cache, buscar da rede
    return networkFirst(request, cacheName, ttl)
    
  } catch (error) {
    console.warn('❌ SW: Cache first failed:', error)
    return fetch(request)
  }
}

// Network First Strategy
async function networkFirst(request, cacheName, ttl = null) {
  try {
    // CORREÇÃO AMPLIADA: Configuração robusta para produção
    const fetchOptions = {
      redirect: 'follow',
      credentials: 'same-origin',
      mode: 'cors',
      cache: 'no-cache'
    }
    
    // Em produção, ser ainda mais permissivo
    if (self.location.hostname.includes('onrender.com') || 
        self.location.hostname.includes('render.com')) {
      fetchOptions.mode = 'same-origin'
      fetchOptions.credentials = 'include'
    }
    
    const response = await fetch(request, fetchOptions)
    
    // Aceitar redirects (3xx) como válidos também
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      // Clonar response para cache apenas se não for redirect
      if (response.ok) {
        const responseClone = response.clone()
        
        // Adicionar timestamp para TTL
        if (ttl) {
          const headers = new Headers(responseClone.headers)
          headers.set('sw-cached-time', Date.now().toString())
          
          const modifiedResponse = new Response(responseClone.body, {
            status: responseClone.status,
            statusText: responseClone.statusText,
            headers: headers
          })
          
          caches.open(cacheName).then(cache => {
            cache.put(request, modifiedResponse)
          }).catch(err => console.warn('SW: Cache put failed:', err))
        } else {
          caches.open(cacheName).then(cache => {
            cache.put(request, responseClone)
          }).catch(err => console.warn('SW: Cache put failed:', err))
        }
        
        console.log(`🌐 SW: Network response cached for ${request.url}`)
      }
    }
    
    return response
    
  } catch (error) {
    console.warn(`⚠️ SW: Network failed for ${request.url}, trying cache...`)
    
    // Network falhou, tentar cache
    const cache = await caches.open(cacheName)
    const cached = await cache.match(request)
    
    if (cached) {
      console.log(`💾 SW: Serving stale cache for ${request.url}`)
      return cached
    }
    
    // Retornar página offline para navegação
    if (request.destination === 'document') {
      return caches.match('/offline.html') || createOfflineResponse()
    }
    
    throw error
  }
}

// POST requests - Background Sync
async function handlePostRequest(request) {
  try {
    const response = await fetch(request)
    
    if (!response.ok && request.url.includes('/messages/send')) {
      // Falha ao enviar mensagem, registrar para background sync
      await registerBackgroundSync(request)
    }
    
    return response
    
  } catch (error) {
    console.warn('⚠️ SW: POST request failed, registering for background sync')
    
    // Registrar para background sync
    if (request.url.includes('/messages/send')) {
      await registerBackgroundSync(request)
      return new Response(JSON.stringify({ 
        success: false, 
        queued: true,
        message: 'Mensagem será enviada quando a conexão for restabelecida' 
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    throw error
  }
}

// Background Sync para mensagens offline
async function registerBackgroundSync(request) {
  try {
    const body = await request.clone().text()
    
    // Salvar no IndexedDB para retry posterior
    const db = await openIndexedDB()
    const tx = db.transaction(['pending_messages'], 'readwrite')
    const store = tx.objectStore('pending_messages')
    
    await store.add({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: body,
      timestamp: Date.now()
    })
    
    // Registrar background sync
    if ('serviceWorker' in navigator && 'sync' in window.ServiceWorkerRegistration.prototype) {
      await self.registration.sync.register('background-sync-messages')
    }
    
    console.log('📝 SW: Request queued for background sync')
    
  } catch (error) {
    console.error('❌ SW: Failed to register background sync:', error)
  }
}

// Background Sync Event
self.addEventListener('sync', event => {
  if (event.tag === 'background-sync-messages') {
    console.log('🔄 SW: Processing background sync...')
    event.waitUntil(processBackgroundSync())
  }
})

// Processar mensagens pendentes
async function processBackgroundSync() {
  try {
    const db = await openIndexedDB()
    const tx = db.transaction(['pending_messages'], 'readonly')
    const store = tx.objectStore('pending_messages')
    const messages = await store.getAll()
    
    console.log(`📤 SW: Processing ${messages.length} pending messages`)
    
    for (const message of messages) {
      try {
        const response = await fetch(message.url, {
          method: message.method,
          headers: message.headers,
          body: message.body
        })
        
        if (response.ok) {
          // Sucesso, remover da queue
          const deleteTx = db.transaction(['pending_messages'], 'readwrite')
          const deleteStore = deleteTx.objectStore('pending_messages')
          await deleteStore.delete(message.id)
          
          console.log('✅ SW: Message sent successfully')
          
          // Notificar cliente sobre sucesso
          notifyClients('message-sent', { messageId: message.id, success: true })
        }
      } catch (error) {
        console.warn('❌ SW: Failed to send queued message:', error)
      }
    }
    
  } catch (error) {
    console.error('❌ SW: Background sync failed:', error)
  }
}

// Push Notifications
self.addEventListener('push', event => {
  console.log('📬 SW: Push notification received')
  
  const data = event.data ? event.data.json() : {}
  const options = {
    body: data.message || 'Nova mensagem recebida',
    icon: '/icon-192x192.png',
    badge: '/icon-badge.png',
    tag: 'zapsan-message',
    data: data,
    actions: [
      { action: 'open', title: 'Abrir', icon: '/icon-open.png' },
      { action: 'close', title: 'Fechar', icon: '/icon-close.png' }
    ],
    requireInteraction: true,
    silent: false
  }
  
  event.waitUntil(
    self.registration.showNotification('ZapSan', options)
  )
})

// Notification Click
self.addEventListener('notificationclick', event => {
  event.notification.close()
  
  if (event.action === 'open') {
    event.waitUntil(
      clients.openWindow('/')
    )
  }
})

// Utility Functions
async function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zapsan-sw-db', 1)
    
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    
    request.onupgradeneeded = () => {
      const db = request.result
      
      if (!db.objectStoreNames.contains('pending_messages')) {
        const store = db.createObjectStore('pending_messages', { 
          keyPath: 'id', 
          autoIncrement: true 
        })
        store.createIndex('timestamp', 'timestamp', { unique: false })
      }
    }
  })
}

function createOfflineResponse() {
  return new Response(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Offline - ZapSan</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .offline { color: #666; }
          .retry { background: #25D366; color: white; padding: 10px 20px; border: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="offline">
          <h1>📵 Sem Conexão</h1>
          <p>Você está offline. Algumas funcionalidades podem estar limitadas.</p>
          <button class="retry" onclick="location.reload()">Tentar Novamente</button>
        </div>
      </body>
    </html>
  `, {
    headers: { 'Content-Type': 'text/html' }
  })
}

function notifyClients(type, data) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({ type, data })
    })
  })
}

console.log('🔄 SW: Service Worker loaded and ready!')