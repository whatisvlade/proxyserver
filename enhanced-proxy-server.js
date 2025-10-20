const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 37699;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===== ЗАЩИТА ОТ ДВОЙНОЙ РОТАЦИИ =====
const userRotationLocks = new Map();
const userLastRotation = new Map();
const ROTATION_COOLDOWN_MS = 6000; // 6 секунд защита от дублирования
const CLEANUP_INTERVAL_MS = 300000; // 5 минут - очистка старых записей

// Очистка старых записей каждые 5 минут
setInterval(() => {
  const now = Date.now();
  const cutoff = now - (ROTATION_COOLDOWN_MS * 2);
  
  for (const [user, timestamp] of userLastRotation.entries()) {
    if (timestamp < cutoff) {
      userLastRotation.delete(user);
      userRotationLocks.delete(user);
    }
  }
  
  console.log(`🧹 Cleanup: ${userLastRotation.size} users in rotation cache`);
}, CLEANUP_INTERVAL_MS);

// Функция проверки и установки блокировки ротации
function checkRotationCooldown(user) {
  const now = Date.now();
  const lastRotation = userLastRotation.get(user) || 0;
  const timeSinceLastRotation = now - lastRotation;
  
  if (timeSinceLastRotation < ROTATION_COOLDOWN_MS) {
    const remainingCooldown = ROTATION_COOLDOWN_MS - timeSinceLastRotation;
    return {
      allowed: false,
      remainingMs: remainingCooldown,
      message: `Rotation cooldown active. Wait ${Math.ceil(remainingCooldown / 1000)}s`
    };
  }
  
  // Проверяем, не заблокирован ли пользователь уже
  if (userRotationLocks.get(user)) {
    return {
      allowed: false,
      remainingMs: 1000,
      message: 'Rotation already in progress for this user'
    };
  }
  
  // Устанавливаем блокировку
  userRotationLocks.set(user, true);
  userLastRotation.set(user, now);
  
  return { allowed: true };
}

// Функция снятия блокировки ротации
function releaseRotationLock(user) {
  userRotationLocks.delete(user);
}

// ===== ДИНАМИЧЕСКОЕ УПРАВЛЕНИЕ ПРОКСИ =====
// Прокси загружаются из переменных окружения или внешнего API
let proxyList = [];
const userProxyIndex = new Map();
const userConnections = new Map();

// Загрузка прокси из переменных окружения
function loadProxiesFromEnv() {
  const proxiesEnv = process.env.PROXY_LIST;
  if (proxiesEnv) {
    try {
      proxyList = JSON.parse(proxiesEnv);
      console.log(`📋 Loaded ${proxyList.length} proxies from environment`);
      return true;
    } catch (error) {
      console.error('❌ Failed to parse PROXY_LIST from environment:', error.message);
    }
  }
  return false;
}

// Загрузка прокси из внешнего API (например, от Telegram бота)
async function loadProxiesFromAPI() {
  const apiUrl = process.env.PROXY_API_URL;
  const apiKey = process.env.PROXY_API_KEY;
  
  if (!apiUrl) {
    console.log('⚠️ PROXY_API_URL not configured, using empty proxy list');
    return false;
  }
  
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(apiUrl, {
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
      timeout: 10000
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    proxyList = Array.isArray(data) ? data : data.proxies || [];
    
    console.log(`📋 Loaded ${proxyList.length} proxies from API`);
    return true;
    
  } catch (error) {
    console.error('❌ Failed to load proxies from API:', error.message);
    return false;
  }
}

// Инициализация списка прокси
async function initializeProxies() {
  console.log('🔄 Initializing proxy list...');
  
  // Пробуем загрузить из переменных окружения
  if (loadProxiesFromEnv()) {
    return;
  }
  
  // Пробуем загрузить из API
  if (await loadProxiesFromAPI()) {
    return;
  }
  
  // Fallback - пустой список
  console.log('⚠️ No proxies loaded, server will work without proxy rotation');
  proxyList = [];
}

// Периодическое обновление списка прокси (каждые 5 минут)
setInterval(async () => {
  console.log('🔄 Refreshing proxy list...');
  await loadProxiesFromAPI();
}, 300000);

// API для добавления прокси (для Telegram бота)
app.post('/api/proxies', (req, res) => {
  const apiKey = req.headers['authorization']?.replace('Bearer ', '');
  const expectedKey = process.env.ADMIN_API_KEY;
  
  if (!expectedKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { action, proxy } = req.body;
  
  if (action === 'add' && proxy) {
    // Добавляем новый прокси
    if (!proxy.host || !proxy.port || !proxy.user || !proxy.pass) {
      return res.status(400).json({ error: 'Missing required proxy fields' });
    }
    
    proxyList.push(proxy);
    console.log(`➕ Added proxy: ${proxy.host}:${proxy.port}`);
    
    res.json({ 
      success: true, 
      message: 'Proxy added', 
      total: proxyList.length 
    });
    
  } else if (action === 'remove' && proxy) {
    // Удаляем прокси
    const index = proxyList.findIndex(p => 
      p.host === proxy.host && p.port === proxy.port
    );
    
    if (index !== -1) {
      const removed = proxyList.splice(index, 1)[0];
      console.log(`➖ Removed proxy: ${removed.host}:${removed.port}`);
      
      res.json({ 
        success: true, 
        message: 'Proxy removed', 
        total: proxyList.length 
      });
    } else {
      res.status(404).json({ error: 'Proxy not found' });
    }
    
  } else if (action === 'list') {
    // Возвращаем список прокси (без паролей)
    const safeList = proxyList.map(p => ({
      host: p.host,
      port: p.port,
      user: p.user
    }));
    
    res.json({ 
      success: true, 
      proxies: safeList, 
      total: proxyList.length 
    });
    
  } else if (action === 'clear') {
    // Очищаем весь список
    const count = proxyList.length;
    proxyList = [];
    console.log(`🗑️ Cleared all proxies (${count} removed)`);
    
    res.json({ 
      success: true, 
      message: `Cleared ${count} proxies` 
    });
    
  } else {
    res.status(400).json({ error: 'Invalid action or missing proxy data' });
  }
});

// Аутентификация
function authenticate(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }
  
  try {
    const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');
    
    if (username && password) {
      return username;
    }
  } catch (error) {
    console.error('Authentication error:', error.message);
  }
  
  return null;
}

// Получение текущего прокси для пользователя
function getCurrentProxy(user) {
  if (proxyList.length === 0) {
    return null;
  }
  
  const index = userProxyIndex.get(user) || 0;
  return proxyList[index % proxyList.length];
}

// Ротация прокси
function rotateProxy(user) {
  if (proxyList.length === 0) {
    throw new Error('No proxies available');
  }
  
  const currentIndex = userProxyIndex.get(user) || 0;
  const newIndex = (currentIndex + 1) % proxyList.length;
  userProxyIndex.set(user, newIndex);
  
  const oldProxy = proxyList[currentIndex % proxyList.length];
  const newProxy = proxyList[newIndex];
  
  console.log(`🔄 ROTATE ${user}: ${oldProxy.host}:${oldProxy.port} -> ${newProxy.host}:${newProxy.port} (#${newIndex + 1}/${proxyList.length}) [PROTECTED]`);
  
  return {
    old: oldProxy,
    new: newProxy,
    index: newIndex + 1,
    total: proxyList.length
  };
}

// ===== API ENDPOINTS =====

// Получение текущего прокси
app.get('/current', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const proxy = getCurrentProxy(user);
  if (!proxy) {
    return res.status(503).json({ 
      error: 'No proxies available',
      message: 'Proxy list is empty. Add proxies via API or environment variables.'
    });
  }
  
  const connections = userConnections.get(user) || [];
  
  console.log(`[SELF-API] GET /current Host:${req.get('host')} User:${user}`);
  
  res.json({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      user: proxy.user
    },
    index: (userProxyIndex.get(user) || 0) + 1,
    total: proxyList.length,
    connections: connections.length,
    timestamp: new Date().toISOString()
  });
});

// Ротация прокси с защитой от дублирования
app.post('/rotate', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log(`[SELF-API] POST /rotate Host:${req.get('host')} User:${user}`);
  
  // Проверяем наличие прокси
  if (proxyList.length === 0) {
    return res.status(503).json({
      error: 'No proxies available',
      message: 'Proxy list is empty. Add proxies via API or environment variables.'
    });
  }
  
  // Проверяем кулдаун ротации
  const cooldownCheck = checkRotationCooldown(user);
  if (!cooldownCheck.allowed) {
    console.log(`⛔ ROTATION BLOCKED for ${user}: ${cooldownCheck.message}`);
    return res.status(429).json({
      error: 'Rotation cooldown active',
      message: cooldownCheck.message,
      remainingMs: cooldownCheck.remainingMs,
      cooldownSeconds: Math.ceil(cooldownCheck.remainingMs / 1000)
    });
  }
  
  try {
    const rotation = rotateProxy(user);
    
    // Имитируем небольшую задержку для реалистичности
    setTimeout(() => {
      releaseRotationLock(user);
    }, 1000);
    
    res.json({
      success: true,
      rotation: {
        from: `${rotation.old.host}:${rotation.old.port}`,
        to: `${rotation.new.host}:${rotation.new.port}`,
        index: rotation.index,
        total: rotation.total
      },
      proxy: {
        host: rotation.new.host,
        port: rotation.new.port,
        user: rotation.new.user
      },
      timestamp: new Date().toISOString(),
      cooldownMs: ROTATION_COOLDOWN_MS
    });
    
  } catch (error) {
    releaseRotationLock(user);
    console.error(`❌ Rotation error for ${user}:`, error.message);
    res.status(500).json({ 
      error: 'Rotation failed', 
      message: error.message 
    });
  }
});

// Статус сервера
app.get('/status', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const proxy = getCurrentProxy(user);
  const connections = userConnections.get(user) || [];
  const lastRotation = userLastRotation.get(user);
  const rotationLocked = userRotationLocks.get(user) || false;
  
  res.json({
    status: 'online',
    user: user,
    proxy: proxy ? {
      host: proxy.host,
      port: proxy.port,
      user: proxy.user,
      index: (userProxyIndex.get(user) || 0) + 1,
      total: proxyList.length
    } : null,
    connections: connections.length,
    rotation: {
      locked: rotationLocked,
      lastRotation: lastRotation ? new Date(lastRotation).toISOString() : null,
      cooldownMs: ROTATION_COOLDOWN_MS,
      canRotate: lastRotation ? (Date.now() - lastRotation >= ROTATION_COOLDOWN_MS) : true
    },
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeUsers: userLastRotation.size,
      totalProxies: proxyList.length
    },
    timestamp: new Date().toISOString()
  });
});

// Сброс кулдауна (для отладки)
app.post('/reset-cooldown', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  userLastRotation.delete(user);
  userRotationLocks.delete(user);
  
  console.log(`🔄 Cooldown reset for user: ${user}`);
  
  res.json({
    success: true,
    message: 'Rotation cooldown reset',
    user: user,
    timestamp: new Date().toISOString()
  });
});

// ===== PROXY MIDDLEWARE =====
const proxyMiddleware = createProxyMiddleware({
  target: 'http://example.com', // Будет переопределен в router
  changeOrigin: true,
  followRedirects: true,
  secure: false,
  timeout: 30000,
  proxyTimeout: 30000,
  
  router: (req) => {
    const user = authenticate(req.headers['authorization']);
    if (!user) return 'http://example.com';
    
    const proxy = getCurrentProxy(user);
    if (!proxy) return 'http://example.com';
    
    const target = `http://${proxy.host}:${proxy.port}`;
    
    // Логируем подключения
    const connections = userConnections.get(user) || [];
    const connectionInfo = {
      target: target,
      url: req.url,
      method: req.method,
      timestamp: Date.now(),
      userAgent: req.get('user-agent') || 'unknown'
    };
    
    connections.push(connectionInfo);
    
    // Ограничиваем количество сохраняемых подключений
    if (connections.length > 100) {
      connections.splice(0, connections.length - 100);
    }
    
    userConnections.set(user, connections);
    
    console.log(`🌐 PROXY ${user}: ${req.method} ${req.url} -> ${target}`);
    
    return target;
  },
  
  onProxyReq: (proxyReq, req, res) => {
    const user = authenticate(req.headers['authorization']);
    if (user) {
      const proxy = getCurrentProxy(user);
      if (proxy) {
        const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
        proxyReq.setHeader('Proxy-Authorization', `Basic ${auth}`);
      }
    }
  },
  
  onError: (err, req, res) => {
    const user = authenticate(req.headers['authorization']) || 'unknown';
    console.error(`❌ PROXY ERROR for ${user}:`, err.message);
    
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Proxy error',
        message: err.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

// Применяем прокси middleware ко всем остальным запросам
app.use('/', (req, res, next) => {
  // Пропускаем API endpoints
  if (req.path.startsWith('/current') || 
      req.path.startsWith('/rotate') || 
      req.path.startsWith('/status') ||
      req.path.startsWith('/reset-cooldown') ||
      req.path.startsWith('/api/')) {
    return next();
  }
  
  // Применяем прокси
  proxyMiddleware(req, res, next);
});

// ===== ERROR HANDLING =====
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ===== SERVER START =====
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Dynamic proxy server started on port ${PORT}`);
  console.log(`🔒 Rotation cooldown: ${ROTATION_COOLDOWN_MS / 1000} seconds`);
  
  // Инициализируем список прокси
  await initializeProxies();
  
  console.log(`📊 Available proxies: ${proxyList.length}`);
  console.log(`🌐 Server ready to accept connections`);
  
  if (process.env.ADMIN_API_KEY) {
    console.log(`🔑 Admin API enabled for proxy management`);
  } else {
    console.log(`⚠️ ADMIN_API_KEY not set - proxy management API disabled`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

module.exports = app;
