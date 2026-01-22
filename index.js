const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Конфигурация
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'default-token-123';
const exchanges = ["Binance", "Kucoin", "BingX", "Bybit", "Bitget", "OKX", "Gate"];

// Кэш для цен CEX
const priceCache = new Map();
const CACHE_TTL = 500;

// Кэш для DEX цен
const dexPriceCache = new Map();
const DEX_CACHE_TTL = 2000;

// Функция для получения цены с DexScreener (новый эндпоинт)
async function getDexPrice(chain, address) {
  const cacheKey = `${chain}:${address}`;
  const now = Date.now();
  
  if (dexPriceCache.has(cacheKey)) {
    const cached = dexPriceCache.get(cacheKey);
    if (now - cached.timestamp < DEX_CACHE_TTL) {
      console.log(`[DEX CACHE HIT] ${chain}/${address}`);
      return cached.data;
    }
  }
  
  console.log(`[DEX CACHE MISS] ${chain}/${address}`);
  
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://api.dexscreener.com/tokens/v1/${chain}/${address}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      timeout: 5000
    });
    
    if (!response.ok) {
      throw new Error(`DexScreener API Error: ${response.status}`);
    }
    
    const data = await response.json();
    
    let tokenName = 'Unknown Token';
    let tokenSymbol = 'UNKNOWN';
    let priceUsd = 0;
    
    if (data && data.length > 0) {
      const token = data[0];
      tokenName = token.baseToken?.name || token.symbol || 'Unknown Token';
      tokenSymbol = token.baseToken?.symbol || token.symbol || 'UNKNOWN';
      priceUsd = parseFloat(token.priceUsd || token.price || "0") || 0;
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

// Функция парсинга ввода
function parseInput(input) {
  const trimmed = input.trim().toUpperCase();
  
  // Проверяем, является ли ввод ссылкой DexScreener
  if (input.includes('dexscreener.com') || input.includes('/solana/') || 
      (input.includes('/') && input.length > 20)) {
    
    try {
      let path = '';
      
      if (input.startsWith('http')) {
        const urlObj = new URL(input);
        path = urlObj.pathname;
      } else {
        path = input.startsWith('/') ? input : `/${input}`;
      }
      
      const parts = path.split('/').filter(p => p.length > 0);
      
      if (parts.length >= 2) {
        return {
          type: 'DEX',
          chain: parts[0],
          address: parts[1],
          rawInput: input
        };
      }
    } catch (error) {
      // Если не удалось распарсить как ссылку, считаем символом
    }
  }
  
  // Если не ссылка, считаем символом токена
  const symbol = trimmed.replace(/[^A-Z0-9]/g, '');
  return {
    type: 'SYMBOL',
    symbol: symbol,
    rawInput: input
  };
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
        url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`;
        break;
      case 'Bitget':
        url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`;
        break;
      case 'OKX':
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
      return 0;
    }
    
    const data = await response.json();
    
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
    return 0;
  }
}

// Получение всех цен с кэшированием
async function getAllPricesWithCache(symbol) {
  const now = Date.now();
  const cacheKey = symbol;
  
  if (priceCache.has(cacheKey)) {
    const cached = priceCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL) {
      console.log(`[CEX CACHE HIT] ${symbol}`);
      return cached.data;
    }
  }
  
  console.log(`[CEX CACHE MISS] ${symbol}`);
  
  try {
    const mexcPrice = await getMexcPrice(symbol);
    
    const pricePromises = exchanges.map(ex => 
      getExchangePrice(ex, symbol).catch(() => 0)
    );
    
    const prices = await Promise.all(pricePromises);
    
    // Фильтруем биржи, где цена > 0
    const activeExchanges = [];
    const activePrices = {};
    
    exchanges.forEach((ex, i) => {
      if (prices[i] > 0) {
        activeExchanges.push(ex);
        activePrices[ex] = prices[i];
      }
    });
    
    const result = {
      ok: true,
      mexc: mexcPrice,
      prices: activePrices,
      exchanges: activeExchanges,
      timestamp: now,
      symbol: symbol,
      fromCache: false
    };
    
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

// API endpoint для получения всех цен
app.get('/api/all', checkToken, async (req, res) => {
  const input = req.query.symbol || 'BTC';
  const parsed = parseInput(input);
  
  try {
    if (parsed.type === 'SYMBOL') {
      const result = await getAllPricesWithCache(parsed.symbol);
      res.json(result);
    } else {
      res.json({
        ok: true,
        type: 'DEX_LINK',
        parsed: parsed,
        message: 'Use /api/dex endpoint for DEX data'
      });
    }
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// API endpoint для DEX данных
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

// Главная страница
app.get('/', checkToken, (req, res) => {
  const input = req.query.symbol || '';
  const token = req.query.token;
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
      padding: 0;
    }
    
    #container {
      padding: 2px;
      line-height: 1;
    }
    
    #output {
      min-height: 200px;
      white-space: pre;
    }
    
    .control-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin: 2px 0;
    }
    
    #inputField {
      font-family: monospace;
      font-size: 28px;
      width: 300px;
      background: #000;
      color: #0f0;
      border: 1px solid #444;
      padding: 1px 3px;
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
    
    #startBtn:hover {
      background: #222;
    }
    
    #status {
      margin: 2px 0;
      font-size: 20px;
      height: 24px;
    }
    
    #dexInfo {
      margin: 2px 0;
      font-size: 20px;
      color: #0f0;
      min-height: 60px;
    }
    
    .err {
      color: #ff4444;
    }
    
    .success {
      color: #0f0;
    }
    
    .inactive {
      color: #888;
    }
    
    .best {
      color: #ffff00;
    }
    
    .dex-price {
      color: #0f0;
      font-weight: bold;
    }
    </style>
    </head>
    <body>
    <div id="container">
      <div id="output">Θ</div>
      
      <div class="control-row">
        <input id="inputField" placeholder="BTC или dexscreener.com/solana/..." value="${input}" autocomplete="off"/>
        <button id="startBtn">СТАРТ</button>
      </div>
      
      <div id="status">Θ</div>
      <div id="dexInfo"></div>
    </div>

    <script>
    const exchanges=["Binance","Kucoin","BingX","Bybit","Bitget","OKX","Gate"];
    let timer=null, dexTimer=null;
    let currentMode='CEX';
    let currentSymbol='';
    let currentChain=null, currentAddr=null, currentDexData=null;
    
    const urlParams = new URLSearchParams(window.location.search);
    let input = urlParams.get('symbol') || '';
    const token = urlParams.get('token');
    const chain = urlParams.get('chain');
    const addr = urlParams.get('addr');

    const output=document.getElementById("output");
    const inputField=document.getElementById("inputField");
    const statusEl=document.getElementById("status");
    const dexInfoEl=document.getElementById("dexInfo");
    const startBtn=document.getElementById("startBtn");

    inputField.value = input;

    // Парсинг ввода
    function parseInput(input) {
      const trimmed = input.trim().toUpperCase();
      
      if (input.includes('dexscreener.com') || input.includes('/solana/') || 
          (input.includes('/') && input.length > 20)) {
        try {
          let path = '';
          
          if (input.startsWith('http')) {
            const urlObj = new URL(input);
            path = urlObj.pathname;
          } else {
            path = input.startsWith('/') ? input : '/' + input;
          }
          
          const parts = path.split('/').filter(p => p.length > 0);
          
          if (parts.length >= 2) {
            return {
              type: 'DEX',
              chain: parts[0],
              address: parts[1],
              rawInput: input
            };
          }
        } catch (e) {
          // Если ошибка, считаем символом
        }
      }
      
      const symbol = trimmed.replace(/[^A-Z0-9]/g, '');
      return {
        type: 'SYMBOL',
        symbol: symbol,
        rawInput: input
      };
    }

    // Форматирование цены с фиксированной длиной
    function formatPrice(p){
      if(!p || p == 0) return "0";
      let s = parseFloat(p).toFixed(8);
      s = s.replace(/(\\.\\d*?)0+$/, "$1");
      s = s.replace(/\\.$/, "");
      return s;
    }

    function formatDexPrice(p){
      if(!p || p == 0) return "0";
      if(p < 0.0001) return parseFloat(p).toFixed(8);
      if(p < 1) return parseFloat(p).toFixed(6);
      if(p < 100) return parseFloat(p).toFixed(4);
      return parseFloat(p).toFixed(2);
    }

    // Обновление DEX цены
    async function updateDexPrice() {
      if (!currentChain || !currentAddr) return;
      
      try {
        const url = \`/api/dex?chain=\${currentChain}&addr=\${currentAddr}\${token ? '&token=' + token : ''}\`;
        const response = await fetch(url, {cache: "no-store"});
        
        if (response.status === 401 || response.status === 403) {
          dexInfoEl.textContent = "Доступ запрещён";
          dexInfoEl.className = "err";
          clearInterval(dexTimer);
          return;
        }
        
        const data = await response.json();
        
        if (!data.success) {
          dexInfoEl.textContent = \`DEX Ошибка: \${data.error}\`;
          dexInfoEl.className = "err";
          return;
        }
        
        currentDexData = data;
        
        // Обновляем заголовок страницы
        document.title = \`\${data.tokenSymbol} $\${formatDexPrice(data.priceUsd)} - Spread Monitor\`;
        
        // Если токен найден, запускаем мониторинг CEX для этого токена
        if (data.tokenSymbol && data.tokenSymbol !== 'UNKNOWN') {
          startCexMonitoring(data.tokenSymbol);
        }
        
        const time = new Date().toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit',
          hour12: false 
        });
        
        dexInfoEl.innerHTML = \`
          <span class="dex-price">\${data.tokenSymbol}: $\${formatDexPrice(data.priceUsd)}</span>
          | \${data.chain} | \${time} \${data.fromCache ? '[C]' : ''}
        \`;
        dexInfoEl.className = "success";
        
      } catch (error) {
        dexInfoEl.textContent = \`DEX ошибка: \${error.message}\`;
        dexInfoEl.className = "err";
      }
    }

    // Запуск CEX мониторинга
    function startCexMonitoring(symbol) {
      currentSymbol = symbol;
      currentMode = 'CEX';
      
      // Обновляем поле ввода
      inputField.value = symbol;
      
      // Обновляем URL
      const url = new URL(window.location);
      url.searchParams.set('symbol', symbol);
      url.searchParams.delete('chain');
      url.searchParams.delete('addr');
      window.history.replaceState({}, '', url);
      
      // Запускаем обновление
      if (timer) clearInterval(timer);
      updateCEX();
      timer = setInterval(updateCEX, 500);
    }

    // Основное обновление (CEX)
    async function updateCEX(){
      if(!currentSymbol) return;
      
      try {
        const url = \`/api/all?symbol=\${currentSymbol}\${token ? '&token=' + token : ''}\`;
        const response = await fetch(url, {cache: "no-store"});
        
        if (response.status === 401 || response.status === 403) {
          output.textContent = "Доступ запрещён. Проверьте токен.";
          statusEl.textContent = "Θ Дост. запрещен";
          clearInterval(timer);
          return;
        }
        
        const data = await response.json();
        
        if(!data.ok) {
          statusEl.textContent = "Θ Ошибка данных";
          return;
        }

        const mexc = data.mexc;
        const prices = data.prices;
        const activeExchanges = data.exchanges || [];

        let best = null, bestSp = 0;
        activeExchanges.forEach(ex => {
          let p = prices[ex];
          if(p > 0) {
            let sp = Math.abs((p - mexc) / mexc * 100);
            if(sp > bestSp) {
              bestSp = sp;
              best = ex;
            }
          }
        });

        let lines = [];
        
        // Форматируем MEXC цену с фиксированной длиной
        let mexcFormatted = formatPrice(mexc);
        let cacheIndicator = data.fromCache ? '[C]' : '';
        lines.push(\`MEXC:    \${mexcFormatted.padStart(15)} \${cacheIndicator}\`);
        
        if (activeExchanges.length === 0) {
          lines.push(\`Нет активных бирж для \${currentSymbol}\`);
        } else {
          activeExchanges.forEach(ex => {
            let p = prices[ex];
            let diff = ((p - mexc) / mexc * 100).toFixed(2);
            let sign = diff > 0 ? "+" : "";
            let mark = (ex === best) ? '◆' : "◇";
            let name = ex;
            while(name.length < 8) name += " ";
            
            let priceFormatted = formatPrice(p);
            lines.push(\`\${mark} \${name}: \${priceFormatted.padStart(15)} (\${sign}\${diff}%)\`);
          });
        }

        output.innerHTML = lines.join("\\n");
        
        let time = new Date().toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit', 
          second: '2-digit',
          hour12: false 
        });
        
        statusEl.textContent = \`Θ \${time} | Бирж: \${activeExchanges.length}\`;
        statusEl.className = "success";
        
      } catch(e) {
        statusEl.textContent = "Θ Сетевая ошибка";
        statusEl.className = "err";
      }
    }

    // Запуск мониторинга
    function startMonitoring() {
      const input = inputField.value.trim();
      if (!input) return;
      
      const parsed = parseInput(input);
      
      if (parsed.type === 'DEX') {
        // Режим DEX
        currentMode = 'DEX';
        currentChain = parsed.chain;
        currentAddr = parsed.address;
        
        // Запускаем обновление DEX
        if (dexTimer) clearInterval(dexTimer);
        updateDexPrice();
        dexTimer = setInterval(updateDexPrice, 2000);
        
        // Останавливаем CEX таймер
        if (timer) clearInterval(timer);
        timer = null;
        
        // Обновляем URL
        const url = new URL(window.location);
        url.searchParams.set('symbol', input);
        url.searchParams.set('chain', currentChain);
        url.searchParams.set('addr', currentAddr);
        window.history.replaceState({}, '', url);
        
        dexInfoEl.textContent = "Загрузка DEX данных...";
        output.textContent = "Θ";
        
      } else {
        // Режим CEX
        startCexMonitoring(parsed.symbol);
        
        // Останавливаем DEX таймер если был
        if (dexTimer) clearInterval(dexTimer);
        dexTimer = null;
        dexInfoEl.innerHTML = '';
        document.title = 'Crypto Spread Monitor';
      }
    }

    startBtn.onclick = startMonitoring;

    inputField.addEventListener('keypress', (e) => {
      if(e.key === 'Enter') {
        startMonitoring();
      }
    });

    // Автофокус и выбор текста
    setTimeout(() => {
      inputField.focus();
      inputField.select();
      
      // Если в URL есть chain и addr, запускаем DEX мониторинг
      if (chain && addr) {
        currentMode = 'DEX';
        currentChain = chain;
        currentAddr = addr;
        
        // Заполняем поле ввода
        inputField.value = \`\${chain}/\${addr}\`;
        
        // Запускаем DEX мониторинг
        updateDexPrice();
        dexTimer = setInterval(updateDexPrice, 2000);
        
        dexInfoEl.textContent = "Загрузка DEX данных...";
        output.textContent = "Θ";
      } else if (input) {
        // Если есть symbol, запускаем CEX мониторинг
        const parsed = parseInput(input);
        if (parsed.type === 'SYMBOL' && parsed.symbol) {
          startCexMonitoring(parsed.symbol);
        }
      }
    }, 100);
    
    // Управление таймерами при скрытии страницы
    document.addEventListener('visibilitychange', () => {
      if(document.hidden) {
        if(timer) clearInterval(timer);
        if(dexTimer) clearInterval(dexTimer);
        statusEl.textContent = "Θ Приостановлено";
      } else {
        if(timer) clearInterval(timer);
        if(dexTimer) clearInterval(dexTimer);
        
        if (currentMode === 'DEX' && currentChain && currentAddr) {
          updateDexPrice();
          dexTimer = setInterval(updateDexPrice, 2000);
        } else if (currentMode === 'CEX' && currentSymbol) {
          updateCEX();
          timer = setInterval(updateCEX, 500);
        }
      }
    });
    
    // Клик в любое место для фокуса на поле ввода
    document.addEventListener('click', () => {
      inputField.focus();
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
});
