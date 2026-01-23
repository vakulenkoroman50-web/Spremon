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

// Mapping для преобразования chainId DexScreener -> chainIndex OKX
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

// --- MEXC API ФУНКЦИИ ---
function signMexc(params) {
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHmac('sha256', MEXC_API_SECRET).update(queryString).digest('hex');
}

async function mexcPrivateGet(path, params = {}) {
    if (!MEXC_API_KEY || !MEXC_API_SECRET) {
        console.log('MEXC API ключи не настроены');
        return null;
    }
    try {
        const fetch = (await import('node-fetch')).default;
        params.timestamp = Date.now();
        params.signature = signMexc(params);
        const query = new URLSearchParams(params).toString();
        const res = await fetch(`https://api.mexc.com${path}?${query}`, {
            headers: { 'X-MEXC-APIKEY': MEXC_API_KEY }
        });
        return await res.json();
    } catch (e) {
        console.error('MEXC API Error:', e);
        return null;
    }
}

// --- OKX WEB3 API ФУНКЦИИ ---
function signOkx(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    return crypto.createHmac('sha256', OKX_API_SECRET).update(message).digest('base64');
}

async function getOkxDexPrice(chainIndex, tokenAddress) {
    if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_PASSPHRASE) {
        console.log('OKX API ключи не настроены');
        return { ok: false, error: 'Ключи OKX API не настроены на сервере' };
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

        console.log(`OKX Request: chainIndex=${chainIndex}, tokenAddress=${tokenAddress}`);
        console.log(`OKX Request Body: ${requestBody}`);

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
        console.log('OKX Response:', JSON.stringify(data, null, 2));

        if (data.code === '0' && data.data && data.data.length > 0 && data.data[0].price) {
            return {
                ok: true,
                price: parseFloat(data.data[0].price) || 0,
                source: 'okx'
            };
        } else {
            let errorMsg = 'Неизвестная ошибка OKX';
            if (data.code === '50100') errorMsg = 'Неверные ключи API или подпись';
            if (data.code === '50016') errorMsg = 'Сеть не поддерживается';
            if (data.code === '51002') errorMsg = 'Токен не найден';
            if (data.msg) errorMsg = data.msg;
            return { ok: false, error: `OKX: ${errorMsg}` };
        }
    } catch (error) {
        console.error('OKX API Network Error:', error);
        return { ok: false, error: 'OKX: Сетевая ошибка при запросе' };
    }
}

// --- DEXSCREENER API ФУНКЦИИ ---
async function getDexScreenerPrice(chainId, pairAddress) {
    try {
        const fetch = (await import('node-fetch')).default;
        
        // Используем правильный endpoint для поиска по адресу пары
        const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
        console.log(`DexScreener Request: ${url}`);
        
        const response = await fetch(url);
        const data = await response.json();
        
        console.log('DexScreener Response:', JSON.stringify(data, null, 2));

        if (data.pair && data.pair.priceUsd) {
            return {
                ok: true,
                price: parseFloat(data.pair.priceUsd) || 0,
                url: data.pair.url,
                source: 'dexscreener'
            };
        } else {
            return { ok: false, error: 'DexScreener: Пара не найдена' };
        }
    } catch (error) {
        console.error('DexScreener API Error:', error);
        return { ok: false, error: 'DexScreener: Ошибка сети или API' };
    }
}

// --- API ENDPOINTS ---

// Поиск токена через MEXC
app.get('/api/resolve', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase();
    console.log(`Resolve request for symbol: ${symbol}`);

    const data = await mexcPrivateGet("/api/v3/capital/config/getall");
    
    if (!data || !Array.isArray(data)) {
        console.log('Invalid MEXC response or not an array');
        return res.json({ ok: false, error: 'Ошибка получения данных от MEXC' });
    }

    const token = data.find(t => t.coin === symbol);
    if (!token || !token.networkList) {
        console.log(`Token ${symbol} not found in MEXC data`);
        return res.json({ ok: false, error: 'Токен не найден в MEXC' });
    }

    let bestPair = null;
    const fetch = (await import('node-fetch')).default;

    for (const net of token.networkList) {
        if (!net.contract) continue;
        try {
            // Ищем по адресу токена, чтобы найти все пары
            const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${net.contract}`);
            const dsData = await dsRes.json();
            if (dsData.pairs && dsData.pairs.length > 0) {
                dsData.pairs.forEach(pair => {
                    if (!bestPair || (parseFloat(pair.volume?.h24 || 0) > parseFloat(bestPair.volume?.h24 || 0))) {
                        bestPair = pair;
                    }
                });
            }
        } catch (e) {
            console.error(`Error searching token ${net.contract}:`, e);
        }
    }
    
    if (bestPair) {
        const chainIndex = chainMapping[bestPair.chainId] || null;
        const result = {
            ok: true,
            chain: bestPair.chainId,
            addr: bestPair.pairAddress,
            url: bestPair.url,
            chainIndex: chainIndex,
            tokenAddress: bestPair.baseToken?.address || bestPair.pairAddress
        };
        console.log('Resolve result:', result);
        res.json(result);
    } else {
        console.log('No pairs found for token');
        res.json({ ok: false, error: 'Не найдено торговых пар для токена' });
    }
});

// Получение DEX цены (OKX -> DexScreener fallback)
app.get('/api/dex-price', async (req, res) => {
    const { chain, addr, chainIndex, tokenAddress } = req.query;
    
    console.log(`DEX Price request: chain=${chain}, addr=${addr}, chainIndex=${chainIndex}, tokenAddress=${tokenAddress}`);

    if (!chain || !addr) {
        console.log('Missing chain or addr parameters');
        return res.json({ ok: false, error: 'Не указаны параметры сети или адреса' });
    }
    
    const result = {
        ok: false,
        price: 0,
        source: null,
        error: null,
        url: null
    };
    
    // 1. Пробуем сначала OKX Web3 API (только если есть chainIndex и tokenAddress)
    if (chainIndex && tokenAddress && tokenAddress.startsWith('0x')) {
        console.log('Trying OKX API first...');
        const okxResult = await getOkxDexPrice(chainIndex, tokenAddress);
        
        if (okxResult.ok) {
            console.log('OKX API success');
            result.ok = true;
            result.price = okxResult.price;
            result.source = okxResult.source;
            res.json(result);
            return;
        } else {
            console.log('OKX API failed:', okxResult.error);
            result.error = okxResult.error;
        }
    } else {
        console.log('Skipping OKX API: missing chainIndex or tokenAddress');
        result.error = 'Недостаточно данных для запроса к OKX API';
    }
    
    // 2. Fallback на DexScreener
    console.log('Trying DexScreener as fallback...');
    const dexResult = await getDexScreenerPrice(chain, addr);
    
    if (dexResult.ok) {
        console.log('DexScreener success');
        result.ok = true;
        result.price = dexResult.price;
        result.source = dexResult.source;
        result.url = dexResult.url;
        result.error = null; // Очищаем ошибку, если DexScreener сработал
    } else {
        console.log('DexScreener failed:', dexResult.error);
        if (!result.error) {
            result.error = dexResult.error;
        }
    }
    
    console.log('Final DEX price result:', result);
    res.json(result);
});

// Получение цен с централизованных бирж
async function getMexcPrice(symbol) {
    try {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}_USDT`);
        const d = await res.json();
        return parseFloat(d.data?.lastPrice) || 0;
    } catch (e) {
        console.error(`MEXC price error for ${symbol}:`, e);
        return 0;
    }
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
        if (ex==='Binance') p = d.price;
        else if (ex==='Kucoin') p = d.data?.price;
        else if (ex==='BingX') p = d.data?.lastPrice;
        else if (ex==='Bybit') p = d.result?.list?.[0]?.lastPrice;
        else if (ex==='Bitget') p = d.data?.[0]?.lastPr;
        else if (ex==='OKX') p = d.data?.[0]?.last;
        else if (ex==='Gate') p = d.last || (d[0] && d[0].last);
        return parseFloat(p) || 0;
    } catch(e) {
        console.error(`${ex} price error for ${symbol}:`, e);
        return 0;
    }
}

app.get('/api/all', async (req, res) => {
    if (req.query.token !== SECRET_TOKEN) {
        console.log('Invalid SECRET_TOKEN');
        return res.status(403).json({ok: false, error: 'Неверный токен доступа'});
    }
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    console.log(`All prices request for: ${symbol}`);
    
    const mexc = await getMexcPrice(symbol);
    const prices = {};
    
    await Promise.all(exchangesOrder.map(async ex => {
        prices[ex] = await getExPrice(ex, symbol);
    }));
    
    res.json({ ok: true, mexc, prices });
});

// --- ОСНОВНОЙ HTML ИНТЕРФЕЙС ---
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
    #output { white-space: pre; line-height: 1.1; min-height: 350px; }
    .control-row { display: flex; gap: 5px; margin-top: 10px; }
    #symbolInput { font-family: monospace; font-size: 28px; width: 100%; max-width: 400px; background: #000; color: #fff; border: 1px solid #444; padding: 5px; }
    #startBtn { font-family: monospace; font-size: 28px; background: #222; color: #fff; border: 1px solid #444; cursor: pointer; padding: 0 20px; }
    #startBtn:hover { background: #333; }
    #dexLink { font-family: monospace; font-size: 16px; width: 100%; background: #111; color: #888; border: 1px solid #333; padding: 8px; cursor: pointer; margin-top: 5px; }
    #errorDisplay { font-family: monospace; font-size: 16px; color: #ff4444; margin-top: 5px; min-height: 20px; }
    .dex-row { color: #00ff00; }
    .dex-okx { color: #00ff00; }
    .dex-dexscreener { color: #ff9900; }
    .best { color: #ffff00; }
    .blink-dot { animation: blink 1s infinite; display: inline-block; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    .status-ok { color: #44ff44; }
    </style>
    </head>
    <body>
      <div id="output">Готов к работе. Введите тикер или адрес токена.</div>
      <div class="control-row">
        <input id="symbolInput" value="${initialSymbol}" autocomplete="off" onfocus="this.select()" />
        <button id="startBtn">СТАРТ</button>
      </div>
      <input id="dexLink" readonly placeholder="Адрес токена или ссылка DEX" onclick="this.select(); document.execCommand('copy');" />
      <div id="errorDisplay"></div>
      <div id="status" style="font-size: 18px; margin-top: 5px; color: #444;"></div>

    <script>
    const exchangesOrder = ["Binance", "Bybit", "Gate", "Bitget", "BingX", "OKX", "Kucoin"];
    let urlParams = new URLSearchParams(window.location.search);
    let symbol = urlParams.get('symbol')?.toUpperCase() || 'BTC';
    let token = urlParams.get('token') || '777';
    let chain = urlParams.get('chain');
    let addr = urlParams.get('addr');
    let chainIndex = urlParams.get('chainIndex');
    let tokenAddress = urlParams.get('tokenAddress');
    let timer = null, blink = false;

    const output = document.getElementById("output");
    const input = document.getElementById("symbolInput");
    const dexLink = document.getElementById("dexLink");
    const errorDisplay = document.getElementById("errorDisplay");
    const statusEl = document.getElementById("status");

    function formatP(p) { 
        if (!p || p == 0) return "0.00";
        if (p < 0.000001) return p.toExponential(6);
        if (p < 0.001) return p.toFixed(8);
        if (p < 1) return p.toFixed(6);
        if (p < 1000) return p.toFixed(4);
        return p.toFixed(2);
    }

    async function getDexPrice() {
        if (!chain || !addr) {
            return { price: 0, source: null, error: 'Адрес или сеть не указаны', url: null };
        }

        try {
            const params = new URLSearchParams({ 
                chain: chain, 
                addr: addr 
            });
            if (chainIndex) params.append('chainIndex', chainIndex);
            if (tokenAddress) params.append('tokenAddress', tokenAddress);

            const res = await fetch('/api/dex-price?' + params.toString());
            const data = await res.json();
            return data;
        } catch(e) {
            console.error('DEX price error:', e);
            return { price: 0, source: null, error: 'Ошибка сети при запросе DEX цены', url: null };
        }
    }

    async function update() {
        blink = !blink;
        
        // Получаем данные DEX
        const dexResult = await getDexPrice();
        
        // Получаем цены с бирж
        let exchangeData = { ok: false, mexc: 0, prices: {} };
        try {
            const res = await fetch('/api/all?symbol=' + encodeURIComponent(symbol) + '&token=' + token);
            exchangeData = await res.json();
        } catch(e) {
            console.error('Exchange data error:', e);
        }

        // Очищаем ошибки
        errorDisplay.innerHTML = '';
        dexLink.style.color = '#888';
        
        // Формируем вывод
        let lines = [];
        
        // Статус подключения и символ
        let dot = blink ? '<span class="blink-dot">●</span>' : '○';
        lines.push(dot + ' <span class="status-ok">' + symbol + '</span> MEXC: ' + formatP(exchangeData.mexc));

        // DEX информация
        if (dexResult.price > 0) {
            const diff = ((dexResult.price - exchangeData.mexc) / exchangeData.mexc * 100).toFixed(2);
            const diffSign = diff > 0 ? '+' : '';
            const spreadText = \`(\${diffSign}\${diff}%)\`;

            let sourceLabel, sourceClass;
            if (dexResult.source === 'okx') {
                sourceLabel = 'DEX OKX';
                sourceClass = 'dex-okx';
            } else if (dexResult.source === 'dexscreener') {
                sourceLabel = 'DEX (через DexScreener)';
                sourceClass = 'dex-dexscreener';
            } else {
                sourceLabel = 'DEX';
                sourceClass = 'dex-row';
            }

            lines.push(\`<span class="\${sourceClass}">  \${sourceLabel}: \${formatP(dexResult.price)} \${spreadText}</span>\`);

            // Обновляем ссылку/адрес
            if (dexResult.url) {
                dexLink.value = dexResult.url;
                dexLink.title = 'Кликните для копирования ссылки';
            } else {
                dexLink.value = addr || 'Адрес не найден';
                dexLink.title = 'Кликните для копирования адреса';
            }
        }

        // Обработка ошибок DEX
        if (dexResult.error) {
            errorDisplay.innerHTML = \`⚠️ \${dexResult.error}\`;
            dexLink.style.color = '#ff4444';
        }

        // Цены с других бирж
        let bestEx = null, maxSp = 0;
        exchangesOrder.forEach(ex => {
            let p = exchangeData.prices[ex];
            if (p > 0) {
                let sp = Math.abs((p - exchangeData.mexc) / exchangeData.mexc * 100);
                if (sp > maxSp) { maxSp = sp; bestEx = ex; }
            }
        });

        exchangesOrder.forEach(ex => {
            let p = exchangeData.prices[ex];
            if (p > 0) {
                let diff = ((p - exchangeData.mexc) / exchangeData.mexc * 100).toFixed(2);
                let isBest = (ex === bestEx);
                let mark = isBest ? '◆' : '◇';
                let cls = isBest ? 'class="best"' : '';
                lines.push(\`<span \${cls}>\${mark} \${ex.padEnd(8, ' ')}: \${formatP(p)} (\${diff > 0 ? "+" : ""}\${diff}%)</span>\`);
            }
        });

        output.innerHTML = lines.join("<br>");
        statusEl.textContent = "Обновлено: " + new Date().toLocaleTimeString();
        
        // Обновляем заголовок окна
        if (dexResult.price > 0) {
            document.title = \`\${symbol}: \${formatP(dexResult.price)}\`;
        } else if (exchangeData.mexc > 0) {
            document.title = \`\${symbol}: \${formatP(exchangeData.mexc)}\`;
        }
    }

    async function start() {
        let val = input.value.trim();
        if (!val) return;
        
        if (timer) clearInterval(timer);
        output.innerHTML = "Поиск токена...";
        dexLink.value = "";
        errorDisplay.innerHTML = "";
        
        // Обработка ссылки DexScreener
        if (val.includes("dexscreener.com")) {
            try {
                const parts = val.split('/');
                const dsChain = parts[parts.length - 2];
                const dsAddress = parts[parts.length - 1].split('?')[0];
                
                const dsRes = await fetch('https://api.dexscreener.com/latest/dex/pairs/' + dsChain + '/' + dsAddress);
                const dsData = await dsRes.json();
                
                if (dsData.pair) {
                    symbol = dsData.pair.baseToken.symbol.toUpperCase();
                    chain = dsData.pair.chainId;
                    addr = dsData.pair.pairAddress;
                    tokenAddress = dsData.pair.baseToken.address;
                    chainIndex = null; // Сбросим, получим из mapping
                    
                    // Получаем chainIndex из mapping
                    const mappingRes = await fetch('/api/get-chain-index?chain=' + chain);
                    const mappingData = await mappingRes.json();
                    if (mappingData.chainIndex) {
                        chainIndex = mappingData.chainIndex;
                    }
                    
                    input.value = symbol;
                    dexLink.value = dsData.pair.url;
                } else {
                    output.innerHTML = "Не удалось распознать ссылку DexScreener";
                    return;
                }
            } catch(e) {
                output.innerHTML = "Ошибка при обработке ссылки";
                return;
            }
        } 
        // Обработка адреса контракта (начинается с 0x)
        else if (val.startsWith('0x') && val.length === 42) {
            symbol = val.substring(0, 6).toUpperCase() + '...' + val.substring(38);
            tokenAddress = val;
            chain = null;
            addr = null;
            dexLink.value = tokenAddress;
            
            // Пробуем найти информацию о токене
            try {
                const res = await fetch('/api/resolve?symbol=' + encodeURIComponent(val.substring(0, 10)));
                const d = await res.json();
                if (d.ok) {
                    symbol = d.symbol || symbol;
                    chain = d.chain;
                    addr = d.addr;
                    chainIndex = d.chainIndex;
                    dexLink.value = d.url || tokenAddress;
                }
            } catch(e) {
                console.error('Token resolve error:', e);
            }
        } 
        // Обработка тикера
        else {
            symbol = val.toUpperCase();
            chain = null;
            addr = null;
            tokenAddress = null;
            chainIndex = null;
            
            try {
                const res = await fetch('/api/resolve?symbol=' + encodeURIComponent(symbol));
                const d = await res.json();
                if (d.ok) {
                    chain = d.chain;
                    addr = d.addr;
                    chainIndex = d.chainIndex;
                    tokenAddress = d.tokenAddress;
                    dexLink.value = d.url || d.addr;
                    
                    if (!d.chainIndex) {
                        errorDisplay.innerHTML = '⚠️ Сеть ' + d.chain + ' не поддерживается OKX Web3 API. Используется DexScreener.';
                    }
                } else {
                    errorDisplay.innerHTML = '⚠️ ' + (d.error || 'Токен не найден в MEXC');
                }
            } catch(e) {
                errorDisplay.innerHTML = '⚠️ Ошибка при поиске токена';
                console.error('Resolve error:', e);
            }
        }

        // Обновляем URL
        const url = new URL(window.location);
        url.searchParams.set('symbol', symbol);
        if (chain) url.searchParams.set('chain', chain);
        if (addr) url.searchParams.set('addr', addr);
        if (chainIndex) url.searchParams.set('chainIndex', chainIndex);
        if (tokenAddress) url.searchParams.set('tokenAddress', tokenAddress);
        window.history.replaceState({}, '', url);

        // Запускаем обновление
        update();
        timer = setInterval(update, 2000);
    }

    // Вспомогательный endpoint для получения chainIndex
    app.get('/api/get-chain-index', (req, res) => {
        const chain = req.query.chain;
        const chainIndex = chainMapping[chain] || null;
        res.json({ chainIndex });
    });

    document.getElementById("startBtn").onclick = start;
    input.addEventListener("keypress", (e) => { if (e.key === "Enter") start(); });

    // Автозапуск если в URL есть символ
    if (urlParams.get('symbol')) {
        start();
    }
    </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`=== Crypto Monitor Server запущен на порту ${PORT} ===`);
    console.log(`MEXC API настроен: ${MEXC_API_KEY ? 'Да' : 'Нет'}`);
    console.log(`OKX Web3 API настроен: ${OKX_API_KEY && OKX_API_SECRET && OKX_PASSPHRASE ? 'Да' : 'Нет'}`);
    console.log(`Секретный токен: ${SECRET_TOKEN}`);
    console.log('Ожидаю запросы...');
});
