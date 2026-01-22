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

// Кэш для цен (символ -> {data, timestamp})
const priceCache = new Map();
const CACHE_TTL = 500; // 500ms кэш

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

// Получение фьючерсной цены с биржи
async function getExchangePrice(exchange, symbol) {
  const pair = symbol + 'USDT';
  
  try {
    const fetch = (await import('node-fetch')).default;
    let url, price;
    
    // Все endpoints теперь фьючерсные
    switch(exchange) {
      case 'Binance':
        url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`;
        parser = (data) => parseFloat(data.price) || 0;
        break;
      
      case 'Kucoin':
        const kucoinSymbol = symbol === 'BTC' ? 'XBT' : symbol;
        url = `https://api-futures.kucoin.com/api/v1/ticker?symbol=${kucoinSymbol}USDTM`;
        parser = (data) => parseFloat(data.data?.price) || 0;
        break;
      
      case 'BingX':
        url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}-USDT`;
        parser = (data) => parseFloat(data.data?.lastPrice) || 0;
        break;
      
      case 'Bybit':
        url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`;
        parser = (data) => parseFloat(data.result?.list?.[0]?.lastPrice) || 0;
        break;
      
      case 'Bitget':
        url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`;
        parser = (data) => parseFloat(data.data?.[0]?.lastPr) || 0;
        break;
      
      case 'OKX':
        url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT-SWAP`;
        parser = (data) => parseFloat(data.data?.[0]?.last) || 0;
        break;
      
      case 'Gate':
        url = `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}_USDT`;
        parser = (data) => parseFloat(data.last || (data[0]?.last || 0));
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
    return parser(data);
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
      console.log(`[CACHE HIT] ${symbol}`);
      return cached.data;
    }
  }
  
  console.log(`[CACHE MISS] ${symbol} - запрос к биржам`);
  
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
  
  try {
    const result = await getAllPricesWithCache(symbol);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
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
    cacheSize: priceCache.size
  });
});

// Главная страница с проверкой токена
app.get('/', checkToken, (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Crypto Spread Monitor</title>
    <style>
    /* Полностью черный фон и белый текст */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      background: #000000;
      font-family: monospace;
      font-size: 28px; /* увеличен до 28px */
      color: #ffffff;
      overflow: hidden;
    }
    
    /* Контейнер в левом верхнем углу БЕЗ ОТСТУПОВ */
    #container {
      position: fixed;
      top: 0;
      left: 0;
      white-space: pre;
      line-height: 1.1;
    }
    
    /* Контейнер для управления - кнопка справа от поля ввода */
    .control-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 2px; /* минимальный отступ от данных */
    }
    
    /* Поле ввода */
    #symbolInput {
      font-family: monospace;
      font-size: 28px;
      width: 100px;
      background: #000;
      color: #fff;
      border: 1px solid #444;
      padding: 1px 3px;
    }
    
    /* Кнопка СТАРТ */
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
    
    #startBtn:active {
      background: #444;
    }
    
    /* Статус */
    #status {
      margin-top: 2px;
    }
    
    .err {
      color: #ff4444;
    }
    
    /* Выходные данные */
    #output {
      line-height: 1.1;
    }
    
    /* Анимация мигающей точки */
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    
    .blink-dot {
      animation: blink 1s infinite;
      display: inline-block;
    }
    
    /* Стиль для лучшей биржи */
    .best {
      color: #ffff00;
    }
    
    /* Стиль для неактивных бирж */
    .inactive {
      color: #888;
    }
    
    /* Индикатор кэша */
    .cache-indicator {
      font-size: 14px;
      color: #0f0;
      margin-left: 5px;
      opacity: 0.7;
    }
    
    /* Индикатор типа цены */
    .price-type {
      font-size: 14px;
      color: #0af;
      margin-left: 5px;
      opacity: 0.7;
    }
    </style>
    </head>
    <body>
    <!-- КОНТЕЙНЕР в левом верхнем углу БЕЗ ОТСТУПОВ -->
    <div id="container">
      <div id="output">Загрузка...</div>
      
      <!-- Управление - кнопка справа от поля ввода -->
      <div class="control-row">
        <input id="symbolInput" placeholder="BTC" value="${symbol}" autocomplete="off"/>
        <button id="startBtn">СТАРТ</button>
      </div>
      
      <div id="status">Ожидание...</div>
    </div>

    <script>
    const exchanges=["Binance","Kucoin","BingX","Bybit","Bitget","OKX","Gate"];
    let timer=null, blink=false;
    
    // Получаем параметры из URL
    const urlParams = new URLSearchParams(window.location.search);
    let symbol = (urlParams.get('symbol') || 'BTC').toUpperCase();
    const token = urlParams.get('token');

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const statusEl=document.getElementById("status");
    const startBtn=document.getElementById("startBtn");

    // Устанавливаем значение поля ввода
    input.value = symbol;

    // Функция для форматирования цены
    function formatPrice(p){
      if(!p || p == 0) return "0";
      let s = parseFloat(p).toFixed(8);
      return s.replace(/\\.?0+$/, "");
    }

    // Основная функция обновления данных
    async function update(){
      if(!symbol) return;
      
      blink = !blink;
      statusEl.textContent = "Загрузка...";
      statusEl.className = "";

      try {
        // Добавляем токен в запрос
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

        // Находим биржу с наибольшим спредом
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

        // Формируем вывод
        let dot = blink ? '<span class="blink-dot">●</span>' : '○';
        let lines = [];
        
        // Строка с MEXC (фьючерс)
        let cacheIndicator = data.fromCache ? '<span class="cache-indicator">[C]</span>' : '';
        let priceType = '<span class="price-type">[FUT]</span>';
        lines.push(\`\${dot} \${symbol} MEXC: \${formatPrice(mexc)}\${priceType}\${cacheIndicator}\`);
        
        // Строки с биржами (все фьючерсы)
        exchanges.forEach(ex => {
          let p = prices[ex];
          if(p <= 0) {
            // Биржа не отвечает
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

        // Обновляем вывод
        output.innerHTML = lines.join("<br>");
        
        // Обновляем статус
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

    // Обработчик клика по кнопке СТАРТ
    startBtn.onclick = () => {
      const newSymbol = input.value.trim().toUpperCase();
      if(!newSymbol) return;
      
      symbol = newSymbol;
      
      // Обновляем URL без перезагрузки страницы
      const url = new URL(window.location);
      url.searchParams.set('symbol', symbol);
      window.history.replaceState({}, '', url);
      
      // Перезапускаем обновление
      if(timer) clearInterval(timer);
      update();
      timer = setInterval(update, 500); // 500ms = 0.5 секунды
    };

    // Обработчик нажатия Enter в поле ввода
    input.addEventListener('keypress', (e) => {
      if(e.key === 'Enter') {
        startBtn.click();
      }
    });

    // Фокусировка на поле ввода при загрузке
    input.focus();
    input.select();

    // Запускаем начальное обновление
    update();
    
    // Устанавливаем интервал обновления 500ms
    timer = setInterval(update, 500);
    
    // Оптимизация: останавливаем обновление при скрытии вкладки
    document.addEventListener('visibilitychange', () => {
      if(document.hidden) {
        if(timer) clearInterval(timer);
        statusEl.textContent = "⏸ Приостановлено";
      } else {
        if(timer) clearInterval(timer);
        update();
        timer = setInterval(update, 500);
      }
    });
    
    // Автоматический фокус на поле ввода при клике в любом месте
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
  console.log(`📊 API: http://localhost:${PORT}/api/all?token=${SECRET_TOKEN}&symbol=BTC`);
  console.log(`💾 Cache TTL: ${CACHE_TTL}ms`);
  console.log(`🎯 Все цены фьючерсные (Futures)`);
});
