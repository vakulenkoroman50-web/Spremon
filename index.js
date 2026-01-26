const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN; // Хранится только в ENV
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';

const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];

function signMexc(params) {
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHmac('sha256', MEXC_API_SECRET).update(queryString).digest('hex');
}

async function mexcPrivateGet(path, params = {}) {
    if (!MEXC_API_KEY || !MEXC_API_SECRET) return null;
    try {
        const fetch = (await import('node-fetch')).default;
        params.timestamp = Date.now();
        params.signature = signMexc(params);
        const query = new URLSearchParams(params).toString();
        const res = await fetch(`https://api.mexc.com${path}?${query}`, {
            headers: { 'X-MEXC-APIKEY': MEXC_API_KEY }
        });
        return await res.json();
    } catch (e) { return null; }
}

// Проверка токена во всех API запросах
app.get('/api/resolve', async (req, res) => {
    if (req.query.token !== SECRET_TOKEN) return res.status(403).json({ ok: false, msg: "Access denied" });
    
    const symbol = (req.query.symbol || '').toUpperCase();
    const data = await mexcPrivateGet("/api/v3/capital/config/getall");
    if (!data || !Array.isArray(data)) return res.json({ ok: false });

    const tokenData = data.find(t => t.coin === symbol);
    if (!tokenData || !tokenData.networkList) return res.json({ ok: false });

    let bestPair = null;
    const fetch = (await import('node-fetch')).default;

    for (const net of tokenData.networkList) {
        if (!net.contract) continue;
        try {
            const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${net.contract}`);
            const dsData = await dsRes.json();
            if (dsData.pairs) {
                dsData.pairs.forEach(pair => {
                    if (!bestPair || (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0))) {
                        bestPair = pair;
                    }
                });
            }
        } catch (e) {}
    }
    if (bestPair) {
        res.json({ ok: true, chain: bestPair.chainId, addr: bestPair.pairAddress, url: bestPair.url });
    } else {
        res.json({ ok: false });
    }
});

app.get('/api/all', async (req, res) => {
    if (req.query.token !== SECRET_TOKEN) return res.status(403).json({ ok: false });
    
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const mexc = await getMexcPrice(symbol);
    const prices = {};
    
    await Promise.all(exchangesOrder.map(async ex => { 
        prices[ex] = await getExPrice(ex, symbol); 
    }));
    
    res.json({ ok: true, mexc, prices });
});

async function getMexcPrice(symbol) {
    try {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}_USDT`);
        const d = await res.json();
        return parseFloat(d.data?.lastPrice) || 0;
    } catch (e) { return 0; }
}

async function getExPrice(ex, symbol) {
    const pair = symbol + 'USDT';
    try {
        const fetch = (await import('node-fetch')).default;
        let url, p;
        switch(ex) {
            case 'Binance': url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`; break;
            case 'Kucoin': url = `https://api-futures.kucoin.com/api/v1/ticker?symbol=${symbol==='BTC'?'XBT':symbol}USDTM`; break;
            case 'BingX': url = `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}-USDT`; break;
            case 'Bybit': url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`; break;
            case 'Bitget': url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${pair}&productType=USDT-FUTURES`; break;
            case 'OKX': url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT-SWAP`; break;
            case 'Gate': url = `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}_USDT`; break;
        }
        const r = await fetch(url);
        const d = await r.json();
        if (ex==='Binance') p=d.price;
        else if (ex==='Kucoin') p=d.data?.price;
        else if (ex==='BingX') p=d.data?.lastPrice;
        else if (ex==='Bybit') p=d.result?.list?.[0]?.lastPrice;
        else if (ex==='Bitget') p=d.data?.[0]?.lastPr;
        else if (ex==='OKX') p=d.data?.[0]?.last;
        else if (ex==='Gate') p=d.last || (d[0] && d[0].last);
        return parseFloat(p) || 0;
    } catch(e) { return 0; }
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8">
    <title>Crypto Monitor</title>
    <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; font-family: monospace; font-size: 28px; color: #fff; padding: 10px; overflow: hidden; }
    #output { white-space: pre; line-height: 1.1; height: 320px; }
    .control-row { display: flex; gap: 5px; margin-top: 10px; }
    #symbolInput { font-family: monospace; font-size: 28px; width: 150px; background: #000; color: #fff; border: 1px solid #444; padding: 5px; }
    #startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 20px; }
    #dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 5px; }
    .dex-row { color: #00ff00; }
    .best { color: #ffff00; }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    </style>
    </head>
    <body>
      <div id="output">Готов к работе...</div>
      
      <div class="control-row">
        <input id="symbolInput" placeholder="SYMBOL OR LINK" autocomplete="off" />
        <button id="startBtn">СТАРТ</button>
      </div>

      <input id="dexLink" readonly placeholder="DEX URL" onclick="this.select(); document.execCommand('copy');" />
      <div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>

    <script>
    const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
    
    // Считываем токен из URL один раз при загрузке
    const urlParams = new URLSearchParams(window.location.search);
    const apiToken = urlParams.get('token') || '';
    
    let currentSymbol = '', chain = null, addr = null;
    let timer = null, blink = false;

    const output = document.getElementById("output");
    const input = document.getElementById("symbolInput");
    const dexLink = document.getElementById("dexLink");
    const statusEl = document.getElementById("status");

    function formatP(p) { 
        return (p && p != 0) ? parseFloat(p).toString() : "0";
    }

    async function update() {
        blink = !blink;
        let dexPrice = 0;

        if (chain && addr) {
            try {
                const r = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);
                const d = await r.json();
                if (d.pair) {
                    dexPrice = parseFloat(d.pair.priceUsd);
                    document.title = currentSymbol + ': ' + d.pair.priceUsd;
                    dexLink.value = d.pair.url;
                }
            } catch(e) {}
        }

        try {
            // Передаем токен в каждом запросе
            const res = await fetch('/api/all?symbol=' + currentSymbol + '&token=' + apiToken);
            if (res.status === 403) {
                output.innerHTML = "<span style='color:red'>ОШИБКА: ТОКЕН НЕВЕРЕН</span>";
                clearInterval(timer);
                return;
            }
            
            const data = await res.json();
            if(!data.ok) return;

            let dot = blink ? '<span class="blink-dot">●</span>' : '○';
            let lines = [dot + ' ' + currentSymbol + ' MEXC: ' + formatP(data.mexc)];

            if (dexPrice > 0) {
                let diff = ((dexPrice - data.mexc) / data.mexc * 100).toFixed(2);
                lines.push('<span class="dex-row">  DEX     : ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');
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
                    let isBest = (ex === bestEx);
                    let mark = isBest ? '◆' : '◇';
                    let cls = isBest ? 'class="best"' : '';
                    lines.push('<span ' + cls + '>' + mark + ' ' + ex.padEnd(8, ' ') + ': ' + formatP(p) + ' (' + (diff > 0 ? "+" : "") + diff + '%)</span>');
                }
            });

            output.innerHTML = lines.join("<br>");
            statusEl.textContent = "Last Update: " + new Date().toLocaleTimeString();
        } catch(e) {}
    }

    async function start() {
        let val = input.value.trim();
        if(!val) return;
        
        if(timer) clearInterval(timer);
        output.innerHTML = "Инициализация...";
        
        if (val.includes("dexscreener.com")) {
            try {
                const parts = val.split('/');
                chain = parts[parts.length - 2];
                addr = parts[parts.length - 1].split('?')[0];
                
                const dsRes = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);
                const dsData = await dsRes.json();
                
                if (dsData.pair) {
                    currentSymbol = dsData.pair.baseToken.symbol.toUpperCase();
                    input.value = currentSymbol;
                }
            } catch(e) {
                output.innerHTML = "Ошибка ссылки DEX";
                return;
            }
        } else {
            currentSymbol = val.toUpperCase();
            chain = null; addr = null;
            try {
                // Здесь тоже нужен токен для резолва
                const res = await fetch('/api/resolve?symbol=' + currentSymbol + '&token=' + apiToken);
                const d = await res.json();
                if (d.ok) {
                    chain = d.chain; addr = d.addr; dexLink.value = d.url;
                }
            } catch(e) {}
        }

        update();
        timer = setInterval(update, 1000);
    }

    document.getElementById("startBtn").onclick = start;
    input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
