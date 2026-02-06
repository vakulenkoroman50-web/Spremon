const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const WebSocket = require('ws');

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
 * GLOBAL DATA CACHE
 */
const GLOBAL_PRICES = {};
let MEXC_CONFIG_CACHE = null;

// Хранилище свечей: { "BTCUSDT": [{o, h, l, c}, ...] }
const HISTORY_OHLC = {}; 
// Текущая формируемая свеча: { "BTCUSDT": { o, h, l, c, lastMinute } }
const CURRENT_CANDLES = {};

// --- ФУНКЦИЯ ОБНОВЛЕНИЯ ЦЕНЫ ---
const updatePrice = (symbol, exchange, price) => {
    if (!symbol || !price) return;
    
    let s = symbol.toUpperCase();
    if (s.startsWith('XBT')) s = s.replace('XBT', 'BTC');
    s = s.replace(/[-_]/g, '');
    s = s.replace(/SWAP$/, '');
    s = s.replace(/USDTM?$/, ''); 
    s = s.replace(/USD$/, '');

    const p = parseFloat(price);

    if (!GLOBAL_PRICES[s]) GLOBAL_PRICES[s] = {};
    GLOBAL_PRICES[s][exchange] = p;
};

// --- МОДУЛЬ ИСТОРИИ (OHLC) ---
// Запускаем каждую секунду, чтобы ловить High/Low внутри минуты
setInterval(() => {
    const now = new Date();
    const currentMinute = Math.floor(now.getTime() / 60000); // Unix time в минутах

    Object.keys(GLOBAL_PRICES).forEach(symbol => {
        // Берем цену MEXC (приоритет), либо Binance
        const prices = GLOBAL_PRICES[symbol];
        const price = prices['MEXC'] || prices['Binance'];
        
        if (!price) return;

        // Инициализация текущей свечи, если её нет или началась новая минута
        if (!CURRENT_CANDLES[symbol] || CURRENT_CANDLES[symbol].lastMinute !== currentMinute) {
            
            // Если была старая свеча - сохраняем её в историю
            if (CURRENT_CANDLES[symbol]) {
                if (!HISTORY_OHLC[symbol]) HISTORY_OHLC[symbol] = [];
                // Клонируем объект, чтобы разорвать ссылку
                HISTORY_OHLC[symbol].push({ ...CURRENT_CANDLES[symbol] });
                // Держим только последние 15-20 свечей
                if (HISTORY_OHLC[symbol].length > 20) HISTORY_OHLC[symbol].shift();
            }

            // Создаем новую свечу
            CURRENT_CANDLES[symbol] = {
                o: price, // Open
                h: price, // High
                l: price, // Low
                c: price, // Close
                lastMinute: currentMinute
            };
        } else {
            // Обновляем текущую свечу внутри минуты
            const c = CURRENT_CANDLES[symbol];
            if (price > c.h) c.h = price; // Обновили хай
            if (price < c.l) c.l = price; // Обновили лоу
            c.c = price; // Обновили цену закрытия (текущую)
        }
    });
}, 1000);

const safeJson = (data) => {
    try { return JSON.parse(data); } catch (e) { return null; }
};

/**
 * --- GLOBAL MONITORS ---
 */
// 1. MEXC GLOBAL
const initMexcGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://contract.mexc.com/edge');
            ws.on('open', () => {
                console.log('[MEXC] Connected Global');
                ws.send(JSON.stringify({ "method": "sub.tickers", "param": {} }));
            });
            ws.on('message', (data) => {
                const d = safeJson(data);
                if (!d) return;
                if (d.method === 'ping') { ws.send(JSON.stringify({ "method": "pong" })); return; }
                if (d.channel === 'push.tickers' && d.data) {
                    const items = Array.isArray(d.data) ? d.data : [d.data];
                    items.forEach(i => updatePrice(i.symbol, 'MEXC', i.lastPrice));
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

// 2. BINANCE GLOBAL
const initBinanceGlobal = () => {
    let ws = null;
    const connect = () => {
        try {
            ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr'); 
            ws.on('open', () => console.log('[Binance] Connected Global'));
            ws.on('message', (data) => {
                const arr = safeJson(data);
                if (Array.isArray(arr)) {
                    arr.forEach(i => updatePrice(i.s, 'Binance', i.c));
                }
            });
            ws.on('error', () => {});
            ws.on('close', () => setTimeout(connect, 3000));
        } catch (e) { setTimeout(connect, 5000); }
    };
    connect();
};

// POLLERS
const initBybitGlobal = () => {
    setInterval(async () => {
        try { if (!fetch) return; const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear'); const d = await res.json(); if (d.result && d.result.list) d.result.list.forEach(i => updatePrice(i.symbol, 'Bybit', i.lastPrice)); } catch(e) {}
    }, 1500);
};
const initGateGlobal = () => {
    setInterval(async () => {
        try { if (!fetch) return; const res = await fetch('https://api.gateio.ws/api/v4/futures/usdt/tickers'); const data = await res.json(); if (Array.isArray(data)) data.forEach(i => updatePrice(i.contract, 'Gate', i.last)); } catch(e) {}
    }, 2000);
};
const initBitgetGlobal = () => {
    setInterval(async () => {
        try { if (!fetch) return; const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'); const d = await res.json(); if (d.data) d.data.forEach(i => updatePrice(i.symbol, 'Bitget', i.lastPr)); } catch(e) {}
    }, 2000);
};
const initOkxGlobal = () => {
    setInterval(async () => {
        try { if (!fetch) return; const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP'); const d = await res.json(); if (d.data) d.data.forEach(i => { if (i.instId.endsWith('USDT-SWAP')) updatePrice(i.instId, 'OKX', i.last); }); } catch(e) {}
    }, 2000);
};
const initBingxGlobal = () => {
    setInterval(async () => {
        try { if (!fetch) return; const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker'); const d = await res.json(); if (d.data) d.data.forEach(i => updatePrice(i.symbol, 'BingX', i.lastPrice)); } catch(e) {}
    }, 2000);
};
const initKucoinGlobal = () => {
    setInterval(async () => {
        try { if (!fetch) return; const res = await fetch('https://api-futures.kucoin.com/api/v1/allTickers'); const d = await res.json(); if (d.data && Array.isArray(d.data)) d.data.forEach(i => updatePrice(i.symbol, 'Kucoin', i.price)); } catch(e) {}
    }, 2000);
};

initMexcGlobal();
initBinanceGlobal();
initBybitGlobal();
initGateGlobal();
initBitgetGlobal();
initOkxGlobal();
initBingxGlobal();
initKucoinGlobal();

// --- SERVER SETUP ---

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let fetch;
(async () => {
    fetch = (await import('node-fetch')).default;
    updateMexcConfigCache();
})();

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

async function updateMexcConfigCache() {
    try {
        if (!fetch) return;
        const data = await mexcPrivateRequest("/api/v3/capital/config/getall");
        if (data && Array.isArray(data)) MEXC_CONFIG_CACHE = data;
    } catch (e) {}
}
setInterval(updateMexcConfigCache, 60000);

// --- API ROUTES ---

app.get('/api/resolve', authMiddleware, async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    let data = MEXC_CONFIG_CACHE;
    if (!data) data = await mexcPrivateRequest("/api/v3/capital/config/getall");
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
    res.json({ ok: true, chain: bestPair?.chainId, addr: bestPair?.pairAddress, url: bestPair?.url, depositOpen });
});

app.get('/api/all', authMiddleware, async (req, res) => {
    let symbol = (req.query.symbol || '').toUpperCase();
    symbol = symbol.replace('USDT', '');
    if (!symbol) return res.json({ ok: false });

    const marketData = GLOBAL_PRICES[symbol] || {};
    const mexcPrice = marketData['MEXC'] || 0;

    const prices = {};
    EXCHANGES_ORDER.forEach(ex => {
        prices[ex] = marketData[ex] || 0;
    });

    // Формируем историю для графика
    let candles = HISTORY_OHLC[symbol] ? [...HISTORY_OHLC[symbol]] : [];
    // Добавляем текущую "живую" свечу, если она есть
    if (CURRENT_CANDLES[symbol]) {
        candles.push(CURRENT_CANDLES[symbol]);
    }
    // Ограничиваем 15 последними
    if (candles.length > 15) candles = candles.slice(-15);

    res.json({ ok: true, mexc: mexcPrice, prices, candles });
});

app.get('/', (req, res) => {
    // --- SERVER SIDE AUTH CHECK ---
    if (req.query.token !== CONFIG.SECRET_TOKEN) {
        // Если токен не верен, отдаем просто текст
        return res.status(403).send("Доступ запрещён!");
    }

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
#output { white-space: pre; line-height: 1.1; min-height: 280px; position: relative; }
.control-row { display: flex; gap: 5px; margin-top: 0; flex-wrap: wrap; }
#symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 280px; background: #000; color: #fff; border: 1px solid #444; }
#startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
#mexcBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
#dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 5px; }
.dex-row { color: #00ff00; }
.best { color: #ffff00; }
.closed { color: #ff0000 !important; }
.blink-dot { animation: blink 1s infinite; display: inline-block; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
.url-search-container { display: flex; gap: 5px; align-items: center; font-family: Arial, sans-serif; margin-top: 20px; }
#urlInput { width: 46%; padding: 10px; font-size: 36px; background-color: #222; color: #fff; border: 1px solid #444; outline: none; font-family: Arial, sans-serif; }
#goBtn { padding: 10px 20px; font-size: 36px; cursor: pointer; background-color: #333; color: #fff; border: 1px solid #555; font-family: Arial, sans-serif; }
#goBtn:hover { background-color: #888; }

/* Chart Styles */
#chart-container {
    margin-top: 10px;
    width: 100%;
    /* Ограничиваем ширину примерно по ширине инпутов + кнопок */
    max-width: 420px; 
    height: 100px;
    border: 1px solid #222;
    background: #050505;
    position: relative;
}
svg { width: 100%; height: 100%; display: block; }
.candle-wick { stroke-width: 1; }
.candle-body { stroke: none; }
.green { stroke: #00ff00; fill: #00ff00; }
.red { stroke: #ff0000; fill: #ff0000; }
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

<div id="chart-container"></div>

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
const urlInput = document.getElementById("urlInput");
const chartContainer = document.getElementById("chart-container");

if(urlInput) {
    urlInput.addEventListener("keydown", function(event) { if (event.key === "Enter") go(); });
}
function go() {
    let query = urlInput.value.trim();
    if (!query) return;
    const isUrl = query.startsWith("http://") || query.startsWith("https://") || (query.includes(".") && !query.includes(" "));
    let targetUrl;
    if (isUrl) {
        targetUrl = query;
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) targetUrl = "https://" + targetUrl;
    } else {
        targetUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);
    }
    window.open(targetUrl, '_blank');
}
function formatP(p) { return (p && p != 0) ? parseFloat(p).toString() : "0"; }  

// --- РИСОВАНИЕ ГРАФИКА (SVG) ---
function renderChart(candles) {
    if (!candles || candles.length < 2) {
        chartContainer.innerHTML = '';
        return;
    }

    // Находим мин/макс диапазон
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    candles.forEach(c => {
        if(c.l < minPrice) minPrice = c.l;
        if(c.h > maxPrice) maxPrice = c.h;
    });

    if (minPrice === Infinity) return;

    // Отступ 5% сверху и снизу для красоты
    const range = maxPrice - minPrice;
    const padding = range * 0.1; 
    const plotMin = minPrice - padding;
    const plotMax = maxPrice + padding;
    const plotRange = plotMax - plotMin;

    const w = 100; // Виртуальная ширина 100 единиц
    const h = 100; // Виртуальная высота 100 единиц
    
    // Ширина одной свечи (с отступами)
    const candleWidth = w / 15; // Место под 15 свечей
    const gap = 2; // Отступ между свечами
    const bodyWidth = candleWidth - gap;

    let svgHtml = '<svg viewBox="0 0 100 100" preserveAspectRatio="none">';

    candles.forEach((c, index) => {
        const xCenter = (index * candleWidth) + (bodyWidth / 2);
        
        // Координаты Y (инвертированы, т.к. 0 сверху)
        // y = 100 - ((val - min) / range * 100)
        const yHigh = 100 - ((c.h - plotMin) / plotRange * 100);
        const yLow  = 100 - ((c.l - plotMin) / plotRange * 100);
        const yOpen = 100 - ((c.o - plotMin) / plotRange * 100);
        const yClose= 100 - ((c.c - plotMin) / plotRange * 100);

        const isGreen = c.c >= c.o;
        const colorClass = isGreen ? 'green' : 'red';

        // Фитиль (линия от High до Low)
        svgHtml += \`<line x1="\${xCenter}" y1="\${yHigh}" x2="\${xCenter}" y2="\${yLow}" class="candle-wick \${colorClass}" />\`;

        // Тело свечи
        // SVG rect не умеет отрицательную высоту, поэтому вычисляем верх и высоту
        const rectY = Math.min(yOpen, yClose);
        const rectH = Math.abs(yClose - yOpen) || 0.5; // Минимальная высота если open==close
        const rectX = xCenter - (bodyWidth / 2);

        svgHtml += \`<rect x="\${rectX}" y="\${rectY}" width="\${bodyWidth}" height="\${rectH}" class="candle-body \${colorClass}" />\`;
    });

    svgHtml += '</svg>';
    chartContainer.innerHTML = svgHtml;
}

async function update() {  
    if (!symbol) return;  

    let dexPrice = 0;  
    if (chain && addr) {  
        try {  
            const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);  
            const d = await r.json();  
            if (d.pair) {  
                dexPrice = parseFloat(d.pair.priceUsd);  
                let pStr = d.pair.priceUsd;
                let sStr = symbol;
                const maxLen = 18; 
                if ((sStr.length + pStr.length + 2) > maxLen) {
                    let spaceForName = maxLen - pStr.length - 2;
                    if (spaceForName < 3) spaceForName = 3;
                    sStr = sStr.substring(0, spaceForName);
                }
                document.title = sStr + ': ' + pStr;
                dexLink.value = d.pair.url;  
            }  
        } catch(e) {}  
    }  
    blink = !blink;  
    try {  
        const res = await fetch('/api/all?symbol=' + symbol + '&token=' + token);  
        if (res.status === 403) {  
            window.location.reload(); // Перезагрузка, чтобы сработал серверный чек
            return;  
        }  
        const data = await res.json();  
        if(!data.ok) return;  
        
        if (!dexPrice && data.mexc) {
             let pStr = formatP(data.mexc);
             let sStr = symbol;
             const maxLen = 18; 
             if ((sStr.length + pStr.length + 2) > maxLen) {
                let spaceForName = maxLen - pStr.length - 2;
                if (spaceForName < 3) spaceForName = 3;
                sStr = sStr.substring(0, spaceForName);
            }
            document.title = sStr + ': ' + pStr;
        }

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
        
        // Рисуем график
        if(data.candles) renderChart(data.candles);

    } catch(e) {}  
}  
async function start() {  
    let val = input.value.trim();  
    if(!val) return;  
    
    if(timer) clearInterval(timer);  
    output.innerHTML = "Поиск...";  
    
    if (val.includes("dexscreener.com")) {  
        try {  
            const parts = val.split('/');  
            chain = parts[parts.length - 2];  
            addr = parts[parts.length - 1].split('?')[0];  
            fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr)
                .then(r => r.json())
                .then(dsData => {
                     if (dsData.pair) {  
                        symbol = dsData.pair.baseToken.symbol.toUpperCase();  
                        input.value = symbol;  
                        dexLink.value = dsData.pair.url;  
                    } 
                });
        } catch(e) { output.innerHTML = "Ошибка ссылки!"; return; }  
    } else {  
        symbol = val.toUpperCase();  
    }  

    const url = new URL(window.location);  
    url.searchParams.set('symbol', symbol);  
    window.history.replaceState({}, '', url);  

    update();  
    timer = setInterval(update, 1000);  

    try {  
        const res = await fetch('/api/resolve?symbol=' + symbol + '&token=' + token);  
        if (res.status === 403) return;  
        const d = await res.json();  
        if (d.ok) {   
            chain = d.chain;   
            addr = d.addr;   
            dexLink.value = d.url || '';   
            depositOpen = d.depositOpen;   
            
            if(chain) url.searchParams.set('chain', chain);  
            if(addr) url.searchParams.set('addr', addr);  
            window.history.replaceState({}, '', url);  
        } else {  
            depositOpen = true;  
        }  
    } catch(e) {}  
}  
document.getElementById("startBtn").onclick = start;  
document.getElementById("mexcBtn").onclick = function() {
    let val = input.value.trim().toUpperCase();
    if(val) window.location.href = "mxcappscheme://kline?extra_page_name=其他&trade_pair=" + val + "_USDT&contract=1";
};
input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });  

if (urlParams.get('symbol')) start();  
</script>  
</body>  
</html>  
    `); 
});

app.listen(CONFIG.PORT, () => console.log(`🚀 Server running on port ${CONFIG.PORT}`));
        
