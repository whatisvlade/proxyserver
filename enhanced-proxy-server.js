// app.js — Railway Proxy + Telegram Bot Management (ULTRA OPTIMIZED)
const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const cluster = require('cluster');
const os = require('os');

const app = express();

// ====== КРИТИЧЕСКИЕ ОПТИМИЗАЦИИ ДЛЯ СКОРОСТИ ======

// 1. Уменьшаем лимиты для JSON/URL парсинга (было 50mb!)
app.use(express.json({ limit: '1mb' })); // Уменьшено с 50mb
app.use(express.urlencoded({ limit: '1mb', extended: true })); // Уменьшено с 50mb

// 2. Отключаем ненужные заголовки Express
app.disable('x-powered-by');
app.disable('etag');

// 3. Кэш для часто используемых операций
const authCache = new Map();
const proxyParseCache = new Map();
const urlParseCache = new Map();

// Очистка кэша каждые 5 минут
setInterval(() => {
  if (authCache.size > 1000) authCache.clear();
  if (proxyParseCache.size > 500) proxyParseCache.clear();
  if (urlParseCache.size > 1000) urlParseCache.clear();
}, 300000);

// ====== ОПТИМИЗИРОВАННАЯ КОНФИГУРАЦИЯ ======
const CONFIG_FILE = path.join(__dirname, 'clients-config.json');
let clientsConfig = {};

// Структуры данных
let users = {};
let clientProxies = {};
let allProxySets = {};
let currentProxies = {};
let rotationCounters = {};
const lastRotationTime = new Map();
const activeTunnels = {};
const blockedProxies = new Set();

// ====== ФУНКЦИИ УПРАВЛЕНИЯ КОНФИГУРАЦИЕЙ (БЕЗ ИЗМЕНЕНИЙ) ======
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    clientsConfig = JSON.parse(data);
    console.log('✅ Configuration loaded from file');
  } catch (error) {
    console.log('📝 Using empty configuration, creating config file...');
    await saveConfig();
  }
}

async function saveConfig() {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(clientsConfig, null, 2));
    console.log('💾 Configuration saved to file');
  } catch (error) {
    console.error('❌ Failed to save configuration:', error.message);
  }
}

function initializeClients() {
  users = {};
  clientProxies = {};
  allProxySets = {};
  currentProxies = {};
  rotationCounters = {};

  Object.keys(clientsConfig).forEach(clientName => {
    const config = clientsConfig[clientName];
    users[clientName] = config.password;
    clientProxies[clientName] = [...config.proxies];
    allProxySets[clientName] = new Set(config.proxies);
    currentProxies[clientName] = [...config.proxies];
    rotationCounters[clientName] = rotationCounters[clientName] || 0;
    activeTunnels[clientName] = activeTunnels[clientName] || new Set();

    console.log(`✅ Initialized client: ${clientName} with ${config.proxies.length} proxies`);
  });

  checkProxyOverlaps();
}

function checkProxyOverlaps() {
  const clientNames = Object.keys(clientsConfig);
  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));

      if (intersection.length > 0) {
        console.warn(`⚠️ WARNING: Overlapping proxies between ${client1Name} and ${client2Name}: ${intersection.map(p => p.split('@')[1]).join(', ')}`);
      }
    }
  }
}

// ====== ОПТИМИЗИРОВАННЫЕ ФУНКЦИИ ======

// Кэшированная аутентификация
function authenticate(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;

  // Проверяем кэш
  if (authCache.has(authHeader)) {
    return authCache.get(authHeader);
  }

  try {
    const [u, p] = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const result = users[u] === p ? u : null;

    // Кэшируем результат
    authCache.set(authHeader, result);
    return result;
  } catch { 
    return null; 
  }
}

// Кэшированный парсинг прокси
function parseProxyUrl(proxyUrl) {
  if (proxyParseCache.has(proxyUrl)) {
    return proxyParseCache.get(proxyUrl);
  }

  try {
    const u = new URL(proxyUrl);
    const result = { 
      host: u.hostname, 
      port: +u.port, 
      username: u.username, 
      password: u.password 
    };
    proxyParseCache.set(proxyUrl, result);
    return result;
  } catch { 
    proxyParseCache.set(proxyUrl, null);
    return null; 
  }
}

function getCurrentProxy(username) {
  const list = currentProxies[username];
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    if (!blockedProxies.has(list[i])) return list[i];
  }
  return list[0] || null;
}

// Оптимизированная ротация (убрали задержку!)
async function rotateProxy(username) {
  lastRotationTime.set(username, Date.now());

  const list = currentProxies[username];
  if (!list || list.length <= 1) return getCurrentProxy(username);

  const oldProxy = list.shift();
  list.push(oldProxy);
  rotationCounters[username]++;

  // Пропускаем заблокированные прокси
  let attempts = 0;
  while (blockedProxies.has(list[0]) && attempts < list.length) {
    const blocked = list.shift();
    list.push(blocked);
    attempts++;
  }

  // УБРАЛИ ЗАДЕРЖКУ 300ms - это замедляло соединения!
  // await new Promise(resolve => setTimeout(resolve, 300)); 

  const newProxy = list[0];
  console.log(`🔄 ROTATE ${username}: ${oldProxy.split('@')[1]} -> ${newProxy.split('@')[1]} (#${rotationCounters[username]}) [INSTANT]`);
  return newProxy;
}

function closeUserTunnels(username) {
  const set = activeTunnels[username];
  if (!set) return 0;
  let n = 0;
  for (const pair of set) {
    try { pair.clientSocket.destroy(); } catch {}
    try { pair.proxySocket.destroy(); } catch {}
    n++;
  }
  set.clear();
  return n;
}

// ====== УЛЬТРА-ОПТИМИЗИРОВАННЫЕ АГЕНТЫ ======
const upstreamAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1000,        // Увеличено еще больше
  maxFreeSockets: 200,     // Увеличено еще больше
  timeout: 30000,          // Уменьшено с 45000
  keepAliveMsecs: 5000,    // Уменьшено с 8000 для быстрого переиспользования
  maxTotalSockets: 2000,   // Увеличено
  scheduling: 'fifo'       // FIFO для лучшей производительности
});

const upstreamHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1000,
  maxFreeSockets: 200,
  timeout: 30000,
  keepAliveMsecs: 5000,
  maxTotalSockets: 2000,
  scheduling: 'fifo'
});

// ====== API ENDPOINTS (ОПТИМИЗИРОВАННЫЕ) ======

// Убираем медленный заголовок Connection: close
// app.use((req, res, next) => { res.setHeader('Connection', 'close'); next(); });

// Быстрая проверка self-API запросов
const PUBLIC_HOST = (process.env.PUBLIC_HOST || 'yamabiko.proxy.rlwy.net:38659').toLowerCase();
const EXTRA_HOSTS = (process.env.EXTRA_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const SELF_HOSTNAMES = new Set([
  PUBLIC_HOST.split(':')[0],
  ...EXTRA_HOSTS.map(h => h.split(':')[0]),
  ...(process.env.RAILWAY_STATIC_URL ? [String(process.env.RAILWAY_STATIC_URL).toLowerCase().split(':')[0]] : []),
  ...(process.env.RAILWAY_PUBLIC_DOMAIN ? [String(process.env.RAILWAY_PUBLIC_DOMAIN).toLowerCase().split(':')[0]] : [])
].filter(Boolean));

function isSelfApiRequest(req) {
  try {
    // Быстрая проверка по URL
    const url = req.url || '';
    if (url.startsWith('/api/') || url.startsWith('/health') || 
        url === '/' || url.startsWith('/status') || url.startsWith('/current') || 
        url.startsWith('/rotate') || url.startsWith('/myip')) {

      const hostHeader = (req.headers.host || '').toLowerCase();
      const onlyHost = hostHeader.split(':')[0];
      return SELF_HOSTNAMES.has(onlyHost);
    }

    // Полная проверка только если нужно
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (urlParseCache.has(url)) {
        const cached = urlParseCache.get(url);
        return cached && SELF_HOSTNAMES.has(cached.hostname);
      }

      const u = new URL(url);
      urlParseCache.set(url, u);
      if (SELF_HOSTNAMES.has(u.hostname.toLowerCase())) {
        const p = u.pathname;
        return p === '/' || p.startsWith('/status') || p.startsWith('/current') || 
               p.startsWith('/rotate') || p.startsWith('/block') || p.startsWith('/unblock') || 
               p.startsWith('/blocked') || p.startsWith('/myip') || p.startsWith('/api/') || 
               p.startsWith('/health');
      }
    }
  } catch {}
  return false;
}

// ====== API ROUTES (БЕЗ ИЗМЕНЕНИЙ ЛОГИКИ) ======
app.get('/api/clients', (req, res) => {
  const clients = {};
  Object.keys(clientsConfig).forEach(clientName => {
    clients[clientName] = {
      totalProxies: clientProxies[clientName]?.length || 0,
      currentProxy: getCurrentProxy(clientName)?.split('@')[1],
      rotationCount: rotationCounters[clientName] || 0,
      activeTunnels: activeTunnels[clientName]?.size || 0,
      proxies: clientsConfig[clientName].proxies.map(p => p.split('@')[1])
    };
  });

  res.json({
    success: true,
    clients,
    totalClients: Object.keys(clients).length
  });
});

app.post('/api/add-client', async (req, res) => {
  const { clientName, password, proxies } = req.body;

  if (!clientName || !password) {
    return res.status(400).json({ error: 'clientName and password are required' });
  }

  if (clientsConfig[clientName]) {
    return res.status(409).json({ error: 'Client already exists' });
  }

  clientsConfig[clientName] = {
    password,
    proxies: proxies || []
  };

  await saveConfig();
  initializeClients();

  console.log(`➕ Added new client: ${clientName} with ${proxies?.length || 0} proxies`);

  res.json({
    success: true,
    message: `Client ${clientName} added successfully`,
    client: {
      name: clientName,
      totalProxies: proxies?.length || 0
    }
  });
});

app.delete('/api/delete-client/:clientName', async (req, res) => {
  const { clientName } = req.params;

  if (!clientsConfig[clientName]) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const killed = closeUserTunnels(clientName);

  delete clientsConfig[clientName];
  await saveConfig();
  initializeClients();

  console.log(`🗑 Deleted client: ${clientName}, closed ${killed} tunnels`);

  res.json({
    success: true,
    message: `Client ${clientName} deleted successfully`,
    closedTunnels: killed
  });
});

app.delete('/api/remove-client/:clientName', async (req, res) => {
  const { clientName } = req.params;

  if (!clientsConfig[clientName]) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const killed = closeUserTunnels(clientName);

  delete clientsConfig[clientName];
  await saveConfig();
  initializeClients();

  console.log(`➖ Removed client: ${clientName}, closed ${killed} tunnels`);

  res.json({
    success: true,
    message: `Client ${clientName} removed successfully`,
    closedTunnels: killed
  });
});

app.post('/api/add-proxy', async (req, res) => {
  const { clientName, proxy } = req.body;

  if (!clientName || !proxy) {
    return res.status(400).json({ error: 'clientName and proxy are required' });
  }

  if (!clientsConfig[clientName]) {
    return res.status(404).json({ error: 'Client not found' });
  }

  if (!proxy.startsWith('http://') || !proxy.includes('@')) {
    return res.status(400).json({ error: 'Invalid proxy format. Use: http://user:pass@host:port' });
  }

  if (clientsConfig[clientName].proxies.includes(proxy)) {
    return res.status(409).json({ error: 'Proxy already exists for this client' });
  }

  clientsConfig[clientName].proxies.push(proxy);
  await saveConfig();
  initializeClients();

  console.log(`➕ Added proxy to ${clientName}: ${proxy.split('@')[1]}`);

  res.json({
    success: true,
    message: `Proxy added to ${clientName}`,
    proxy: proxy.split('@')[1],
    totalProxies: clientsConfig[clientName].proxies.length
  });
});

app.delete('/api/remove-proxy', async (req, res) => {
  const { clientName, proxy } = req.body;

  if (!clientName || !proxy) {
    return res.status(400).json({ error: 'clientName and proxy are required' });
  }

  if (!clientsConfig[clientName]) {
    return res.status(404).json({ error: 'Client not found' });
  }

  let proxyToRemove = null;
  if (proxy.startsWith('http://')) {
    proxyToRemove = proxy;
  } else {
    proxyToRemove = clientsConfig[clientName].proxies.find(p => p.includes(proxy));
  }

  if (!proxyToRemove) {
    return res.status(404).json({ error: 'Proxy not found for this client' });
  }

  clientsConfig[clientName].proxies = clientsConfig[clientName].proxies.filter(p => p !== proxyToRemove);
  await saveConfig();
  initializeClients();

  console.log(`➖ Removed proxy from ${clientName}: ${proxyToRemove.split('@')[1]}`);

  res.json({
    success: true,
    message: `Proxy removed from ${clientName}`,
    proxy: proxyToRemove.split('@')[1],
    totalProxies: clientsConfig[clientName].proxies.length
  });
});

app.post('/api/rotate-client', async (req, res) => {
  const { clientName } = req.body;

  if (!clientName) {
    return res.status(400).json({ error: 'clientName is required' });
  }

  if (!clientsConfig[clientName]) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const oldProxy = getCurrentProxy(clientName);
  const newProxy = await rotateProxy(clientName);
  const killed = closeUserTunnels(clientName);

  console.log(`[API] Telegram rotate client=${clientName} killed=${killed} ${oldProxy?.split('@')[1]} -> ${newProxy?.split('@')[1]}`);

  res.json({
    success: true,
    message: `Proxy rotated for ${clientName}`,
    oldProxy: oldProxy?.split('@')[1],
    newProxy: newProxy?.split('@')[1],
    rotationCount: rotationCounters[clientName],
    closedTunnels: killed
  });
});

// ====== МОНИТОРИНГ API ======
app.get('/health-detailed', (req, res) => {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  res.json({
    status: 'healthy',
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(memUsage.external / 1024 / 1024) + 'MB',
      arrayBuffers: Math.round(memUsage.arrayBuffers / 1024 / 1024) + 'MB'
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system
    },
    uptime: Math.round(process.uptime()),
    clients: Object.keys(clientsConfig).length,
    totalProxies: Object.values(clientsConfig).reduce((sum, client) => sum + client.proxies.length, 0),
    activeTunnels: Object.values(activeTunnels).reduce((sum, set) => sum + set.size, 0),
    blockedProxies: blockedProxies.size,
    cacheStats: {
      authCache: authCache.size,
      proxyParseCache: proxyParseCache.size,
      urlParseCache: urlParseCache.size
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    server: {
      uptime: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      totalClients: Object.keys(clientsConfig).length,
      totalProxies: Object.values(clientsConfig).reduce((sum, client) => sum + client.proxies.length, 0),
      totalActiveTunnels: Object.values(activeTunnels).reduce((sum, set) => sum + set.size, 0),
      blockedProxies: blockedProxies.size,
      cacheHitRatio: {
        auth: authCache.size,
        proxyParse: proxyParseCache.size,
        urlParse: urlParseCache.size
      }
    },
    clients: {}
  };

  Object.keys(clientsConfig).forEach(clientName => {
    stats.clients[clientName] = {
      totalProxies: clientProxies[clientName]?.length || 0,
      currentProxy: getCurrentProxy(clientName)?.split('@')[1],
      rotationCount: rotationCounters[clientName] || 0,
      activeTunnels: activeTunnels[clientName]?.size || 0,
      lastRotation: lastRotationTime.get(clientName) || 0
    };
  });

  res.json(stats);
});

// ====== ОРИГИНАЛЬНЫЕ API ENDPOINTS (ОПТИМИЗИРОВАННЫЕ) ======
app.post('/rotate', async (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const oldProxy = getCurrentProxy(user);
  const newProxy = await rotateProxy(user);
  const killed = closeUserTunnels(user);

  console.log(`[API] POST /rotate user=${user} killed=${killed} ${oldProxy?.split('@')[1]} -> ${newProxy?.split('@')[1]} [INSTANT]`);

  res.json({
    success: true,
    message: 'Proxy rotated (instant mode)',
    oldProxy: oldProxy?.split('@')[1],
    newProxy: newProxy?.split('@')[1],
    rotationCount: rotationCounters[user],
    totalProxies: currentProxies[user].length,
    blockedProxies: blockedProxies.size,
    closedTunnels: killed,
    instantMode: true,
    rotationTime: Date.now() - (lastRotationTime.get(user) || Date.now())
  });
});

app.get('/current', (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const cur = getCurrentProxy(user);
  console.log(`[API] GET /current user=${user} -> ${cur?.split('@')[1]}`);

  res.json({
    user,
    currentProxy: cur?.split('@')[1],
    fullProxy: cur,
    totalProxies: currentProxies[user].length,
    rotationCount: rotationCounters[user],
    activeTunnels: activeTunnels[user].size,
    blockedProxies: blockedProxies.size,
    instantMode: true,
    lastRotation: lastRotationTime.get(user) || 0
  });
});

// Оптимизированный /myip endpoint
app.get('/myip', async (req, res) => {
  const user = authenticate(req.headers['authorization']);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const proxyUrl = getCurrentProxy(user);
  if (!proxyUrl) return res.status(502).json({ error: 'No proxy available' });

  const up = parseProxyUrl(proxyUrl);
  if (!up) return res.status(502).json({ error: 'Invalid proxy config' });

  console.log(`[API] GET /myip user=${user} via ${up.host}:${up.port}`);

  // Более быстрые IP сервисы
  const ipServices = [
    { url: 'http://ifconfig.me/ip', type: 'text' },
    { url: 'http://icanhazip.com', type: 'text' },
    { url: 'http://ident.me', type: 'text' },
    { url: 'http://api.ipify.org?format=json', type: 'json' },
    { url: 'http://checkip.amazonaws.com', type: 'text' }
  ];

  function fetchViaProxy(service) {
    return new Promise((resolve, reject) => {
      const serviceUrlObj = new URL(service.url);
      const proxyOptions = {
        hostname: up.host,
        port: up.port,
        path: service.url,
        method: 'GET',
        headers: {
          'Proxy-Authorization': `Basic ${Buffer.from(`${up.username}:${up.password}`).toString('base64')}`,
          'Host': serviceUrlObj.hostname,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        agent: upstreamAgent,
        timeout: 10000 // Уменьшено с 15000ms
      };

      const proxyReq = http.request(proxyOptions, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            let ip = null;
            if (service.type === 'json') {
              try { ip = JSON.parse(data).ip; } catch {}
            }
            if (!ip) {
              ip = data.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ||
                   data.match(/(?:[0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}/)?.[0] ||
                   data.trim();
            }
            if (ip && /^[\d.:]+$/.test(ip)) return resolve({ ip, service: service.url });
            return reject(new Error('Bad IP parse'));
          } else {
            return reject(new Error(`HTTP ${proxyRes.statusCode}`));
          }
        });
      });

      proxyReq.on('socket', s => { 
        try { 
          s.setNoDelay(true); 
          s.setKeepAlive(true, 5000); // Уменьшено
        } catch {} 
      });
      proxyReq.on('timeout', () => proxyReq.destroy(new Error('Timeout')));
      proxyReq.on('error', reject);
      proxyReq.end();
    });
  }

  try {
    const result = await Promise.any(ipServices.map(fetchViaProxy));
    console.log(`[API] /myip result for ${user}: ${result.ip} via ${result.service}`);
    return res.json({ ip: result.ip, proxy: `${up.host}:${up.port}`, service: result.service });
  } catch (err) {
    console.error(`[API] /myip all services failed for ${user}: ${err?.message}`);
    return res.status(502).json({ error: 'Failed to get IP from all services', lastError: err?.message });
  }
});

app.get('/status', (req, res) => {
  let totalOverlapping = 0;
  const overlappingList = [];
  const clientNames = Object.keys(clientsConfig);

  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
      totalOverlapping += intersection.length;
      overlappingList.push(...intersection.map(p => p.split('@')[1]));
    }
  }

  const clients = {};
  Object.keys(clientsConfig).forEach(clientName => {
    clients[clientName] = {
      totalProxies: clientProxies[clientName]?.length || 0,
      currentProxy: getCurrentProxy(clientName)?.split('@')[1],
      rotationCount: rotationCounters[clientName] || 0,
      activeTunnels: activeTunnels[clientName]?.size || 0,
      lastRotation: lastRotationTime.get(clientName) || 0
    };
  });

  const memUsage = process.memoryUsage();

  res.json({
    status: 'running',
    platform: 'Railway TCP Proxy - ULTRA OPTIMIZED (No Delays)',
    port: PORT,
    publicHost: PUBLIC_HOST,
    selfHostnames: [...SELF_HOSTNAMES],
    totalBlockedProxies: blockedProxies.size,
    instantMode: true,
    telegramBotEnabled: true,
    optimizedFor: '32GB RAM - Ultra High Load',
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    cacheStats: {
      authCache: authCache.size,
      proxyParseCache: proxyParseCache.size,
      urlParseCache: urlParseCache.size
    },
    proxyIsolation: {
      overlappingProxies: totalOverlapping,
      overlappingList: [...new Set(overlappingList)],
      fullyIsolated: totalOverlapping === 0
    },
    clients,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  let totalOverlapping = 0;
  const clientNames = Object.keys(clientsConfig);

  for (let i = 0; i < clientNames.length; i++) {
    for (let j = i + 1; j < clientNames.length; j++) {
      const client1Name = clientNames[i];
      const client2Name = clientNames[j];
      const client1Set = allProxySets[client1Name];
      const client2Set = allProxySets[client2Name];
      const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
      totalOverlapping += intersection.length;
    }
  }

  const authInfo = Object.keys(clientsConfig).length > 0 
    ? Object.keys(clientsConfig).map(clientName => 
        `${clientName}/${clientsConfig[clientName].password}`
      ).join(' или ')
    : 'No clients configured - use Telegram bot to add clients';

  const memUsage = process.memoryUsage();

  res.send(`
    <h1>🚀 Railway Proxy Rotator - ULTRA OPTIMIZED (No Delays)</h1>
    <pre>
Public host: ${PUBLIC_HOST}
Known hostnames: ${[...SELF_HOSTNAMES].join(', ')}

Auth: Basic (${authInfo})

⚡ ULTRA Performance Features:
- Instant rotation (no 300ms delay)
- Cached authentication & proxy parsing
- Optimized HTTP agents (1000+ sockets)
- Reduced timeouts for faster responses
- FIFO scheduling for better throughput
- Memory-efficient caching with auto-cleanup

📊 Current Status:
- Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB / 32GB
- Uptime: ${Math.round(process.uptime())}s
- Active tunnels: ${Object.values(activeTunnels).reduce((sum, set) => sum + set.size, 0)}
- Cache hits: Auth(${authCache.size}) Proxy(${proxyParseCache.size}) URL(${urlParseCache.size})
    </pre>
    <h2>Original API:</h2>
    <ul>
      <li>GET /status - server status</li>
      <li>GET /current (requires Basic) - current proxy</li>
      <li>GET /myip (requires Basic) - get IP via proxy (faster)</li>
      <li>POST /rotate (requires Basic) - instant rotate proxy</li>
    </ul>
    <h2>Telegram Bot API:</h2>
    <ul>
      <li>GET /api/clients - list all clients</li>
      <li>POST /api/add-client - add new client</li>
      <li>DELETE /api/delete-client/:name - delete client</li>
      <li>DELETE /api/remove-client/:name - remove client (alias)</li>
      <li>POST /api/add-proxy - add proxy to client</li>
      <li>DELETE /api/remove-proxy - remove proxy from client</li>
      <li>POST /api/rotate-client - instant rotate proxy for client</li>
    </ul>
    <h2>Monitoring API:</h2>
    <ul>
      <li>GET /health-detailed - detailed health check with cache stats</li>
      <li>GET /api/stats - comprehensive statistics</li>
    </ul>
    <p>Total clients: ${Object.keys(clientsConfig).length}</p>
    <p>Overlapping proxies: ${totalOverlapping}</p>
    <p>Blocked proxies: ${blockedProxies.size}</p>
    <p>Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB</p>
    <p><strong>🔥 ULTRA OPTIMIZED - No rotation delays, cached operations</strong></p>
  `);
});

// ====== УЛЬТРА-ОПТИМИЗИРОВАННЫЙ ПРОКСИ СЕРВЕР ======
const server = http.createServer();

// Максимальные лимиты для высокой нагрузки
server.maxConnections = 5000; // Увеличено еще больше
server.timeout = 45000;       // Уменьшено с 60000
server.keepAliveTimeout = 20000; // Уменьшено с 30000
server.headersTimeout = 25000;   // Уменьшено с 35000

// Оптимизированный HTTP прокси
async function handleHttpProxy(req, res, user) {
  const up = parseProxyUrl(getCurrentProxy(user));
  if (!up) { 
    res.writeHead(502); 
    return res.end('502 No upstream'); 
  }

  console.log(`HTTP: ${user} -> ${up.host}:${up.port} -> ${req.url}`);

  const options = {
    hostname: up.host,
    port: up.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'Proxy-Authorization': `Basic ${Buffer.from(`${up.username}:${up.password}`).toString('base64')}`,
    },
    agent: req.url.startsWith('https://') ? upstreamHttpsAgent : upstreamAgent,
    timeout: 25000 // Уменьшено с 40000ms
  };
  delete options.headers['proxy-authorization'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('socket', s => { 
    try { 
      s.setNoDelay(true); 
      s.setKeepAlive(true, 5000); // Уменьшено с 8000ms
      s.setTimeout(25000);        // Уменьшено с 40000ms
    } catch {} 
  });
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('Upstream timeout')));
  proxyReq.on('error', (err) => {
    console.error(`HTTP upstream error (${user}):`, err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('502 Bad Gateway - Proxy error');
  });

  req.pipe(proxyReq);
}

server.on('request', (req, res) => {
  if (isSelfApiRequest(req)) {
    const host = req.headers.host || '(no-host)';
    console.log(`[SELF-API] ${req.method} ${req.url} Host:${host}`);
    return app(req, res);
  }

  const user = authenticate(req.headers['proxy-authorization']);
  if (!user) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Proxy"' });
    return res.end('407 Proxy Authentication Required');
  }

  handleHttpProxy(req, res, user);
});

// Оптимизированный CONNECT handler
function tryConnect(req, clientSocket, user) {
  const up = parseProxyUrl(getCurrentProxy(user));
  if (!up) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    return clientSocket.end();
  }

  console.log(`CONNECT: ${user} -> ${up.host}:${up.port} -> ${req.url}`);
  const proxySocket = net.createConnection(up.port, up.host);

  const pair = { clientSocket, proxySocket };
  activeTunnels[user]?.add(pair);

  const cleanup = () => activeTunnels[user]?.delete(pair);
  proxySocket.on('close', cleanup);
  clientSocket.on('close', cleanup);

  try { 
    proxySocket.setNoDelay(true); 
    proxySocket.setKeepAlive(true, 5000); // Уменьшено с 8000ms
  } catch {}
  try { 
    clientSocket.setNoDelay(true); 
    clientSocket.setKeepAlive(true, 5000); // Уменьшено с 8000ms
  } catch {}

  proxySocket.setTimeout(25000, () => proxySocket.destroy(new Error('upstream timeout'))); // Уменьшено с 40000ms
  clientSocket.setTimeout(25000, () => clientSocket.destroy(new Error('client timeout'))); // Уменьшено с 40000ms

  proxySocket.on('connect', () => {
    const auth = Buffer.from(`${up.username}:${up.password}`).toString('base64');
    const connectReq =
      `CONNECT ${req.url} HTTP/1.1\r\n` +
      `Host: ${req.url}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      `Proxy-Connection: keep-alive\r\n` +
      `Connection: keep-alive\r\n\r\n`;
    proxySocket.write(connectReq);
  });

  let established = false;
  proxySocket.on('data', (data) => {
    if (!established) {
      const line = data.toString('utf8').split('\r\n')[0];
      if (/^HTTP\/1\.[01]\s+200/i.test(line)) {
        established = true;
        try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch {}
        clientSocket.pipe(proxySocket);
        proxySocket.pipe(clientSocket);
      } else {
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        clientSocket.end();
        proxySocket.end();
      }
    }
  });

  proxySocket.on('error', (err) => {
    console.error(`CONNECT upstream error (${user}):`, err.message);
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    clientSocket.end();
  });

  clientSocket.on('error', () => { try { proxySocket.destroy(); } catch {} });
}

server.on('connect', (req, clientSocket) => {
  const user = authenticate(req.headers['proxy-authorization']);
  if (!user) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n');
    return clientSocket.end();
  }
  tryConnect(req, clientSocket, user);
});

// ====== ЗАПУСК ======
const PORT = process.env.PORT || process.env.RAILWAY_PORT || 8080;

async function startServer() {
  await loadConfig();
  initializeClients();

  server.listen(PORT, '0.0.0.0', () => {
    let totalOverlapping = 0;
    const clientNames = Object.keys(clientsConfig);

    for (let i = 0; i < clientNames.length; i++) {
      for (let j = i + 1; j < clientNames.length; j++) {
        const client1Name = clientNames[i];
        const client2Name = clientNames[j];
        const client1Set = allProxySets[client1Name];
        const client2Set = allProxySets[client2Name];
        const intersection = clientProxies[client1Name].filter(p => client2Set.has(p));
        totalOverlapping += intersection.length;
      }
    }

    const memUsage = process.memoryUsage();

    console.log(`🚀 ULTRA OPTIMIZED Proxy server running on port ${PORT} (32GB RAM)`);
    console.log(`🌐 Public (TCP Proxy): ${PUBLIC_HOST}`);
    console.log(`✅ API self hostnames: ${[...SELF_HOSTNAMES].join(', ')}`);
    console.log(`🤖 Telegram Bot API enabled`);
    console.log(`💾 Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB / 32GB available`);
    console.log(`🔧 Max connections: ${server.maxConnections}`);
    console.log(`🔧 Agent max sockets: ${upstreamAgent.maxSockets}`);
    console.log(`🔥 ULTRA OPTIMIZATIONS:`);
    console.log(`   - Instant rotation (no delays)`);
    console.log(`   - Cached auth & proxy parsing`);
    console.log(`   - Reduced timeouts (25s vs 45s)`);
    console.log(`   - FIFO scheduling`);
    console.log(`   - 1MB request limits (vs 50MB)`);

    if (Object.keys(clientsConfig).length === 0) {
      console.log(`📝 No clients configured - use Telegram bot to add clients`);
    } else {
      Object.keys(clientsConfig).forEach(clientName => {
        console.log(`📊 ${clientName}: ${clientProxies[clientName]?.length || 0} proxies`);
      });
    }

    console.log(`⚡ Instant mode: NO rotation delays, NO connection close headers`);
    console.log(`🔍 Overlapping proxies: ${totalOverlapping}`);
    console.log(`💾 Configuration file: ${CONFIG_FILE}`);
    console.log(`📈 Optimized for: 500-1000+ concurrent users`);

    if (totalOverlapping > 0) {
      console.warn(`⚠️  WARNING: ${totalOverlapping} overlapping proxies may cause interference`);
    } else {
      console.log(`✅ Fully isolated proxy pools - safe for instant rotation`);
    }
  });
}

startServer().catch(console.error);

