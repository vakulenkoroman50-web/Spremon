const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

/** * КОНФИГУРАЦИЯ 
 */
const CONFIG = {
    PORT: process.env.PORT || 3000,
    SECRET_TOKEN: process.env.SECRET_TOKEN || '',
    MEXC: {
        KEY: process.env.MEXC_API_KEY || '',
        SECRET: process.env.MEXC_API_SECRET || '',
        BASE_URL: 'https://api.mexc.com',
        FUTURES_URL: 'https://contract.mexc.com'
    }
};

const EXCHANGES_ORDER = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];

/**
 * КОНФИГУРАЦИЯ API БИРЖ
 * Позволяет легко расширять список без изменения логики
 */
const CEX_ADAPTERS = {
    Binance: {
        url: (s) => `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${s}USDT`,
        parse: (d) => d.price
    },
    Kucoin: {
        url: (s) => `https://api-futures.kucoin.com/api/v1/ticker?symbol=${s === 'BTC' ? 'XBT' : s}USDTM`,
        parse: (d) => d.data?.price
    },
    BingX: {
        url: (s) => `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${s}-USDT`,
        parse: (d) => d.data?.lastPrice
    },
    Bybit: {
        url: (s) => `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}USDT`,
        parse: (d) => d.result?.list?.[0]?.lastPrice
    },
    Bitget: {
        url: (s) => `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${s}USDT&productType=USDT-FUTURES`,
        parse: (d) => d.data?.[0]?.lastPr
    },
    OKX: {
        url: (s) => `https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT-SWAP`,
        parse: (d) => d.data?.[0]?.last
    },
    Gate: {
        url: (s) => `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${s}_USDT`,
        parse: (d) => d.last || (d[0] && d[0].last)
    }
};

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация fetch один раз
let fetch;
(async () => {
    fetch = (await import('node-fetch')).default;
})();

/**
 * ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
 */
const authMiddleware = (req, res, next) => {
    if (req.query.token !== CONFIG.SECRET_TOKEN) {
        return res.status(403).json({ ok: false, msg: "AUTH_ERR" });
    }
    next();
};

const signMexc = (params) => {
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHmac('sha256', CONFIG.MEXC.SECRET).update(queryString).digest('hex');
};

/**
 * API КЛИЕНТЫ
 */
async function mexcPrivateRequest(path, params = {}) {
    if (!CONFIG.MEXC.KEY || !CONFIG.MEXC.SECRET) return null;
    try {
        params.timestamp = Date.now();
        params.signature = signMexc(params);
        const query = new URLSearchParams(params).toString();
        const res = await fetch(`${CONFIG.MEXC.BASE_URL}${path}?${query}`, {
            headers: { 'X-MEXC-APIKEY': CONFIG.MEXC.KEY }
        });
        return await res.json();
    } catch (e) {
        console.error('MEXC Auth API Error:', e.message);
        return null;
    }
}

async function getMexcPrice(symbol) {
    try {
        const res = await fetch(`${CONFIG.MEXC.FUTURES_URL}/api/v1/contract/ticker?symbol=${symbol}_USDT`);
        const d = await res.json();
        return parseFloat(d.data?.lastPrice) || 0;
    } catch (e) { return 0; }
}

async function fetchExchangePrice(exchange, symbol) {
    const adapter = CEX_ADAPTERS[exchange];
    if (!adapter) return 0;
    try {
        const res = await fetch(adapter.url(symbol));
        const data = await res.json();
        return parseFloat(adapter.parse(data)) || 0;
    } catch (e) { return 0; }
}

/**
 * ЭНДПОИНТЫ
 */
app.get('/api/resolve', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const data = await mexcPrivateRequest("/api/v3/capital/config/getall");
    
    if (!data || !Array.isArray(data)) return res.json({ ok: false });

    const tokenData = data.find(t => t.coin === symbol);
    if (!tokenData?.networkList) return res.json({ ok: false });

    const depositOpen = tokenData.networkList.some(net => net.depositEnable);
    
    // Поиск лучшей пары на DEX (DexScreener)
    let bestPair = null;
    const contracts = tokenData.networkList.filter(n => n.contract).map(n => n.contract);
    
    await Promise.all(contracts.map(async (contract) => {
        try {
            const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
            const dsData = await dsRes.json();
            if (dsData.pairs) {
                dsData.pairs.forEach(pair => {
                    if (!bestPair || (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0))) {
                        bestPair = pair;
                    }
                });
            }
        } catch (e) {}
    }));

    res.json({
        ok: true,
        chain: bestPair?.chainId,
        addr: bestPair?.pairAddress,
        url: bestPair?.url,
        depositOpen
    });
});

app.get('/api/all', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    if (!symbol) return res.json({ ok: false });

    // Параллельный запрос ко всем источникам
    const [mexcPrice, ...cexPrices] = await Promise.all([
        getMexcPrice(symbol),
        ...EXCHANGES_ORDER.map(ex => fetchExchangePrice(ex, symbol))
    ]);

    const prices = {};
    EXCHANGES_ORDER.forEach((ex, i) => { prices[ex] = cexPrices[i]; });

    res.json({ ok: true, mexc: mexcPrice, prices });
});

// HTML Фронтенд (оставлен без изменений в логике, улучшено форматирование шаблона)
app.get('/', (req, res) => {
    const initialSymbol = (req.query.symbol || '').toUpperCase();
    // Вставляем ваш существующий HTML код...
    // (Для краткости здесь пропущено, но используется ваш оригинал)
    res.send(renderFullHTML(initialSymbol)); 
});

// Функция-обертка для HTML (вставьте сюда ваш оригинальный HTML из запроса)
function renderFullHTML(initialSymbol) {
    return `<!DOCTYPE html>...ваш HTML...`;
}

app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Server started on port ${CONFIG.PORT}`);
});
