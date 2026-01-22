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

// Кэш и статистика
const priceCache = new Map();
const CACHE_TTL = 500; 
const cacheStats = { hits: 0 }; // Добавлено, чтобы сервер не падал

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
    
    if (!response.ok) return 0;
    
    const data = await response.json();
    
    switch(exchange) {
      case 'Binance': price = data.price; break;
      case 'Kucoin': price = data.data?.price; break;
      case 'BingX': price = data.data?.lastPrice; break;
      case 'Bybit': price = data.result?.list?.[0]?.lastPrice; break;
      case 'Bitget': price = data.data?.[0]?.lastPr; break;
      case 'OKX': price = data.data?.[0]?.last; break;
      case 'Gate': price = data.last || (data[0]?.last || 0); break;
    }
    
    return parseFloat(price) || 0;
  } catch (error) {
    return 0;
  }
}

// Получение всех цен с кэшированием
async function getAllPricesWithCache(symbol) {
  const now = Date.now();
  if (priceCache.has(symbol)) {
    const cached = priceCache.get(symbol);
    if (now - cached.timestamp < CACHE_TTL) {
      cacheStats.hits++;
      return { ...cached.data, fromCache: true };
    }
  }
  
  try {
    const mexcPrice = await getMexcPrice(symbol);
    const pricePromises = exchanges.map(ex => getExchangePrice(ex, symbol).catch(() => 0));
    const prices = await Promise.all(pricePromises);
    
    const result = {
      ok: true,
      mexc: mexcPrice,
      prices: {},
      timestamp: now,
      symbol: symbol,
      fromCache: false
    };
    
    exchanges.forEach((ex, i) => { result.prices[ex] = prices[i]; });
    priceCache.set(symbol, { data: result, timestamp: now });
    return result;
  } catch (error) {
    return { ok: false, error: error.message, timestamp: now, fromCache: false };
  }
}

// Middleware для проверки токена
function checkToken(req, res, next) {
  const token = req.query.token || req.headers['x-access-token'];
  if (!token) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <body style="background:#000;color:#fff;font-family:monospace;padding:20px;">
        <h1>🔒 Access Denied</h1>
        <p>Token is required.</p>
      </body>
      </html>
    `);
  }
  if (token !== SECRET_TOKEN) {
    return res.status(403).send('<h1>❌ Invalid Token</h1>');
  }
  next();
}

app.get('/api/all', checkToken, async (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  try {
    const result = await getAllPricesWithCache(symbol);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: Date.now(),
    exchanges: exchanges,
    cacheSize: priceCache.size,
    cacheHits: cacheStats.hits
  });
});

// Главная страница
app.get('/', checkToken, (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Crypto Spread Monitor</title>
    <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000000; font-family: monospace; font-size: 28px; color: #ffffff; overflow: hidden; }
    #container { position: fixed; top: 0; left: 0; white-space: pre; line-height: 1.1; }
    .control-row { display: flex; align-items: center; gap: 5px; margin-top: 2px; }
    #symbolInput { font-family: monospace; font-size: 28px; width: 100px; background: #000; color: #fff; border: 1px solid #444; padding: 1px 3px; }
    #startBtn { font-family: monospace; font-size: 28px; background: #000; color: #fff; border: 1px solid #444; padding: 1px 10px; cursor: pointer; }
    #startBtn:hover { background: #222; }
    #status { margin-top: 2px; }
    .err { color: #ff4444; }
    #output { line-height: 1.1; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    .best { color: #ffff00; }
    .inactive { color: #888; }
    .cache-indicator { font-size: 14px; color: #0f0; margin-left: 5px; opacity: 0.7; }
    </style>
    </head>
    <body>
    <div id="container">
      <div id="output">Загрузка...</div>
      <div class="control-row">
        <input id="symbolInput" placeholder="BTC" value="\${symbol}" autocomplete="off"/>
        <button id="startBtn">СТАРТ</button>
      </div>
      <div id="status">Ожидание...</div>
    </div>

    <script>
    const exchanges=["Binance","Kucoin","BingX","Bybit","Bitget","OKX","Gate"];
    let timer=null, blink=false;
    
    const urlParams = new URLSearchParams(window.location.search);
    let symbol = (urlParams.get('symbol') || 'BTC').toUpperCase();
    const token = urlParams.get('token');
    const chain = urlParams.get('chain');
    const addr = urlParams.get('addr');

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const statusEl=document.getElementById("status");
    const startBtn=document.getElementById("startBtn");

    input.value = symbol;

    function formatPrice(p){
      if(!p || p == 0) return "0";
      let s = parseFloat(p).toFixed(8);
      return s.replace(/\\.?(0+)?$/, "");
    }

    // НОВАЯ ФУНКЦИЯ ДЛЯ DEX
    async function updateDexPrice() {
      if (!chain || !addr) return;
      try {
        const res = await fetch(\`https://api.dexscreener.com/tokens/v1/\${chain}/\${addr}\`);
        const data = await res.json();
        if (data && data[0]) {
          document.title = \`\${symbol}: \${data[0].priceUsd}\`;
        }
      } catch (e) {
        console.error("DexScreener error:", e);
      }
    }

    async function update(){
      if(!symbol) return;
      blink = !blink;
      statusEl.textContent = "Загрузка...";
      
      updateDexPrice(); // Вызов обновления цены DEX

      try {
        const url = \`/api/all?symbol=\${symbol}\${token ? '&token=' + token : ''}\`;
        const response = await fetch(url, {cache: "no-store"});
        
        if (response.status === 401 || response.status === 403) {
          output.textContent = "Доступ запрещён.";
          clearInterval(timer);
          return;
        }
        
        const data = await response.json();
        if(!data.ok) return;

        const mexc = data.mexc;
        const prices = data.prices;

        let best = null, bestSp = 0;
        exchanges.forEach(ex => {
          let p = prices[ex];
          if(p > 0) {
            let sp = Math.abs((p - mexc) / mexc * 100);
            if(sp > bestSp) { bestSp = sp; best = ex; }
          }
        });

        let dot = blink ? '<span class="blink-dot">●</span>' : '○';
        let lines = [];
        let cacheIndicator = data.fromCache ? '<span class="cache-indicator">[C]</span>' : '';
        lines.push(\`\${dot} \${symbol} MEXC: \${formatPrice(mexc)}\${cacheIndicator}\`);
        
        exchanges.forEach(ex => {
          let p = prices[ex];
          let name = ex.padEnd(8, ' ');
          if(p <= 0) {
            lines.push(\`<span class="inactive">◇ \${name}: --- (---%)</span>\`);
            return;
          }
          let diff = ((p - mexc) / mexc * 100).toFixed(2);
          let mark = (ex === best) ? '<span class="best">◆</span>' : "◇";
          lines.push(\`\${mark} \${name}: \${formatPrice(p)} (\${diff > 0 ? "+" : ""}\${diff}%)\`);
        });

        output.innerHTML = lines.join("<br>");
        statusEl.textContent = \`✓ \${new Date().toLocaleTimeString()}\`;
        
      } catch(e) {
        statusEl.textContent = "Сетевая ошибка";
      }
    }

    startBtn.onclick = () => {
      symbol = input.value.trim().toUpperCase();
      const url = new URL(window.location);
      url.searchParams.set('symbol', symbol);
      window.history.replaceState({}, '', url);
      if(timer) clearInterval(timer);
      update();
      timer = setInterval(update, 500);
    };

    input.addEventListener('keypress', (e) => { if(e.key === 'Enter') startBtn.click(); });
    update();
    timer = setInterval(update, 500);
    
    document.addEventListener('visibilitychange', () => {
      if(document.hidden) clearInterval(timer);
      else timer = setInterval(update, 500);
    });
    </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔒 Token: ${SECRET_TOKEN}`);
});
