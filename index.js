const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Конфигурация
const PORT = process.env.PORT || 3000;
const exchanges = ["Binance", "Kucoin", "BingX", "Bybit", "Bitget", "OKX", "Gate"];

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
        url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
        break;
      case 'Kucoin':
        const kucoinSymbol = symbol === 'BTC' ? 'XBT' : symbol;
        url = `https://api-futures.kucoin.com/api/v1/ticker?symbol=${kucoinSymbol}USDTM`;
        break;
      case 'BingX':
        url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}-USDT`;
        break;
      case 'Bybit':
        url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`;
        break;
      case 'Bitget':
        url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`;
        break;
      case 'OKX':
        url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`;
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

// API endpoint для получения всех цен
app.get('/api/all', async (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  
  try {
    // Получаем цену MEXC
    const mexcPrice = await getMexcPrice(symbol);
    
    // Получаем цены всех бирж параллельно
    const pricePromises = exchanges.map(ex => 
      getExchangePrice(ex, symbol).catch(() => 0)
    );
    
    const prices = await Promise.all(pricePromises);
    
    // Формируем ответ
    const result = {
      ok: true,
      mexc: mexcPrice,
      prices: {},
      timestamp: Date.now(),
      symbol: symbol
    };
    
    exchanges.forEach((ex, i) => {
      result.prices[ex] = prices[i];
    });
    
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
    exchanges: exchanges
  });
});

// Главная страница с обновленным интерфейсом
app.get('/', (req, res) => {
  const symbol = (req.query.symbol || 'BTC').toUpperCase();
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Crypto Spread Monitor</title>
    <style>
    /* Полностью черный фон и белый текст */
    body {
      margin: 0;
      padding: 0;
      background: #000000;
      font-family: monospace;
      font-size: 24.2px; /* увеличен на 10% от 22px */
      color: #ffffff;
      overflow: hidden;
    }
    
    /* Контейнер в правом верхнем углу без отступов */
    #container {
      position: fixed;
      top: 0;
      right: 0;
      white-space: pre;
      text-align: right;
      margin: 0;
      padding: 0;
    }
    
    /* Контейнер для управления (ввод и кнопка) */
    #controlContainer {
      position: fixed;
      top: 0;
      left: 0;
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    
    /* Поле ввода и кнопка в одной строке */
    #symbolInput {
      font-family: monospace;
      font-size: 24.2px;
      width: 90px;
      background: #000;
      color: #fff;
      border: 1px solid #444;
      padding: 2px 5px;
      margin: 0;
    }
    
    #startBtn {
      font-family: monospace;
      font-size: 24.2px;
      background: #000;
      color: #fff;
      border: 1px solid #444;
      padding: 2px 10px;
      margin: 0;
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
      margin: 0;
      padding: 0;
    }
    
    .err {
      color: #ff4444;
    }
    
    /* Выходные данные */
    #output {
      margin: 0;
      padding: 0;
      line-height: 1.1;
    }
    
    /* Подсветка лучшей биржи */
    .best {
      color: #ffff00;
    }
    
    /* Анимация мигающей точки */
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    
    .blink-dot {
      display: inline-block;
      animation: blink 1s infinite;
    }
    </style>
    </head>
    <body>
    <!-- Контейнер управления слева сверху -->
    <div id="controlContainer">
      <input id="symbolInput" placeholder="BTC" value="${symbol}" autocomplete="off"/>
      <button id="startBtn">СТАРТ</button>
      <div id="status">🔄</div>
    </div>
    
    <!-- Контейнер вывода данных справа сверху -->
    <div id="container">
      <div id="output"></div>
    </div>

    <script>
    const exchanges=["Binance","Kucoin","BingX","Bybit","Bitget","OKX","Gate"];
    let timer=null, blink=false;

    const params=new URLSearchParams(location.search);
    let symbol=(params.get("symbol")||"BTC").toUpperCase();

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const statusEl=document.getElementById("status");
    const startBtn=document.getElementById("startBtn");

    // Функция для форматирования цены
    function formatPrice(p){
     if(!p||p==0) return "0";
     let s=parseFloat(p).toFixed(8);
     return s.replace(/\\.?0+$/,"");
    }

    // Основная функция обновления данных
    async function update(){
     if(!symbol) return;
     blink=!blink;
     statusEl.textContent = blink ? "⚡" : "🔄";

     try{
      const r=await fetch(\`/api/all?symbol=\${symbol}\`,{cache:"no-store"});
      const d=await r.json();
      
      if(!d.ok){
        statusEl.textContent="❌";
        statusEl.className="err";
        return;
      }

      const mexc=d.mexc;
      const prices=d.prices;

      // Находим биржу с наибольшим спредом
      let best=null, bestSp=0;
      exchanges.forEach(ex=>{
        let p=prices[ex];
        if(p>0){
          let sp=Math.abs((p-mexc)/mexc*100);
          if(sp>bestSp){
            bestSp=sp;
            best=ex;
          }
        }
      });

      // Формируем строку с MEXC ценой
      let dot = '<span class="blink-dot">●</span>';
      let lines=[];
      lines.push(\`\${dot} \${symbol} MEXC: \${formatPrice(mexc)}\`);

      // Добавляем данные по всем биржам
      exchanges.forEach(ex=>{
        let p=prices[ex];
        if(p<=0) return;
        
        let diff=((p-mexc)/mexc*100).toFixed(2);
        let sign=diff>0?"+":"";
        let mark=(ex===best)?"<span class='best'>◆</span>":"◇";
        
        // Выравнивание имен бирж до 8 символов
        let name=ex;
        while(name.length<8) name+=" ";
        
        lines.push(\`\${mark} \${name}: \${formatPrice(p)} (\${sign}\${diff}%)\`);
      });

      // Обновляем вывод
      output.innerHTML = lines.join("<br>");
      
      // Обновляем статус
      let time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
      statusEl.textContent = "✓ " + time;
      statusEl.className = "";
      
     }catch(e){
      statusEl.textContent="❌";
      statusEl.className="err";
     }
    }

    // Обработчик клика по кнопке СТАРТ
    startBtn.onclick=()=>{
     symbol=input.value.trim().toUpperCase();
     if(!symbol) return;
     
     // Обновляем URL
     const url=new URL(location);
     url.searchParams.set("symbol",symbol);
     history.replaceState(null,"",url);
     
     // Перезапускаем таймер
     if(timer) clearInterval(timer);
     update();
     timer=setInterval(update,500); // Обновление каждые 0.5 секунды
    };

    // Обработчик нажатия Enter в поле ввода
    input.addEventListener('keypress', (e) => {
      if(e.key === 'Enter') {
        startBtn.click();
      }
    });

    // Запускаем начальное обновление
    update();
    
    // Устанавливаем интервал обновления 500ms (0.5 секунды)
    timer=setInterval(update,500);
    
    // Обработчик видимости страницы (оптимизация)
    document.addEventListener('visibilitychange', () => {
      if(document.hidden){
        if(timer) clearInterval(timer);
      }else{
        if(timer) clearInterval(timer);
        timer=setInterval(update,500);
      }
    });
    </script>
    </body>
    </html>
  `);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Region: ${process.env.NF_REGION || 'EU'}`);
  console.log(`📊 API: http://localhost:${PORT}/api/all?symbol=BTC`);
  console.log(`📊 Status: http://localhost:${PORT}/api/status`);
});
