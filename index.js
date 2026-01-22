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
  
  if (priceCache.has(cacheKey)) {
    const cached = priceCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL) {
      console.log(`[CACHE HIT] ${symbol}`);
      return cached.data;
    }
  }
  
  console.log(`[CACHE MISS] ${symbol} - запрос к биржам`);
  
  try {
    const mexcPrice = await getMexcPrice(symbol);
    
    const pricePromises = exchanges.map(ex => 
      getExchangePrice(ex, symbol).catch(() => 0)
    );
    
    const prices = await Promise.all(pricePromises);
    
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

// API endpoint
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

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔒 Secret token: ${SECRET_TOKEN}`);
  console.log(`📊 API: http://localhost:${PORT}/api/all?token=${SECRET_TOKEN}&symbol=BTC`);
  console.log(`💾 Cache TTL: ${CACHE_TTL}ms`);
});
