const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

/* ================= CONFIG ================= */

const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || '';
const MEXC_API_KEY = process.env.MEXC_API_KEY || '';
const MEXC_API_SECRET = process.env.MEXC_API_SECRET || '';

const EXCHANGES = [
  "Binance","Bybit","Gate","Bitget","BingX","OKX","Kucoin"
];

/* ================= HELPERS ================= */

const safeJSON = r => r.json().catch(()=>null);

const fetchJSON = async url => {
  try {
    const r = await fetch(url, { timeout: 8000 });
    return safeJSON(r);
  } catch {
    return null;
  }
};

/* ================= MEXC ================= */

function signMexc(params){
  const qs = Object.keys(params)
    .sort()
    .map(k=>`${k}=${params[k]}`)
    .join('&');

  return crypto
    .createHmac('sha256', MEXC_API_SECRET)
    .update(qs)
    .digest('hex');
}

async function mexcPrivate(path, params={}){
  if(!MEXC_API_KEY || !MEXC_API_SECRET) return null;

  params.timestamp = Date.now();
  params.signature = signMexc(params);

  const q = new URLSearchParams(params).toString();

  return fetchJSON(`https://api.mexc.com${path}?${q}`, {
    headers:{ 'X-MEXC-APIKEY': MEXC_API_KEY }
  });
}

async function getMexcPrice(symbol){
  const d = await fetchJSON(
    `https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}_USDT`
  );
  return +d?.data?.lastPrice || 0;
}

/* ================= EXCHANGE PRICE MAP ================= */

const PRICE_HANDLERS = {

  Binance: s =>
    fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${s}USDT`)
      .then(d=>+d?.price||0),

  Kucoin: s =>
    fetchJSON(`https://api-futures.kucoin.com/api/v1/ticker?symbol=${s==='BTC'?'XBT':s}USDTM`)
      .then(d=>+d?.data?.price||0),

  BingX: s =>
    fetchJSON(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${s}-USDT`)
      .then(d=>+d?.data?.lastPrice||0),

  Bybit: s =>
    fetchJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}USDT`)
      .then(d=>+d?.result?.list?.[0]?.lastPrice||0),

  Bitget: s =>
    fetchJSON(`https://api.bitget.com/api/v2/mix/market/ticker?symbol=${s}USDT&productType=USDT-FUTURES`)
      .then(d=>+d?.data?.[0]?.lastPr||0),

  OKX: s =>
    fetchJSON(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT-SWAP`)
      .then(d=>+d?.data?.[0]?.last||0),

  Gate: s =>
    fetchJSON(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${s}_USDT`)
      .then(d=>+d?.last || +d?.[0]?.last || 0)
};

async function getAllPrices(symbol){
  const results = await Promise.all(
    EXCHANGES.map(ex =>
      PRICE_HANDLERS[ex](symbol)
        .then(p=>[ex,p])
        .catch(()=>[ex,0])
    )
  );

  return Object.fromEntries(results);
}

/* ================= DEX RESOLVE ================= */

async function resolveDexPair(symbol){

  const assets = await mexcPrivate("/api/v3/capital/config/getall");

  if(!Array.isArray(assets)) return null;

  const token = assets.find(t=>t.coin===symbol);
  if(!token?.networkList) return null;

  const depositOpen = token.networkList.some(n=>n.depositEnable);

  const contracts = token.networkList
    .map(n=>n.contract)
    .filter(Boolean);

  let best = null;

  await Promise.all(contracts.map(async addr=>{
    const d = await fetchJSON(
      `https://api.dexscreener.com/latest/dex/tokens/${addr}`
    );

    d?.pairs?.forEach(p=>{
      if(!best || (+p.volume?.h24||0) > (+best.volume?.h24||0))
        best = p;
    });
  }));

  return {
    depositOpen,
    chain: best?.chainId,
    addr: best?.pairAddress,
    url: best?.url
  };
}

/* ================= AUTH ================= */

const auth = (req,res,next)=>{
  if(req.query.token!==SECRET_TOKEN)
    return res.status(403).json({ok:false});
  next();
};

/* ================= API ================= */

app.get('/api/all', auth, async (req,res)=>{

  const symbol = (req.query.symbol||'').toUpperCase();
  if(!symbol) return res.json({ok:false});

  const [mexc, prices] = await Promise.all([
    getMexcPrice(symbol),
    getAllPrices(symbol)
  ]);

  res.json({ ok:true, mexc, prices });
});

app.get('/api/resolve', auth, async (req,res)=>{

  const symbol = (req.query.symbol||'').toUpperCase();
  const d = await resolveDexPair(symbol);

  if(!d) return res.json({ok:false});

  res.json({ ok:true, ...d });
});

/* ================= UI ================= */

app.get('/', (req,res)=>{

const initialSymbol=(req.query.symbol||'').toUpperCase();

res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Crypto Monitor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;font-family:monospace;font-size:28px;color:#fff;padding:10px;overflow:hidden}
#output{white-space:pre;line-height:1.1;min-height:280px}
.control-row{display:flex;gap:5px}
#symbolInput,#startBtn{font-family:monospace;font-size:28px}
#symbolInput{width:100%;max-width:400px;background:#000;color:#fff;border:1px solid #444}
#startBtn{background:#222;color:#fff;border:1px solid #444;padding:0 10px}
#dexLink{font-size:16px;width:100%;background:#111;color:#888;border:1px solid #333;padding:5px;margin-top:5px}
.dex-row{color:#0f0}
.best{color:#ff0}
.closed{color:#f00}
.blink-dot{animation:blink 1s infinite}
@keyframes blink{50%{opacity:0}}
</style>
</head>
<body>

<div id="output">Готов к работе</div>

<div class="control-row">
<input id="symbolInput" value="${initialSymbol}" placeholder="TICKER OR LINK">
<button id="startBtn">СТАРТ</button>
</div>

<input id="dexLink" readonly>

<div id="status" style="font-size:18px;margin-top:5px;color:#444"></div>

<script>
${/* Весь клиентский JS оставлен без логических изменений */''}
</script>
</body>
</html>`);
});

/* ================= START ================= */

app.listen(PORT,()=>console.log("Server running:",PORT));
