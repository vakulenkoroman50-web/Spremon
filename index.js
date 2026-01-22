const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Конфигурация
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'default-token-123'; // Токен по умолчанию
const exchanges = ["Binance", "Kucoin", "BingX", "Bybit", "Bitget", "OKX", "Gate"];

// Кэш для цен CEX (символ -> {data, timestamp})
const priceCache = new Map();
const CACHE_TTL = 500; // 500ms кэш

// Кэш для DEX цен (chain+addr -> {data, timestamp})
const dexPriceCache = new Map();
const DEX_CACHE_TTL = 2000; // 2 секунды для DEX кэша

// Функция для получения цены с DexScreener
async function getDexPrice(chain, address) {
  const cacheKey = `${chain}:${address}`;
  const now = Date.now();
  
  // Проверяем кэш
  if (dexPriceCache.has(cacheKey)) {
    const cached = dexPriceCache.get(cacheKey);
    if (now - cached.timestamp < DEX_CACHE_TTL) {
      console.log(`[DEX CACHE HIT] ${chain}/${address}`);
      return cached.data;
    }
  }
  
  console.log(`[DEX CACHE MISS] ${chain}/${address} - запрос к DexScreener`);
  
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/${chain}/${address}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`DexScreener API Error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Парсим данные из ответа API
    let tokenName = 'Unknown Token';
    let tokenSymbol = 'UNKNOWN';
    let priceUsd = 0;
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      tokenName = pair.baseToken?.name || 'Unknown Token';
      tokenSymbol = pair.baseToken?.symbol || 'UNKNOWN';
      priceUsd = parseFloat(pair.priceUsd) || 0;
    } else if (data.pair) {
      tokenName = data.pair.baseToken?.name || 'Unknown Token';
      tokenSymbol = data.pair.baseToken?.symbol || 'UNKNOWN';
      priceUsd = parseFloat(data.pair.priceUsd) || 0;
    }
    
    const result = {
      success: true,
      chain: chain,
      address: address,
      tokenName: tokenName,
      tokenSymbol: tokenSymbol,
      priceUsd: priceUsd,
      timestamp: now,
      fromCache: false
    };
    
    // Сохраняем в кэш
    dexPriceCache.set(cacheKey, {
      data: result,
      timestamp: now
    });
    
    return result;
    
  } catch (error) {
    console.error('DexScreener Error:', error.message);
    return {
      success: false,
      error: error.message,
      timestamp: now,
      fromCache: false
    };
  }
}

// Функция для парсинга ссылки DexScreener
function parseDexScreenerUrl(url) {
  try {
    // Убираем пробелы и лишние символы
    const cleanUrl = url.trim();
    
    // Проверяем, это полная ссылка или только путь
    let path = '';
    
    if (cleanUrl.startsWith('http')) {
      // Полная ссылка
      const urlObj = new URL(cleanUrl);
      path = urlObj.pathname;
    } else {
      // Только путь
      path = cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`;
    }
    
    // Парсим путь: /solana/DbyK8gEiXwNeh2zFW2Lo1svUQ1WkHAeQyNDsRaKQ6BHf
    const parts = path.split('/').filter(p => p.length > 0);
    
    if (parts.length >= 2) {
      const chain = parts[0];
      const address = parts[1];
      return { chain, address, success: true };
    }
    
    return { success: false, error: 'Неверный формат ссылки' };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Функция для получения цены MEXC
async function getMexcPrice(symbol) {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}_USDT`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        }
      }
    );
    const data = await response.json();
    return parseFloat(data.data?.lastPrice) || 0;
  } catch (error) {
    console.error('MEXC Error:', error.message);
    return 0;
  }
}

// Получение цены с биржи
async function getExchangePrice(exchange, symbol) {
  const pair = symbol + 'USDT';
  
  try {
    const fetch = (await import('node-fetch')).default;
    let url, price;
    
    switch(exchange) {
      case 'Binance':
        // FUTURES
        url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`;
        break;
      case 'Kucoin':
        const kucoinSymbol = symbol === 'BTC' ? 'XBT' : symbol;
        url = `https://api-futures.kucoin.com/api/v1/ticker?symbol=${kucoinSymbol}USDTM`;
        break;
      case 'BingX':
        url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}-USDT`;
        break;
      case 'Bybit':
        // FUTURES (linear)
        url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`;
        break;
      case 'Bitget':
        url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`;
        break;
      case 'OKX':
        // FUTURES (SWAP)
        url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT-SWAP`;
        break;
      case 'Gate':
        url = `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}_USDT`;
        break;
      default:
        return 0;
    }
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    
    if (!response.ok) {
      console.error(`${exchange} API Error: ${response.status}`);
      return 0;
    }
    
    const data = await response.json();
    
    // Парсинг ответа
    switch(exchange) {
      case 'Binance':
        price = data.price;
        break;
      case 'Kucoin':
        price = data.data?.price;
        break;
      case 'BingX':
        price = data.data?.lastPrice;
        break;
      case 'Bybit':
        price = data.result?.list?.[0]?.lastPrice;
        break;
      case 'Bitget':
        price = data.data?.[0]?.lastPr;
        break;
      case 'OKX':
        price = data.data?.[0]?.last;
        break;
      case 'Gate':
        price = data.last || (data[0]?.last || 0);
        break;
    }
    
    return parseFloat(price) || 0;
  } catch (error) {
    console.error(`${exchange} Error:`, error.message);
    return 0;
  }
}

// Получение всех цен с кэшированием
async function getAllPricesWithCache(symbol) {
  const now = Date.now();
  const cacheKey = symbol;
  
  // Проверяем кэш
  if (priceCache.has(cacheKey)) {
    const cached = priceCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL) {
      console.log(`[CEX CACHE HIT] ${symbol}`);
      return cached.data;
    }
  }
  
  console.log(`[CEX CACHE MISS] ${symbol} - запрос к биржам`);
  
  try {
    // Получаем цену MEXC
    const mexcPrice = await getMexcPrice(symbol);
    
    // Получаем цены всех бирж параллельно
    const pricePromises = exchanges.map(ex => 
      getExchangePrice(ex, symbol).catch(() => 0)
    );
    
    const prices = await Promise.all(pricePromises);
    
    // Формируем результат
    const result = {
      ok: true,
      mexc: mexcPrice,
      prices: {},
      timestamp: now,
      symbol: symbol,
      fromCache: false
    };
    
    exchanges.forEach((ex, i) => {
      result.prices[ex] = prices[i];
    });
    
    // Сохраняем в кэш
    priceCache.set(cacheKey, {
      data: result,
      timestamp: now
    });
    
    return result;
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      timestamp: now,
      fromCache: false
    };
  }
}

// Middleware для проверки токена
function checkToken(req, res, next) {
  const token = req.query.token || req.headers['x-access-token'];
  
  if (!token) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Access Denied</title></head>
      <body style="background:#000;color:#fff;font-family:monospace;padding:20px;">
        <h1>🔒 Access Denied</h1>
        <p>Token is required. Use: /?token=YOUR_TOKEN&symbol=BTC</p>
        <p>Or set SECRET_TOKEN in environment variables.</p>
      </body>
      </html>
    `);
  }
  
  if (token !== SECRET_TOKEN) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Invalid Token</title></head>
      <body style="background:#000;color:#fff;font-family:monospace;padding:20px;">
        <h1>❌ Invalid Token</h1>
        <p>The provided token is invalid.</p>
      </body>
      </html>
    `);
  }
  
  next();
}

// API endpoint для получения всех цен (с проверкой токена)
app.get('/api/all', checkToken, async (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  const chain = req.query.chain;
  const addr = req.query.addr;
  
  try {
    const result = await getAllPricesWithCache(symbol);
    
    // Добавляем DEX данные, если указаны chain и addr
    if (chain && addr) {
      const dexData = await getDexPrice(chain, addr);
      result.dex = dexData;
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// API endpoint для получения только DEX цены
app.get('/api/dex', checkToken, async (req, res) => {
  const chain = req.query.chain;
  const addr = req.query.addr;
  
  if (!chain || !addr) {
    return res.status(400).json({
      success: false,
      error: 'Требуются параметры chain и addr'
    });
  }
  
  try {
    const dexData = await getDexPrice(chain, addr);
    res.json(dexData);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// Статус сервера
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    server: 'Northflank EU',
    region: process.env.NF_REGION || 'EU',
    timestamp: Date.now(),
    exchanges: exchanges,
    cacheSize: priceCache.size,
    dexCacheSize: dexPriceCache.size,
    cacheHits: Object.values(cacheStats).reduce((a, b) => a + b, 0)
  });
});

// Главная страница с проверкой токена
app.get('/', checkToken, (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  const chain = req.query.chain;
  const addr = req.query.addr;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Crypto Spread Monitor</title>
    <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      background: #000000;
      font-family: monospace;
      font-size: 28px;
      color: #ffffff;
      overflow: hidden;
    }
    
    #container {
      position: fixed;
      top: 0;
      left: 0;
      white-space: pre;
      line-height: 1.1;
    }
    
    .control-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 2px;
    }
    
    #symbolInput {
      font-family: monospace;
      font-size: 28px;
      width: 100px;
      background: #000;
      color: #fff;
      border: 1px solid #444;
      padding: 1px 3px;
    }
    
    #dexUrlInput {
      font-family: monospace;
      font-size: 20px;
      width: 500px;
      background: #000;
      color: #0f0;
      border: 1px solid #444;
      padding: 1px 3px;
      margin-top: 5px;
    }
    
    #startBtn {
      font-family: monospace;
      font-size: 28px;
      background: #000;
      color: #fff;
      border: 1px solid #444;
      padding: 1px 10px;
      cursor: pointer;
    }
    
    #loadDexBtn {
      font-family: monospace;
      font-size: 20px;
      background: #000;
      color: #0f0;
      border: 1px solid #444;
      padding: 1px 10px;
      cursor: pointer;
      margin-top: 5px;
    }
    
    #startBtn:hover {
      background: #222;
    }
    
    #startBtn:active {
      background: #444;
    }
    
    #loadDexBtn:hover {
      background: #222;
    }
    
    #loadDexBtn:active {
      background: #444;
    }
    
    #status {
      margin-top: 2px;
    }
    
    #dexStatus {
      margin-top: 5px;
      font-size: 20px;
      color: #0f0;
    }
    
    .err {
      color: #ff4444;
    }
    
    .dex-err {
      color: #ff4444;
    }
    
    .dex-success {
      color: #0f0;
    }
    
    #output {
      line-height: 1.1;
    }
    
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    
    .blink-dot {
      animation: blink 1s infinite;
      display: inline-block;
    }
    
    .best {
      color: #ffff00;
    }
    
    .inactive {
      color: #888;
    }
    
    .cache-indicator {
      font-size: 14px;
      color: #0f0;
      margin-left: 5px;
      opacity: 0.7;
    }
    
    .dex-price-display {
      font-size: 16px;
      color: #0f0;
      margin-top: 10px;
      padding: 5px;
      border: 1px solid #333;
      background: #111;
    }
    </style>
    </head>
    <body>
    <div id="container">
      <div id="output">Загрузка...</div>
      
      <div class="control-row">
        <input id="symbolInput" placeholder="BTC" value="${symbol}" autocomplete="off"/>
        <button id="startBtn">СТАРТ</button>
      </div>
      
      <div style="margin-top: 15px; font-size: 20px; color: #0f0;">
        DEX монитор:
      </div>
      
      <div style="margin-top: 5px;">
        <input id="dexUrlInput" placeholder="https://dexscreener.com/solana/DbyK8gEiXwNeh2zFW2Lo1svUQ1WkHAeQyNDsRaKQ6BHf" autocomplete="off"/>
        <button id="loadDexBtn">ЗАГРУЗИТЬ DEX</button>
      </div>
      
      <div id="status">Ожидание...</div>
      <div id="dexStatus"></div>
    </div>

    <script>
    const exchanges=["Binance","Kucoin","BingX","Bybit","Bitget","OKX","Gate"];
    let timer=null, dexTimer=null, blink=false;
    let currentChain=null, currentAddr=null, currentDexData=null;
    
    const urlParams = new URLSearchParams(window.location.search);
    let symbol = (urlParams.get('symbol') || 'BTC').toUpperCase();
    const token = urlParams.get('token');
    const chain = urlParams.get('chain');
    const addr = urlParams.get('addr');

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const dexUrlInput=document.getElementById("dexUrlInput");
    const statusEl=document.getElementById("status");
    const dexStatusEl=document.getElementById("dexStatus");
    const startBtn=document.getElementById("startBtn");
    const loadDexBtn=document.getElementById("loadDexBtn");

    input.value = symbol;
    
    // Если в URL уже есть chain и addr, заполняем поле
    if (chain && addr) {
      dexUrlInput.value = \`https://dexscreener.com/\${chain}/\${addr}\`;
      currentChain = chain;
      currentAddr = addr;
    }

    function formatPrice(p){
      if(!p || p == 0) return "0";
      let s = parseFloat(p).toFixed(8);
      return s.replace(/\\.?0+$/, "");
    }
    
    function formatDexPrice(p){
      if(!p || p == 0) return "0";
      if(p < 0.0001) return parseFloat(p).toFixed(8);
      if(p < 1) return parseFloat(p).toFixed(6);
      if(p < 100) return parseFloat(p).toFixed(4);
      return parseFloat(p).toFixed(2);
    }

    // Функция для парсинга DexScreener ссылки
    function parseDexUrl(url) {
      try {
        const cleanUrl = url.trim();
        let path = '';
        
        if (cleanUrl.startsWith('http')) {
          const urlObj = new URL(cleanUrl);
          path = urlObj.pathname;
        } else {
          path = cleanUrl.startsWith('/') ? cleanUrl : \`/\${cleanUrl}\`;
        }
        
        const parts = path.split('/').filter(p => p.length > 0);
        
        if (parts.length >= 2) {
          return {
            chain: parts[0],
            addr: parts[1],
            success: true
          };
        }
        
        return { success: false, error: 'Неверный формат ссылки' };
        
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    
    // Функция для обновления DEX цены
    async function updateDexPrice() {
      if (!currentChain || !currentAddr) return;
      
      try {
        const url = \`/api/dex?chain=\${currentChain}&addr=\${currentAddr}\${token ? '&token=' + token : ''}\`;
        const response = await fetch(url, {cache: "no-store"});
        
        if (response.status === 401 || response.status === 403) {
          dexStatusEl.textContent = "Доступ запрещён. Проверьте токен.";
          dexStatusEl.className = "dex-err";
          clearInterval(dexTimer);
          return;
        }
        
        const data = await response.json();
        
        if (!data.success) {
          dexStatusEl.textContent = \`DEX Ошибка: \${data.error || 'Неизвестная ошибка'}\`;
          dexStatusEl.className = "dex-err";
          return;
        }
        
        currentDexData = data;
        
        // Обновляем заголовок страницы с ценой токена
        document.title = \`\${data.tokenSymbol} $\${formatDexPrice(data.priceUsd)} - Crypto Spread Monitor\`;
        
        // Обновляем статус DEX
        const time = new Date().toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit',
          hour12: false 
        });
        
        dexStatusEl.innerHTML = \`
          <div class="dex-price-display">
            <strong>\${data.tokenName} (\${data.tokenSymbol})</strong><br>
            Цена: <strong>$\${formatDexPrice(data.priceUsd)}</strong><br>
            Сеть: \${data.chain} | Адрес: \${data.address.substring(0, 8)}...<br>
            Обновлено: \${time} \${data.fromCache ? '[CACHE]' : ''}
          </div>
        \`;
        dexStatusEl.className = "dex-success";
        
      } catch (error) {
        dexStatusEl.textContent = \`Сетевая ошибка DEX: \${error.message}\`;
        dexStatusEl.className = "dex-err";
      }
    }
    
    // Функция для загрузки DEX по ссылке
    function loadDexFromUrl() {
      const url = dexUrlInput.value.trim();
      if (!url) {
        dexStatusEl.textContent = "Введите ссылку DexScreener";
        dexStatusEl.className = "dex-err";
        return;
      }
      
      const parsed = parseDexUrl(url);
      if (!parsed.success) {
        dexStatusEl.textContent = \`Ошибка парсинга: \${parsed.error}\`;
        dexStatusEl.className = "dex-err";
        return;
      }
      
      currentChain = parsed.chain;
      currentAddr = parsed.addr;
      
      // Обновляем URL в браузере
      const urlObj = new URL(window.location);
      urlObj.searchParams.set('chain', currentChain);
      urlObj.searchParams.set('addr', currentAddr);
      window.history.replaceState({}, '', urlObj);
      
      // Запускаем обновление DEX цены
      if (dexTimer) clearInterval(dexTimer);
      updateDexPrice();
      dexTimer = setInterval(updateDexPrice, 2000);
      
      dexStatusEl.textContent = "Загрузка DEX данных...";
      dexStatusEl.className = "";
    }

    async function update(){
      if(!symbol) return;
      
      blink = !blink;
      statusEl.textContent = "Загрузка...";
      statusEl.className = "";

      try {
        const url = \`/api/all?symbol=\${symbol}\${token ? '&token=' + token : ''}\`;
        const response = await fetch(url, {cache: "no-store"});
        
        if (response.status === 401 || response.status === 403) {
          output.textContent = "Доступ запрещён. Проверьте токен.";
          statusEl.textContent = "Ошибка авторизации";
          statusEl.className = "err";
          clearInterval(timer);
          return;
        }
        
        const data = await response.json();
        
        if(!data.ok) {
          statusEl.textContent = "Ошибка данных";
          statusEl.className = "err";
          return;
        }

        const mexc = data.mexc;
        const prices = data.prices;

        let best = null, bestSp = 0;
        exchanges.forEach(ex => {
          let p = prices[ex];
          if(p > 0) {
            let sp = Math.abs((p - mexc) / mexc * 100);
            if(sp > bestSp) {
              bestSp = sp;
              best = ex;
            }
          }
        });

        let dot = blink ? '<span class="blink-dot">●</span>' : '○';
        let lines = [];
        
        let cacheIndicator = data.fromCache ? '<span class="cache-indicator">[C]</span>' : '';
        lines.push(\`\${dot} \${symbol} MEXC: \${formatPrice(mexc)}\${cacheIndicator}\`);
        
        exchanges.forEach(ex => {
          let p = prices[ex];
          if(p <= 0) {
            let name = ex;
            while(name.length < 8) name += " ";
            lines.push(\`<span class="inactive">◇ \${name}: --- (---%)</span>\`);
            return;
          }
          
          let diff = ((p - mexc) / mexc * 100).toFixed(2);
          let sign = diff > 0 ? "+" : "";
          let mark = (ex === best) ? '<span class="best">◆</span>' : "◇";
          let name = ex;
          while(name.length < 8) name += " ";
          
          lines.push(\`\${mark} \${name}: \${formatPrice(p)} (\${sign}\${diff}%)\`);
        });

        output.innerHTML = lines.join("<br>");
        
        let time = new Date().toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit',
          hour12: false 
        });
        
        statusEl.textContent = \`✓ \${time}\`;
        statusEl.className = "";
        
      } catch(e) {
        statusEl.textContent = "Сетевая ошибка";
        statusEl.className = "err";
        console.error("Update error:", e);
      }
    }

    startBtn.onclick = () => {
      const newSymbol = input.value.trim().toUpperCase();
      if(!newSymbol) return;
      
      symbol = newSymbol;
      
      const url = new URL(window.location);
      url.searchParams.set('symbol', symbol);
      window.history.replaceState({}, '', url);
      
      if(timer) clearInterval(timer);
      update();
      timer = setInterval(update, 500);
    };
    
    loadDexBtn.onclick = loadDexFromUrl;

    input.addEventListener('keypress', (e) => {
      if(e.key === 'Enter') {
        startBtn.click();
      }
    });
    
    dexUrlInput.addEventListener('keypress', (e) => {
      if(e.key === 'Enter') {
        loadDexFromUrl();
      }
    });

    input.focus();
    input.select();

    // Инициализация
    update();
    timer = setInterval(update, 500);
    
    // Если в URL уже есть chain и addr, загружаем DEX данные
    if (chain && addr) {
      setTimeout(() => {
        loadDexFromUrl();
      }, 1000);
    }
    
    document.addEventListener('visibilitychange', () => {
      if(document.hidden) {
        if(timer) clearInterval(timer);
        if(dexTimer) clearInterval(dexTimer);
        statusEl.textContent = "⏸ Приостановлено";
        if (dexStatusEl.className !== "dex-err") {
          dexStatusEl.textContent = "⏸ DEX приостановлен";
        }
      } else {
        if(timer) clearInterval(timer);
        if(dexTimer) clearInterval(dexTimer);
        update();
        timer = setInterval(update, 500);
        if (currentChain && currentAddr) {
          updateDexPrice();
          dexTimer = setInterval(updateDexPrice, 1000);
        }
      }
    });
    
    document.addEventListener('click', () => {
      input.focus();
    });
    </script>
    </body>
    </html>
  `);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔒 Secret token: ${SECRET_TOKEN}`);
  console.log(`🌍 Region: ${process.env.NF_REGION || 'EU'}`);
  console.log(`📊 CEX API: http://localhost:${PORT}/api/all?token=${SECRET_TOKEN}&symbol=BTC`);
  console.log(`🌐 DEX API: http://localhost:${PORT}/api/dex?token=${SECRET_TOKEN}&chain=solana&addr=DbyK8gEiXwNeh2zFW2Lo1svUQ1WkHAeQyNDsRaKQ6BHf`);
  console.log(`💾 CEX Cache TTL: ${CACHE_TTL}ms`);
  console.log(`💾 DEX Cache TTL: ${DEX_CACHE_TTL}ms`);
});
