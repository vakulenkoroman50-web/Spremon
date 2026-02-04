const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const WebSocket = require('ws'); // Требуется: npm install ws

/**
 * КОНФИГУРАЦИЯ
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
 * WEBSOCKET MANAGER
 * Управляет соединениями с биржами.
 * Если пользователь меняет символ, старые сокеты закрываются, новые открываются.
 */
let activeSymbol = null;
let priceCache = {};
let activeSockets = [];

// Сброс кэша для конкретной биржи или всего сразу
const resetCache = (exchange = null) => {
    if (exchange) priceCache[exchange] = 0;
    else EXCHANGES_ORDER.forEach(ex => priceCache[ex] = 0);
};

// Функция безопасного парсинга JSON
const safeJson = (data) => {
    try { return JSON.parse(data); } catch (e) { return null; }
};

// Генераторы подключений для каждой биржи
const WS_CONNECTORS = {
    Binance: (symbol) => {
        const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}usdt@aggTrade`);
        ws.on('message', (data) => {
            const d = safeJson(data);
            if (d && d.p) priceCache['Binance'] = parseFloat(d.p);
        });
        return ws;
    },
    Bybit: (symbol) => {
        const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
        ws.on('open', () => {
            ws.send(JSON.stringify({ "op": "subscribe", "args": [`publicTrade.${symbol}USDT`] }));
        });
        ws.on('message', (data) => {
            const d = safeJson(data);
            if (d && d.topic && d.data && d.data[0]) priceCache['Bybit'] = parseFloat(d.data[0].p);
        });
        return ws;
    },
    Gate: (symbol) => {
        const ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
        ws.on('open', () => {
            ws.send(JSON.stringify({
                "time": Date.now(),
                "channel": "futures.tickers",
                "event": "subscribe",
                "payload": [`${symbol}_USDT`]
            }));
        });
        ws.on('message', (data) => {
            const d = safeJson(data);
            if (d && d.event === 'update' && d.result && d.result[0]) {
                priceCache['Gate'] = parseFloat(d.result[0].last);
            }
        });
        return ws;
    },
    Bitget: (symbol) => {
        const ws = new WebSocket('wss://ws.bitget.com/v2/ws/public');
        ws.on('open', () => {
            ws.send(JSON.stringify({
                "op": "subscribe",
                "args": [{ "instType": "USDT-FUTURES", "channel": "ticker", "instId": `${symbol}USDT` }]
            }));
        });
        ws.on('message', (data) => {
            const d = safeJson(data);
            if (d && d.action === 'snapshot' && d.data && d.data[0]) {
                priceCache['Bitget'] = parseFloat(d.data[0].lastPr);
            }
        });
        return ws;
    },
    BingX: (symbol) => {
        const ws = new WebSocket('wss://open-api-swap.bingx.com/swap-market');
        ws.on('open', () => {
            ws.send(JSON.stringify({
                "id": "id1",
                "reqType": "sub",
                "dataType": `${symbol}-USDT@ticker`
            }));
        });
        ws.on('message', (data) => {
            // BingX использует GZIP иногда, но на простых стримах часто plaintext JSON
            // Если приходят кракозябры, нужен zlib, но обычно ticker идет текстом или JSON
            const d = safeJson(data);
            if (d && d.data && d.data.c) priceCache['BingX'] = parseFloat(d.data.c);
        });
        return ws;
    },
    OKX: (symbol) => {
        const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
        ws.on('open', () => {
            ws.send(JSON.stringify({
                "op": "subscribe",
                "args": [{ "channel": "tickers", "instId": `${symbol}-USDT-SWAP` }]
            }));
        });
        ws.on('message', (data) => {
            const d = safeJson(data);
            if (d && d.data && d.data[0]) priceCache['OKX'] = parseFloat(d.data[0].last);
        });
        return ws;
    },
    // Kucoin сложен для WS без токена, оставляем на HTTP Fallback
    Kucoin: null 
};

// Специальный WS для MEXC (основная биржа)
let mexcWs = null;
const startMexcWs = (symbol) => {
    if (mexcWs) mexcWs.terminate();
    mexcWs = new WebSocket('wss://contract.mexc.com/edge');
    mexcWs.on('open', () => {
        mexcWs.send(JSON.stringify({ "method": "sub.ticker", "params": { "symbol": `${symbol}_USDT` } }));
    });
    mexcWs.on('message', (data) => {
        const d = safeJson(data);
        if (d && d.channel === 'push.ticker' && d.data) {
            priceCache['MEXC'] = parseFloat(d.data.lastPrice);
        }
    });
};

const switchSubscription = (newSymbol) => {
    if (!newSymbol || newSymbol === activeSymbol) return;
    
    console.log(`[WS] Switching symbol: ${activeSymbol} -> ${newSymbol}`);
    
    // Закрываем старые
    activeSockets.forEach(ws => {
        try { ws.terminate(); } catch(e){}
    });
    activeSockets = [];
    
    activeSymbol = newSymbol;
    resetCache(); // Обнуляем цены перед новыми данными

    // Запускаем новые
    Object.keys(WS_CONNECTORS).forEach(ex => {
        const connector = WS_CONNECTORS[ex];
        if (connector) {
            try {
                const ws = connector(newSymbol);
                ws.on('error', () => {}); // Игнорируем ошибки соединения
                activeSockets.push(ws);
            } catch (e) {
                console.error(`Error connecting to ${ex}`, e);
            }
        }
    });

    // Отдельно MEXC
    startMexcWs(newSymbol);
};

/**
 * АДАПТЕРЫ БИРЖ (HTTP FALLBACK)
 * Используются для Kucoin и для первого "холодного" старта
 */
const CEX_HTTP_ADAPTERS = {
    Kucoin: {
        url: (s) => `https://api-futures.kucoin.com/api/v1/ticker?symbol=${s === 'BTC' ? 'XBT' : s}USDTM`,
        parse: (d) => d.data?.price
    },
    // Для остальных бирж HTTP не нужен, но можно оставить для отладки
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Глобальный fetch
let fetch;
(async () => {
    fetch = (await import('node-fetch')).default;
})();

/**
 * MIDDLEWARE
 */
const authMiddleware = (req, res, next) => {
    if (req.query.token !== CONFIG.SECRET_TOKEN) {
        return res.status(403).json({ ok: false, msg: "AUTH_ERR" });
    }
    next();
};

/**
 * УТИЛИТЫ MEXC API
 */
const signMexc = (params) => {
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHmac('sha256', CONFIG.MEXC.SECRET).update(queryString).digest('hex');
};

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
    } catch (e) { return null; }
}

async function getMexcPriceHttp(symbol) {
    try {
        const res = await fetch(`${CONFIG.MEXC.FUTURES_URL}/api/v1/contract/ticker?symbol=${symbol}_USDT`);
        const d = await res.json();
        return parseFloat(d.data?.lastPrice) || 0;
    } catch (e) { return 0; }
}

async function fetchExchangePriceHttp(exchange, symbol) {
    const adapter = CEX_HTTP_ADAPTERS[exchange];
    // Если нет HTTP адаптера (значит используем только WS), возвращаем 0
    if (!adapter) return 0;
    try {
        const res = await fetch(adapter.url(symbol));
        const data = await res.json();
        return parseFloat(adapter.parse(data)) || 0;
    } catch (e) { return 0; }
}

/**
 * ЭНДПОИНТЫ API
 */
app.get('/api/resolve', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const data = await mexcPrivateRequest("/api/v3/capital/config/getall");
    
    if (!data || !Array.isArray(data)) return res.json({ ok: false });

    const tokenData = data.find(t => t.coin === symbol);
    if (!tokenData?.networkList) return res.json({ ok: false });

    const depositOpen = tokenData.networkList.some(net => net.depositEnable);
    
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

    // 1. Управление подписками
    // Если запрошен новый символ, переключаем вебсокеты
    if (symbol !== activeSymbol) {
        switchSubscription(symbol);
        
        // "Холодный старт": пока сокеты подключаются, сделаем один HTTP запрос для MEXC и Kucoin
        // чтобы пользователь не ждал нулей
        const [mexcHttp, kucoinHttp] = await Promise.all([
            getMexcPriceHttp(symbol),
            fetchExchangePriceHttp('Kucoin', symbol)
        ]);
        priceCache['MEXC'] = mexcHttp;
        if(kucoinHttp) priceCache['Kucoin'] = kucoinHttp;
    }

    // 2. Kucoin всегда опрашиваем по HTTP (нет простого WS)
    // Делаем это асинхронно, не блокируя ответ, если в кэше уже что-то есть
    // Но для точности лучше дождаться
    const kucoinPrice = await fetchExchangePriceHttp('Kucoin', symbol);
    if (kucoinPrice) priceCache['Kucoin'] = kucoinPrice;

    // 3. Формируем ответ из кэша (который наполняется вебсокетами в фоне)
    const prices = {};
    EXCHANGES_ORDER.forEach((ex) => { 
        prices[ex] = priceCache[ex] || 0; 
    });

    res.json({ ok: true, mexc: priceCache['MEXC'] || 0, prices });
});

/**
 * ГЛАВНАЯ СТРАНИЦА (ФРОНТЕНД)
 */
app.get('/', (req, res) => {
    const initialSymbol = (req.query.symbol || '').toUpperCase();
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Crypto Monitor</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #000; font-family: monospace; font-size: 28px; color: #fff; padding: 10px; overflow: hidden; }

/* Основной контейнер вывода */
#output { white-space: pre; line-height: 1.1; min-height: 280px; position: relative; }

.control-row { display: flex; gap: 5px; margin-top: 0; }
#symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 280px; background: #000; color: #fff; border: 1px solid #444; }
#startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
#mexcBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
#dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 5px; }

.dex-row { color: #00ff00; }
.best { color: #ffff00; }
.closed { color: #ff0000 !important; }
.blink-dot { animation: blink 1s infinite; display: inline-block; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

/* STYLES FOR URL INPUT (INJECTED) */
.url-search-container {
    display: flex;
    gap: 5px;
    align-items: center;
    font-family: Arial, sans-serif; /* Как в исходнике */
    margin-top: 20px;
}
#urlInput {
    width: 46%;
    padding: 10px;
    font-size: 36px;
    background-color: #222;
    color: #fff;
    border: 1px solid #444;
    outline: none;
    font-family: Arial, sans-serif;
}
#goBtn {
    padding: 10px 20px;
    font-size: 36px;
    cursor: pointer;
    background-color: #333;
    color: #fff;
    border: 1px solid #555;
    font-family: Arial, sans-serif;
}
#goBtn:hover {
    background-color: #888;
}
</style>
</head>
<body>

<div id="output">
    <div class="url-search-container">
        <input type="text" id="urlInput" placeholder="Введите URL или поиск">
        <button id="goBtn" onclick="go()">Go</button>
    </div>
</div>

<div class="control-row">  
    <input id="symbolInput" value="${initialSymbol}" placeholder="TICKER OR LINK" autocomplete="off" onfocus="this.select()" />  
    <button id="startBtn">СТАРТ</button>  
    <button id="mexcBtn">MEXC</button>
</div>  
<input id="dexLink" readonly placeholder="DEX URL" onclick="this.select(); document.execCommand('copy');" />  
<div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>  

<script>  
const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];  
let urlParams = new URLSearchParams(window.location.search);  
let symbol = urlParams.get('symbol')?.toUpperCase() || '';  
let token = urlParams.get('token') || '';  
let chain = urlParams.get('chain');  
let addr = urlParams.get('addr');  
let depositOpen = true;   
let timer = null, blink = false;  

const output = document.getElementById("output");  
const input = document.getElementById("symbolInput");  
const dexLink = document.getElementById("dexLink");  
const statusEl = document.getElementById("status");  

// --- LOGIC FOR URL INPUT ---
const urlInput = document.getElementById("urlInput");
if(urlInput) {
    urlInput.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            go();
        }
    });
}

function go() {
    let query = urlInput.value.trim();
    if (!query) return;

    const isUrl = query.startsWith("http://") || 
                  query.startsWith("https://") || 
                  (query.includes(".") && !query.includes(" "));
    
    let targetUrl;
    if (isUrl) {
        targetUrl = query;
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            targetUrl = "https://" + targetUrl;
        }
    } else {
        targetUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);
    }
    // Открываем в новом окне
    window.open(targetUrl, '_blank');
}
// ---------------------------

function formatP(p) { return (p && p != 0) ? parseFloat(p).toString() : "0"; }  

async function update() {  
    if (!symbol) return;  
    let dexPrice = 0;  
    if (chain && addr) {  
        try {  
            const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);  
            const d = await r.json();  
            if (d.pair) {  
                dexPrice = parseFloat(d.pair.priceUsd);  
                document.title = symbol + ': ' + d.pair.priceUsd;  
                dexLink.value = d.pair.url;  
            }  
        } catch(e) {}  
    }  

    blink = !blink;  
    try {  
        const res = await fetch('/api/all?symbol=' + symbol + '&token=' + token);  
        if (res.status === 403) {  
            output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>";  
            if(timer) clearInterval(timer);  
            return;  
        }  
        const data = await res.json();  
        if(!data.ok) return;  

        let dotColorClass = depositOpen ? '' : 'closed';  
        let dot = blink ? '<span class="blink-dot '+dotColorClass+'">●</span>' : '○';  
          
        let lines = [dot + ' ' + symbol + ' MEXC: ' + formatP(data.mexc)];  
        if (dexPrice > 0) {  
            let diff = ((dexPrice - data.mexc) / data.mexc * 100).toFixed(2);  
            lines.push('<span class="dex-row">◇ DEX     : ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');  
        }  

        let bestEx = null, maxSp = 0;  
        exchangesOrder.forEach(ex => {  
            let p = data.prices[ex];  
            if (p > 0) {  
                let sp = Math.abs((p - data.mexc) / data.mexc * 100);  
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }  
            }  
        });  

        exchangesOrder.forEach(ex => {  
            let p = data.prices[ex];  
            if (p > 0) {  
                let diff = ((p - data.mexc) / data.mexc * 100).toFixed(2);  
                let cls = (ex === bestEx) ? 'class="best"' : '';  
                let mark = (ex === bestEx) ? '◆' : '◇';  
                lines.push('<span ' + cls + '>' + mark + ' ' + ex.padEnd(8, ' ') + ': ' + formatP(p) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');  
            }  
        });  
        output.innerHTML = lines.join("<br>");  
        statusEl.textContent = "Last: " + new Date().toLocaleTimeString();  
    } catch(e) {}  
}  

async function start() {  
    let val = input.value.trim();  
    if(!val) return;  
    if (!token) {  
        output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>";  
        return;  
    }  
    if(timer) clearInterval(timer);  
    
    // Здесь мы перезаписываем содержимое output, удаляя поле URL
    output.innerHTML = "Поиск...";  
      
    if (val.includes("dexscreener.com")) {  
        try {  
            const parts = val.split('/');  
            chain = parts[parts.length - 2];  
            addr = parts[parts.length - 1].split('?')[0];  
            const dsRes = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);  
            const dsData = await dsRes.json();  
            if (dsData.pair) {  
                symbol = dsData.pair.baseToken.symbol.toUpperCase();  
                input.value = symbol;  
                dexLink.value = dsData.pair.url;  
            }  
        } catch(e) { output.innerHTML = "Ошибка ссылки!"; return; }  
    } else {  
        symbol = val.toUpperCase();  
    }  

    try {  
        const res = await fetch('/api/resolve?symbol=' + symbol + '&token=' + token);  
        if (res.status === 403) {  
            output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>";  
            return;  
        }  
        const d = await res.json();  
        if (d.ok) {   
            chain = d.chain;   
            addr = d.addr;   
            dexLink.value = d.url || '';   
            depositOpen = d.depositOpen;   
        } else {  
            depositOpen = true;  
        }  
    } catch(e) {}  
      
    const url = new URL(window.location);  
    url.searchParams.set('symbol', symbol);  
    if(chain) url.searchParams.set('chain', chain);  
    if(addr) url.searchParams.set('addr', addr);  
    window.history.replaceState({}, '', url);  
      
    update();  
    timer = setInterval(update, 1000);  
}  

document.getElementById("startBtn").onclick = start;  
document.getElementById("mexcBtn").onclick = function() {
    let val = input.value.trim().toUpperCase();
    if(val) {
        window.location.href = "mxcappscheme://kline?extra_page_name=其他&trade_pair=" + val + "_USDT&contract=1";
    }
};

input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });  

if (urlParams.get('symbol')) start();  
else if (!token) output.innerHTML = "<span style='color:red'>Доступ запрещён!</span>";  
</script>  
</body>  
</html>  
    `);
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server running on port ${CONFIG.PORT}`));
                    
