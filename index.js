const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || '777'; 
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';
const OKX_API_KEY = process.env.OKX_API_KEY || '';
const OKX_API_SECRET = process.env.OKX_API_SECRET || '';
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE || '';

const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];

// Mapping для преобразования chainId DexScreener в chainIndex OKX
const chainMapping = {
    'ethereum': '1',
    'bsc': '56',
    'polygon': '137',
    'arbitrum': '42161',
    'optimism': '10',
    'avalanche': '43114',
    'fantom': '250',
    'cronos': '25',
    'base': '8453',
    'celo': '42220',
    'zksync': '324',
    'linea': '59144',
    'mantle': '5000',
    'solana': '501',
    'ton': '600',
    'tron': '195',
    'opbnb': '204',
    'zkfair': '42766',
    'merlin': '4200',
    'blast': '81457',
    'scroll': '534352',
    'manta': '169'
};

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

// Функция для подписи OKX запросов
function signOkx(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', OKX_API_SECRET).update(message).digest('base64');
}

// Функция для получения цены через OKX Web3 API
async function getOkxDexPrice(chainIndex, tokenAddress) {
    if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_PASSPHRASE) {
        return { ok: false, error: 'Ключи OKX API не настроены' };
    }
    
    try {
        const fetch = (await import('node-fetch')).default;
        const method = 'POST';
        const requestPath = '/api/v6/dex/market/price';
        const timestamp = new Date().toISOString();
        
        const requestBody = JSON.stringify([{
            "chainIndex": chainIndex,
            "tokenContractAddress": tokenAddress
        }]);
        
        const signature = signOkx(timestamp, method, requestPath, requestBody);
        
        const response = await fetch(`https://web3.okx.com${requestPath}`, {
            method: method,
            headers: {
                'OK-ACCESS-KEY': OKX_API_KEY,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
                'Content-Type': 'application/json'
            },
            body: requestBody
        });
        
        const data = await response.json();
        
        if (data.code === '0' && data.data && data.data.length > 0) {
            return {
                ok: true,
                price: parseFloat(data.data[0].price) || 0
            };
        } else {
            let errorMsg = 'Неизвестная ошибка OKX';
            if (data.code === '50100') errorMsg = 'Неверные ключи API';
            if (data.code === '50016') errorMsg = 'Сеть не поддерживается';
            if (data.code === '51002') errorMsg = 'Токен не найден';
            return { ok: false, error: `OKX: ${errorMsg}` };
        }
    } catch (error) {
        return { ok: false, error: 'OKX: Сетевая ошибка' };
    }
}

// Функция для получения цены через DexScreener (fallback)
async function getDexScreenerPrice(chainId, tokenAddress) {
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chainId}:${tokenAddress}`);
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
            // Находим пару с наибольшим объемом
            let bestPair = data.pairs[0];
            for (const pair of data.pairs) {
                if (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0)) {
                    bestPair = pair;
                }
            }
            
            return {
                ok: true,
                price: parseFloat(bestPair.priceUsd) || 0,
                url: bestPair.url
            };
        } else {
            return { ok: false, error: 'DexScreener: Токен не найден' };
        }
    } catch (error) {
        return { ok: false, error: 'DexScreener: Ошибка сети' };
    }
}

app.get('/api/resolve', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    const data = await mexcPrivateGet("/api/v3/capital/config/getall");
    if (!data || !Array.isArray(data)) return res.json({ ok: false });

    const token = data.find(t => t.coin === symbol);
    if (!token || !token.networkList) return res.json({ ok: false });

    let bestPair = null;
    const fetch = (await import('node-fetch')).default;

    for (const net of token.networkList) {
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
        const chainIndex = chainMapping[bestPair.chainId] || null;
        res.json({ 
            ok: true, 
            chain: bestPair.chainId, 
            addr: bestPair.pairAddress, 
            url: bestPair.url,
            chainIndex: chainIndex,
            tokenAddress: bestPair.baseToken?.address || bestPair.pairAddress
        });
    } else {
        res.json({ ok: false });
    }
});

// Новый endpoint для получения DEX цены
app.get('/api/dex-price', async (req, res) => {
    const { chain, addr, chainIndex, tokenAddress } = req.query;
    
    if (!chain || !addr) {
        return res.json({ ok: false, error: 'Не указаны параметры сети или адреса' });
    }
    
    const result = {
        ok: false,
        price: 0,
        source: null,
        error: null,
        url: null
    };
    
    // Пробуем сначала OKX Web3 API
    if (chainIndex && tokenAddress) {
        const okxResult = await getOkxDexPrice(chainIndex, tokenAddress);
        if (okxResult.ok) {
            result.ok = true;
            result.price = okxResult.price;
            result.source = 'okx';
            res.json(result);
            return;
        } else {
            result.error = okxResult.error;
        }
    }
    
    // Fallback на DexScreener
    const dexResult = await getDexScreenerPrice(chain, addr);
    if (dexResult.ok) {
        result.ok = true;
        result.price = dexResult.price;
        result.source = 'dexscreener';
        result.url = dexResult.url;
    } else if (!result.error) {
        result.error = dexResult.error;
    }
    
    res.json(result);
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

app.get('/api/all', async (req, res) => {
    if (req.query.token !== SECRET_TOKEN) return res.status(403).json({ok:false});
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const mexc = await getMexcPrice(symbol);
    const prices = {};
    await Promise.all(exchangesOrder.map(async ex => { prices[ex] = await getExPrice(ex, symbol); }));
    res.json({ ok: true, mexc, prices });
});

app.get('/', (req, res) => {
    const initialSymbol = (req.query.symbol || 'BTC').toUpperCase();
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
    #symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 400px; background: #000; color: #fff; border: 1px solid #444; }
    #startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 10px; }
    #dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 5px; cursor: pointer; margin-top: 5px; }
    #errorDisplay { font-family: monospace; font-size: 16px; color: #ff4444; margin-top: 5px; min-height: 20px; }
    .dex-row { color: #00ff00; }
    .dex-okx { color: #00ff00; }
    .dex-dexscreener { color: #ff9900; }
    .best { color: #ffff00; }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    </style>
    </head>
    <body>
      <div id="output">Готов к работе</div>
      <div class="control-row">
        <input id="symbolInput" value="${initialSymbol}" autocomplete="off" onfocus="this.select()" />
        <button id="startBtn">СТАРТ</button>
      </div>
      <input id="dexLink" readonly placeholder="DEX URL" onclick="this.select(); document.execCommand('copy');" />
      <div id="errorDisplay"></div>
      <div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>

    <script>
    const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
    let urlParams = new URLSearchParams(window.location.search);
    let symbol = urlParams.get('symbol')?.toUpperCase() || 'BTC';
    let token = urlParams.get('token') || '777';
    let chain = urlParams.get('chain');
    let addr = urlParams.get('addr');
    let timer=null, blink=false;

    const output=document.getElementById("output");
    const input=document.getElementById("symbolInput");
    const dexLink=document.getElementById("dexLink");
    const errorDisplay=document.getElementById("errorDisplay");
    const statusEl=document.getElementById("status");

    function formatP(p) { 
        if(!p || p == 0) return "0";
        return parseFloat(p).toString();
    }

    async function getDexPrice() {
        if (!chain || !addr) return { price: 0, source: null, error: null, url: null };
        
        try {
            const res = await fetch('/api/dex-price?chain=' + chain + '&addr=' + addr);
            const data = await res.json();
            return data;
        } catch(e) {
            console.error('DEX price error:', e);
            return { price: 0, source: null, error: 'Ошибка сети при запросе DEX цены', url: null };
        }
    }

    async function update() {
        blink = !blink;
        const dexResult = await getDexPrice();
        let dexPrice = dexResult.price;
        let dexSource = dexResult.source;
        let dexError = dexResult.error;
        let dexUrl = dexResult.url;

        try {
            const res = await fetch('/api/all?symbol=' + symbol + '&token=' + token);
            const data = await res.json();
            if(!data.ok) return;

            let dot = blink ? '<span class="blink-dot">●</span>' : '○';
            let lines = [];
            lines.push(dot + ' ' + symbol + ' MEXC: ' + formatP(data.mexc));

            if (dexPrice > 0) {
                let diff = ((dexPrice - data.mexc) / data.mexc * 100).toFixed(2);
                let sourceLabel = dexSource === 'okx' ? '<span class="dex-okx">DEX OKX</span>' : 
                                 dexSource === 'dexscreener' ? '<span class="dex-dexscreener">DEX</span>' : 'DEX';
                lines.push('  ' + sourceLabel + '    : ' + formatP(dexPrice) + ' (' + (diff > 0 ? "+" : "") + diff + '%)');
                
                if (dexUrl) {
                    dexLink.value = dexUrl;
                    document.title = symbol + ': ' + dexPrice;
                }
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
            statusEl.textContent = "Last: " + new Date().toLocaleTimeString();
            
            // Отображаем ошибки, если есть
            if (dexError) {
                errorDisplay.textContent = "⚠️ " + dexError;
                errorDisplay.style.display = 'block';
            } else {
                errorDisplay.style.display = 'none';
            }
        } catch(e) {}
    }

    async function start() {
        let val = input.value.trim();
        if(!val) return;
        
        if(timer) clearInterval(timer);
        output.innerHTML = "Обработка...";
        dexLink.value = "";
        errorDisplay.textContent = "";
        errorDisplay.style.display = 'none';
        
        // 1. Проверяем, не ссылка ли это DexScreener
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
            } catch(e) {
                output.innerHTML = "Ошибка ссылки!";
                return;
            }
        } else {
            // Если это просто тикер
            symbol = val.toUpperCase();
            chain = null; addr = null;
            try {
                const res = await fetch('/api/resolve?symbol=' + symbol + '&token=' + token);
                const d = await res.json();
                if (d.ok) {
                    chain = d.chain; 
                    addr = d.addr; 
                    dexLink.value = d.url;
                    
                    // Добавляем chainIndex и tokenAddress в URL для OKX API
                    const url = new URL(window.location);
                    url.searchParams.set('symbol', symbol);
                    url.searchParams.set('chain', chain);
                    url.searchParams.set('addr', addr);
                    if (d.chainIndex) url.searchParams.set('chainIndex', d.chainIndex);
                    if (d.tokenAddress) url.searchParams.set('tokenAddress', d.tokenAddress);
                    window.history.replaceState({}, '', url);
                }
            } catch(e) {}
        }

        const url = new URL(window.location);
        url.searchParams.set('symbol', symbol);
        if(chain) url.searchParams.set('chain', chain);
        if(addr) url.searchParams.set('addr', addr);
        window.history.replaceState({}, '', url);

        update();
        timer = setInterval(update, 1000);
    }

    document.getElementById("startBtn").onclick = start;
    input.addEventListener("keypress", (e) => { if(e.key === "Enter") start(); });

    if (urlParams.get('symbol')) {
        start();
    } else {
        update();
        timer = setInterval(update, 1000);
    }
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
