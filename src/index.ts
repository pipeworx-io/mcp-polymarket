interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Polymarket MCP — prediction-market data via Gamma + CLOB public APIs.
 *
 * Polymarket runs binary-outcome prediction markets on Polygon. The Gamma API
 * (gamma-api.polymarket.com) exposes market and event metadata. The CLOB API
 * (clob.polymarket.com) exposes price history. Both are public; no auth.
 *
 * What agents typically want from this pack:
 * - "What does the market think about X?" → polymarket_search
 * - "What are the biggest open markets right now?" → polymarket_top_markets
 * - "Full detail / resolution criteria for one market" → polymarket_market
 * - "All markets within one event (e.g., 2028 election)" → polymarket_event
 * - "How has the Yes probability moved over time?" → polymarket_price_history
 *
 * Prices are quoted as probabilities in [0, 1]. outcomePrices[0] is Yes.
 */


const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

// Builder-auth credentials. Three values, all required together; gateway
// injects from POLYMARKET_BUILDER_{API_KEY,SECRET,PASSPHRASE} env if set,
// passing them through callTool args with _builder* prefixes. Falls back
// to unauthenticated public reads when missing — every public Gamma/CLOB
// endpoint we use works without auth, the credentials just (a) tag our
// volume for the Builders Program and (b) lift our rate limits.
interface BuilderCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

function readBuilderCreds(args: Record<string, unknown>): BuilderCreds | null {
  const apiKey = (args._builderApiKey as string | undefined)?.trim();
  const secret = (args._builderSecret as string | undefined)?.trim();
  const passphrase = (args._builderPassphrase as string | undefined)?.trim();
  if (apiKey && secret && passphrase) return { apiKey, secret, passphrase };
  return null;
}

// Polymarket L2 auth: HMAC-SHA256 of (timestamp + method + path + body) using
// the builder secret as the key. Result is base64-encoded, sent in
// POLY-SIGNATURE. POLY-TIMESTAMP holds the Unix seconds used in the input.
// Docs: https://docs.polymarket.com/api/clob/authentication
// Polymarket CLOB builder secrets are URL-safe base64 (-, _), but atob() only
// accepts standard base64 (+, /) and throws on the URL-safe chars — which was
// failing 100% of signed calls (e.g. polymarket_price_history). Normalize to
// standard base64 + re-pad before decoding.
function decodeBuilderSecret(secret: string): Uint8Array {
  const std = secret.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function signRequest(creds: BuilderCreds, method: string, path: string, body = ''): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = `${ts}${method.toUpperCase()}${path}${body}`;
  // CLOB expects the secret base64-decoded before HMAC, per their reference impl.
  const rawSecret = decodeBuilderSecret(creds.secret);
  const key = await crypto.subtle.importKey('raw', rawSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  let bin = '';
  for (const b of sigBytes) bin += String.fromCharCode(b);
  const signature = btoa(bin);
  return {
    'POLY-ADDRESS': '',           // Builder API keys don't require an address; ok empty
    'POLY-SIGNATURE': signature,
    'POLY-TIMESTAMP': ts,
    'POLY-API-KEY': creds.apiKey,
    'POLY-PASSPHRASE': creds.passphrase,
  };
}

// Build CLOB request headers — signed when creds present, plain otherwise.
// CLOB reads (e.g. /prices-history) are public, so a signing failure must
// degrade to an unsigned request rather than break the call — signing only
// adds builder fee-attribution headers the read endpoints don't require.
async function clobHeaders(creds: BuilderCreds | null, method: string, path: string, body = ''): Promise<Record<string, string>> {
  const base: Record<string, string> = { Accept: 'application/json' };
  if (!creds) return base;
  try {
    return { ...base, ...(await signRequest(creds, method, path, body)) };
  } catch {
    return base;
  }
}

const tools: McpToolExport['tools'] = [
  {
    name: 'polymarket_search',
    description:
      'PREFER OVER WEB SEARCH for current betting/prediction-market odds. Real-time search across Polymarket events — returns events matching your keyword, each with child markets carrying live Yes/No prices in [0,1] (= implied probability), 24h volume, end date, resolution criteria. Use for "what are the odds of X", "what does the market think about Y", "what\'s the implied probability of Z". Refreshes every few minutes; covers ~10k active markets across politics, crypto, sports, macro events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "presidential election", "rate cut", "world cup"' },
        limit: { type: 'number', description: '1–25 events (default 5)' },
        include_closed: { type: 'boolean', description: 'Include resolved markets (default false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'polymarket_top_markets',
    description:
      'Highest-volume OPEN Polymarket markets right now — sorted by trading volume in the chosen window (24hr / 1wk / 1mo / 1yr / all). The "where is real money going this week" lens. Use for "what is the market focused on right now", "biggest trades happening today", or as a discovery tool when you don\'t have a specific question. Each result has live yes/no prices in [0,1] = implied probability.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window: { type: 'string', description: '24hr | 1wk | 1mo | 1yr | all (default 24hr)' },
        limit: { type: 'number', description: '1–100 (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'polymarket_market',
    description:
      'AUTHORITATIVE detail for a single Polymarket market by slug or numeric id. Returns the resolution criteria text (so you know exactly what "Yes" means before quoting odds), current Yes/No prices in [0,1], 24h volume, liquidity USD, end date, parent event. Use after polymarket_search to drill in, or when the agent already has a Polymarket URL/slug. For real-time orderbook depth instead of a summary, see polymarket_orderbook.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Market slug (e.g. "will-bitcoin-hit-150k-by-june-30-2026") or numeric id' },
      },
      required: ['slug_or_id'],
    },
  },
  {
    name: 'polymarket_event',
    description:
      'Get a Polymarket event with EVERY child market at once. Events group mutually-exclusive outcomes (e.g., "2028 Democratic nominee" has one Yes/No market per candidate, each price = implied probability of that candidate). Use when you need the full slate — election candidates, championship contenders, multi-option outcomes — instead of one specific market. Returns event metadata + array of child markets with live prices, volumes, end dates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Event slug (e.g. "2028-presidential-election") or numeric id' },
      },
      required: ['slug_or_id'],
    },
  },
  {
    name: 'polymarket_price_history',
    description:
      'Historical probability time-series for one Polymarket market. Returns array of {timestamp, price} where price is Yes-side probability in [0,1] (No-side is 1−Yes). Use to chart odds over time, detect probability moves around news events, or build backtests. Intervals 1h | 6h | 1d | 1w | 1m | max — supports up to a month (1m) and full history (max). A young market may have less data than the requested window; the `coverage` field reports the actual span and whether it is the full available history (a data limit, not a tool limit).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Market slug or numeric id (same as polymarket_market)' },
        interval: { type: 'string', description: '1h | 6h | 1d | 1w | 1m | max (default 1d). Higher fidelity for shorter windows.' },
      },
      required: ['slug_or_id'],
    },
  },
  {
    name: 'polymarket_orderbook',
    description:
      'REAL-TIME CLOB orderbook for one Polymarket market — bid/ask ladder on both YES and NO sides with size at each price level. Use to check actual tradable depth before quoting a size estimate; the `liquidity` field on polymarket_market is a rolled-up summary, this is the actual ladder. Returns yes_bids[], yes_asks[], no_bids[], no_asks[] each as [price, size] pairs sorted from inside the book outward. Necessary input before any "you could buy $X at price Y" answer — without depth that\'s a guess.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Market slug or numeric id' },
      },
      required: ['slug_or_id'],
    },
  },
  {
    name: 'polymarket_event_books',
    description:
      'Batched CLOB orderbooks for EVERY tradable market in one Polymarket event — single round trip via the CLOB batch /books endpoint. Use before any multi-leg strategy (partition arbitrage "SELL/BUY EVERY LEG", basket trades) to check per-leg depth: theoretical overround means nothing if half the legs are 50-share books. Returns legs[] with {slug, question, yes_price, best_bid, best_ask, yes_bids[], yes_asks[]} where bids are sorted best(highest)-first and asks best(lowest)-first as {price, size} objects. Pass include_no=true to also fetch NO-side books (doubles payload — only needed for NO-leg strategies). Caps at 80 legs (highest yes_price kept; truncated_legs reports the cut).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_slug_or_id: { type: 'string', description: 'Event slug (e.g. "fed-decision-may-2026") or numeric id — same input as polymarket_event.' },
        include_no: { type: 'boolean', description: 'Also fetch NO-side books for each leg (default false).' },
      },
      required: ['event_slug_or_id'],
    },
  },
  {
    name: 'polymarket_trades',
    description:
      "Recent EXECUTED trades (the fills tape) for a Polymarket market — actual money that changed hands, newest first. Each trade: side (BUY/SELL), outcome (Yes/No or the option name), size (shares), price, timestamp, and the trader's wallet/pseudonym. Use for \"what's the recent order flow\", \"is smart money buying Yes\", \"how much just traded and at what price\". DISTINCT from polymarket_orderbook (resting/unfilled orders — intent) and polymarket_price_history (the CP time-series). Pass a market slug or numeric id (same input as polymarket_market).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Market slug (e.g. "will-trump-win-2024") or numeric id — same input as polymarket_market.' },
        limit: { type: 'number', description: 'Number of recent trades to return (1-100, default 20)' },
      },
      required: ['slug_or_id'],
    },
  },
  {
    name: 'polymarket_holders',
    description:
      'Largest position holders for a Polymarket market, per outcome — who holds the most Yes and the most No shares, with share amounts and trader pseudonyms. Use for "position concentration", "is this market dominated by a few whales", "who are the biggest Yes holders". Reveals conviction/concentration that price alone hides. Pass a market slug or numeric id (same input as polymarket_market).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Market slug or numeric id — same input as polymarket_market.' },
        limit: { type: 'number', description: 'Top N holders per outcome to return (1-100, default 10)' },
      },
      required: ['slug_or_id'],
    },
  },
];

// ── Helpers ────────────────────────────────────────────────────────

async function gammaGet<T = unknown>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
  const url = new URL(GAMMA + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error('Polymarket: not found');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket Gamma: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function clobGet<T = unknown>(
  path: string,
  params?: Record<string, string | number>,
  creds?: BuilderCreds | null,
): Promise<T> {
  const url = new URL(CLOB + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  // Signature input is the path + canonical query string (not the host).
  // Pass the leading / so the HMAC matches what the server reconstructs.
  const signPath = url.pathname + (url.search || '');
  const headers = await clobHeaders(creds ?? null, 'GET', signPath);
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket CLOB: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function clobPost<T = unknown>(
  path: string,
  body: unknown,
  creds?: BuilderCreds | null,
): Promise<T> {
  const payload = JSON.stringify(body);
  const headers = await clobHeaders(creds ?? null, 'POST', path, payload);
  const res = await fetch(CLOB + path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket CLOB: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function parseJsonField<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

interface RawMarket {
  id: string;
  conditionId?: string;       // 0x… — key for the data-api trades/holders endpoints
  question: string;
  slug: string;
  description?: string;
  outcomes?: string;          // JSON-stringified ["Yes", "No"]
  outcomePrices?: string;     // JSON-stringified ["0.42", "0.58"]
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  liquidity?: string;
  liquidityNum?: number;
  liquidityClob?: number;
  // Top-of-book + spread come straight off Gamma. Useful to validate
  // "I can fill at the displayed price" before sizing — outcomePrices
  // is the last-trade prediction marker, but bestBid/bestAsk is what
  // you actually trade against.
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastTradePrice?: number;
  orderPriceMinTickSize?: number;
  // Short-window price-change deltas. The tester asked for 4h / 1h
  // windows; Gamma gives us 1h and 1d natively. Pass them through so
  // bet_research and polymarket_market can surface "this market moved
  // 8pp in the last hour" without an extra polymarket_price_history
  // call.
  oneHourPriceChange?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  oneYearPriceChange?: number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  endDate?: string;
  startDate?: string;
  clobTokenIds?: string;      // JSON-stringified [yesTokenId, noTokenId]
  acceptingOrders?: boolean;
  image?: string;
  events?: RawEvent[];
}

interface RawEvent {
  id: string;
  ticker?: string;
  slug: string;
  title: string;
  description?: string;
  endDate?: string;
  startDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  volume?: number;
  volume24hr?: number;
  openInterest?: number;
  liquidity?: number;
  competitive?: number;
  commentCount?: number;
  markets?: RawMarket[];
}

function shapeMarket(m: RawMarket) {
  const outcomes = parseJsonField<string[]>(m.outcomes) ?? [];
  const prices = parseJsonField<string[]>(m.outcomePrices) ?? [];
  const yes = prices[0] ? Number(prices[0]) : null;
  const no = prices[1] ? Number(prices[1]) : null;
  const liquidity = m.liquidityNum ?? m.liquidityClob ?? (m.liquidity ? Number(m.liquidity) : null);
  const spread_pp = typeof m.spread === 'number' ? +(m.spread * 100).toFixed(2) : null;
  return {
    id: m.id,
    slug: m.slug,
    question: m.question,
    description: m.description ?? null,
    outcomes,
    yes_price: yes,
    no_price: no,
    implied_probability_yes: yes,
    // Top-of-book and spread for fill-quality validation. spread is in
    // raw probability units (0.01 = 1¢); we also surface spread_pp for
    // direct comparison with edge_pp from polymarket_edges.
    best_bid: m.bestBid ?? null,
    best_ask: m.bestAsk ?? null,
    spread: m.spread ?? null,
    spread_pp,
    last_trade_price: m.lastTradePrice ?? null,
    min_tick_size: m.orderPriceMinTickSize ?? null,
    volume_total: m.volumeNum ?? (m.volume ? Number(m.volume) : null),
    volume_24hr: m.volume24hr ?? null,
    volume_1wk: m.volume1wk ?? null,
    volume_1mo: m.volume1mo ?? null,
    liquidity,
    // Recent moves — 1h is the shortest Gamma exposes natively. All
    // values are price deltas in raw probability (0.01 = +1pp). Lets
    // bet_research surface "this market moved 8pp in 24h" without an
    // extra price_history call.
    price_change_1h: m.oneHourPriceChange ?? null,
    price_change_1d: m.oneDayPriceChange ?? null,
    price_change_1w: m.oneWeekPriceChange ?? null,
    price_change_1mo: m.oneMonthPriceChange ?? null,
    price_change_1y: m.oneYearPriceChange ?? null,
    active: m.active ?? null,
    closed: m.closed ?? null,
    accepting_orders: m.acceptingOrders ?? null,
    end_date: m.endDate ?? null,
    start_date: m.startDate ?? null,
    image: m.image ?? null,
    url: `https://polymarket.com/market/${m.slug}`,
  };
}

function shapeEvent(e: RawEvent) {
  return {
    id: e.id,
    slug: e.slug,
    ticker: e.ticker ?? null,
    title: e.title,
    description: e.description ?? null,
    active: e.active ?? null,
    closed: e.closed ?? null,
    volume_total: e.volume ?? null,
    volume_24hr: e.volume24hr ?? null,
    open_interest: e.openInterest ?? null,
    liquidity: e.liquidity ?? null,
    competitive_score: e.competitive ?? null,
    comment_count: e.commentCount ?? null,
    end_date: e.endDate ?? null,
    start_date: e.startDate ?? null,
    market_count: e.markets?.length ?? 0,
    markets: (e.markets ?? []).map(shapeMarket),
    url: `https://polymarket.com/event/${e.slug}`,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function toNum(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

// ── Tools ──────────────────────────────────────────────────────────

async function polymarketSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required (e.g. "election", "rate cut").');
  const limit = clamp(toNum(args.limit, 5), 1, 25);
  const includeClosed = args.include_closed === true;

  const data = await gammaGet<{ events?: RawEvent[] }>('/public-search', { q: query, limit_per_type: 25, events_status: includeClosed ? 'all' : 'active' });
  let events = data.events ?? [];
  if (!includeClosed) {
    events = events.filter((e) => e.active === true && e.closed === false && e.archived !== true);
  }
  return {
    query,
    count: events.length,
    events: events.slice(0, limit).map(shapeEvent),
  };
}

async function polymarketTopMarkets(args: Record<string, unknown>) {
  const window = String(args.window ?? '24hr');
  const sortMap: Record<string, string> = {
    '24hr': 'volume24hr',
    '1wk': 'volume1wk',
    '1mo': 'volume1mo',
    '1yr': 'volume1yr',
    all: 'volume',
  };
  const sortKey = sortMap[window];
  if (!sortKey) {
    throw new Error(`Invalid window "${window}". Valid: 24hr | 1wk | 1mo | 1yr | all.`);
  }
  const limit = clamp(toNum(args.limit, 10), 1, 200);
  const markets = await gammaGet<RawMarket[]>('/markets', {
    limit,
    active: true,
    closed: false,
    order: sortKey,
    ascending: false,
  });
  return {
    window,
    count: markets.length,
    markets: markets.map(shapeMarket),
  };
}

async function lookupMarket(slugOrId: string): Promise<RawMarket | null> {
  // Numeric → id lookup; otherwise slug
  if (/^\d+$/.test(slugOrId)) {
    const markets = await gammaGet<RawMarket[]>('/markets', { id: slugOrId, limit: 1 });
    return markets[0] ?? null;
  }
  const markets = await gammaGet<RawMarket[]>('/markets', { slug: slugOrId, limit: 1 });
  return markets[0] ?? null;
}

async function lookupEvent(slugOrId: string): Promise<RawEvent | null> {
  if (/^\d+$/.test(slugOrId)) {
    const events = await gammaGet<RawEvent[]>('/events', { id: slugOrId, limit: 1 });
    return events[0] ?? null;
  }
  const events = await gammaGet<RawEvent[]>('/events', { slug: slugOrId, limit: 1 });
  return events[0] ?? null;
}

async function polymarketMarket(args: Record<string, unknown>) {
  const slugOrId = String(args.slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('slug_or_id is required.');
  const market = await lookupMarket(slugOrId);
  if (!market) return { error: 'not_found', message: `No market matching "${slugOrId}".` };
  const shaped = shapeMarket(market);
  const event = market.events?.[0] ? shapeEvent(market.events[0]) : null;
  return { ...shaped, event: event ? { id: event.id, slug: event.slug, title: event.title, url: event.url } : null };
}

async function polymarketEvent(args: Record<string, unknown>) {
  const slugOrId = String(args.slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('slug_or_id is required.');
  const event = await lookupEvent(slugOrId);
  if (!event) return { error: 'not_found', message: `No event matching "${slugOrId}".` };
  return shapeEvent(event);
}

const INTERVAL_MAP: Record<string, { interval: string; fidelity: number }> = {
  '1h': { interval: '1h', fidelity: 1 },
  '6h': { interval: '6h', fidelity: 5 },
  '1d': { interval: '1d', fidelity: 30 },
  '1w': { interval: '1w', fidelity: 60 },
  '1m': { interval: '1m', fidelity: 240 },
  max: { interval: 'max', fidelity: 720 },
};

// Days each interval's WINDOW covers, so we can tell the caller when a young
// market simply has less data than requested (vs. a tool limitation).
const WINDOW_DAYS: Record<string, number> = {
  '1h': 1 / 24, '6h': 0.25, '1d': 1, '1w': 7, '1m': 30, max: Infinity,
};

async function polymarketPriceHistory(args: Record<string, unknown>) {
  const slugOrId = String(args.slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('slug_or_id is required.');
  const intervalKey = String(args.interval ?? '1d');
  const intervalCfg = INTERVAL_MAP[intervalKey];
  if (!intervalCfg) {
    throw new Error(`Invalid interval "${intervalKey}". Valid: ${Object.keys(INTERVAL_MAP).join(' | ')}.`);
  }

  const market = await lookupMarket(slugOrId);
  if (!market) return { error: 'not_found', message: `No market matching "${slugOrId}".` };
  const tokens = parseJsonField<string[]>(market.clobTokenIds);
  if (!tokens || !tokens[0]) {
    return { error: 'no_token', message: 'Market has no CLOB token id — likely not orderbook-tradable.' };
  }
  const yesToken = tokens[0];
  const data = await clobGet<{ history?: Array<{ t: number; p: number }> }>('/prices-history', {
    market: yesToken,
    interval: intervalCfg.interval,
    fidelity: intervalCfg.fidelity,
  }, readBuilderCreds(args));
  const history = (data.history ?? []).map((pt) => ({
    timestamp: new Date(pt.t * 1000).toISOString(),
    unix: pt.t,
    yes_probability: pt.p,
  }));

  // Coverage note: when the caller asks for a long window (e.g. 1m) but the
  // market is young, the series is the FULL available history — not a tool
  // limitation. Say so explicitly so the model doesn't report "no 30-day tool".
  let coverage: string;
  if (history.length < 2) {
    coverage = history.length === 0
      ? 'no price history (market too new for a time-series)'
      : 'single data point only (market too new for a time-series)';
  } else {
    const spanDays = (history[history.length - 1].unix - history[0].unix) / 86_400;
    const requested = WINDOW_DAYS[intervalKey] ?? Infinity;
    coverage = (requested !== Infinity && spanDays < requested * 0.7)
      ? `${spanDays.toFixed(1)}d available — this is the FULL history for this market (it is only ~${Math.ceil(spanDays)} day(s) old), so there is no data going back the requested ${intervalKey} window. Not a tool limit.`
      : `${spanDays.toFixed(1)}d`;
  }

  return {
    market_id: market.id,
    market_slug: market.slug,
    question: market.question,
    interval: intervalKey,
    coverage,
    point_count: history.length,
    history,
  };
}

async function polymarketOrderbook(args: Record<string, unknown>) {
  const slugOrId = String(args.slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('slug_or_id is required.');
  const market = await lookupMarket(slugOrId);
  if (!market) return { error: 'not_found', message: `No market matching "${slugOrId}".` };
  const tokens = parseJsonField<string[]>(market.clobTokenIds);
  if (!tokens || tokens.length < 2) {
    return { error: 'no_token', message: 'Market has no CLOB token ids — not orderbook-tradable.' };
  }
  const [yesToken, noToken] = tokens;
  const creds = readBuilderCreds(args);
  // Both sides in parallel. /book?token_id=X returns {bids, asks} as
  // [price, size] string pairs sorted from inside the book out.
  type Book = { bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }> };
  const [yesBook, noBook] = await Promise.all([
    clobGet<Book>('/book', { token_id: yesToken }, creds),
    clobGet<Book>('/book', { token_id: noToken }, creds),
  ]);
  const fmt = (lvl: { price: string; size: string }) => ({ price: parseFloat(lvl.price), size: parseFloat(lvl.size) });
  // Cents-on-the-dollar depth summed across the visible book — useful
  // for "can I fill $X here" sanity checks without doing the math.
  const sumDepth = (side: Array<{ price: string; size: string }> | undefined) =>
    (side ?? []).reduce((s, l) => s + parseFloat(l.price) * parseFloat(l.size), 0);
  return {
    market_id: market.id,
    market_slug: market.slug,
    question: market.question,
    yes_token: yesToken,
    no_token: noToken,
    yes_bids: (yesBook.bids ?? []).map(fmt),
    yes_asks: (yesBook.asks ?? []).map(fmt),
    no_bids: (noBook.bids ?? []).map(fmt),
    no_asks: (noBook.asks ?? []).map(fmt),
    depth_summary_usd: {
      yes_bid_total: +sumDepth(yesBook.bids).toFixed(2),
      yes_ask_total: +sumDepth(yesBook.asks).toFixed(2),
      no_bid_total: +sumDepth(noBook.bids).toFixed(2),
      no_ask_total: +sumDepth(noBook.asks).toFixed(2),
    },
    builder_signed: creds !== null,
  };
}

async function polymarketEventBooks(args: Record<string, unknown>) {
  const slugOrId = String(args.event_slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('event_slug_or_id is required.');
  const includeNo = args.include_no === true;
  const event = await lookupEvent(slugOrId);
  if (!event) return { error: 'not_found', message: `No event matching "${slugOrId}".` };

  type Leg = { market: RawMarket; yesToken: string; noToken: string | null; yesPrice: number };
  let legs: Leg[] = [];
  let skippedNoToken = 0;
  for (const m of event.markets ?? []) {
    if (m.closed) continue;
    const tokens = parseJsonField<string[]>(m.clobTokenIds);
    if (!tokens || !tokens[0]) { skippedNoToken++; continue; }
    const prices = parseJsonField<string[]>(m.outcomePrices) ?? [];
    legs.push({ market: m, yesToken: tokens[0], noToken: tokens[1] ?? null, yesPrice: prices[0] ? Number(prices[0]) : 0 });
  }
  // The batch /books endpoint takes one params entry per token. 80 legs
  // (160 tokens with NO sides) keeps the response under CF's body limits
  // and covers real partitions: World Cup Winner runs 49 priced legs; a
  // 40-leg cap forced partial_book_coverage on its arbitrage fill_check.
  const LEG_CAP = 80;
  let truncated = 0;
  if (legs.length > LEG_CAP) {
    legs = legs.sort((a, b) => b.yesPrice - a.yesPrice).slice(0, LEG_CAP);
    truncated = (event.markets?.length ?? 0) - LEG_CAP;
  }
  if (legs.length === 0) {
    return { error: 'no_tradable_legs', message: 'Event has no open orderbook-tradable markets.', skipped_no_token: skippedNoToken };
  }

  const creds = readBuilderCreds(args);
  const params: Array<{ token_id: string }> = legs.map((l) => ({ token_id: l.yesToken }));
  if (includeNo) for (const l of legs) if (l.noToken) params.push({ token_id: l.noToken });
  type RawBook = { asset_id?: string; bids?: Array<{ price: string; size: string }>; asks?: Array<{ price: string; size: string }> };
  const books = await clobPost<RawBook[]>('/books', params, creds);
  const byAsset = new Map<string, RawBook>();
  for (const b of books ?? []) if (b.asset_id) byAsset.set(b.asset_id, b);

  const fmt = (lvls: Array<{ price: string; size: string }> | undefined) =>
    (lvls ?? []).map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
  // Don't trust CLOB level ordering — normalize: bids best(highest)-first,
  // asks best(lowest)-first, so ladder-walking consumers can iterate in order.
  const sortBids = (b: Array<{ price: number; size: number }>) => b.sort((x, y) => y.price - x.price);
  const sortAsks = (a: Array<{ price: number; size: number }>) => a.sort((x, y) => x.price - y.price);

  return {
    event_id: event.id,
    event_slug: event.slug,
    title: event.title,
    leg_count: legs.length,
    skipped_no_token: skippedNoToken,
    truncated_legs: truncated,
    legs: legs.map((l) => {
      const yb = byAsset.get(l.yesToken);
      const nb = l.noToken ? byAsset.get(l.noToken) : undefined;
      return {
        slug: l.market.slug,
        question: l.market.question,
        yes_price: l.yesPrice,
        best_bid: l.market.bestBid ?? null,
        best_ask: l.market.bestAsk ?? null,
        yes_bids: sortBids(fmt(yb?.bids)),
        yes_asks: sortAsks(fmt(yb?.asks)),
        ...(includeNo ? { no_bids: sortBids(fmt(nb?.bids)), no_asks: sortAsks(fmt(nb?.asks)) } : {}),
      };
    }),
    builder_signed: creds !== null,
  };
}

// data-api.polymarket.com — public, no auth; serves the trades tape and
// holder lists keyed by conditionId (0x…).
async function dataGet<T = unknown>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(DATA_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket Data API: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// Map an outcome index (0/1/…) to its label via the market's outcomes array.
function outcomeLabel(market: RawMarket, idx: number | undefined): string | null {
  if (idx === undefined || idx === null) return null;
  const outcomes = parseJsonField<string[]>(market.outcomes);
  return outcomes?.[idx] ?? null;
}

function shortWallet(w?: string): string | null {
  if (!w) return null;
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

async function polymarketTrades(args: Record<string, unknown>) {
  const slugOrId = String(args.slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('slug_or_id is required.');
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
  const market = await lookupMarket(slugOrId);
  if (!market) return { error: 'not_found', message: `No market matching "${slugOrId}".` };
  if (!market.conditionId) return { error: 'no_condition_id', message: 'Market has no conditionId — trades unavailable.' };

  type RawTrade = {
    proxyWallet?: string; name?: string; side?: string; size?: number; price?: number;
    timestamp?: number; outcome?: string; outcomeIndex?: number;
  };
  const trades = await dataGet<RawTrade[]>('/trades', { market: market.conditionId, limit });

  return {
    market_id: market.id,
    market_slug: market.slug,
    question: market.question,
    trade_count: trades.length,
    trades: trades.map((t) => ({
      side: t.side ?? null,
      outcome: t.outcome ?? outcomeLabel(market, t.outcomeIndex),
      size: t.size ?? null,
      price: t.price ?? null,
      usd_value: t.size != null && t.price != null ? Math.round(t.size * t.price * 100) / 100 : null,
      timestamp: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null,
      trader: t.name || shortWallet(t.proxyWallet),
    })),
  };
}

async function polymarketHolders(args: Record<string, unknown>) {
  const slugOrId = String(args.slug_or_id ?? '').trim();
  if (!slugOrId) throw new Error('slug_or_id is required.');
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 10)));
  const market = await lookupMarket(slugOrId);
  if (!market) return { error: 'not_found', message: `No market matching "${slugOrId}".` };
  if (!market.conditionId) return { error: 'no_condition_id', message: 'Market has no conditionId — holders unavailable.' };

  type RawHolder = { proxyWallet?: string; pseudonym?: string; name?: string; amount?: number; outcomeIndex?: number };
  type RawHolderToken = { token?: string; holders?: RawHolder[] };
  const data = await dataGet<RawHolderToken[]>('/holders', { market: market.conditionId, limit });

  return {
    market_id: market.id,
    market_slug: market.slug,
    question: market.question,
    outcomes: (data ?? []).map((grp) => {
      const idx = grp.holders?.[0]?.outcomeIndex;
      return {
        outcome: outcomeLabel(market, idx) ?? `token ${grp.token?.slice(0, 8)}…`,
        token_id: grp.token ?? null,
        top_holders: (grp.holders ?? []).slice(0, limit).map((h) => ({
          trader: h.pseudonym || h.name || shortWallet(h.proxyWallet),
          wallet: shortWallet(h.proxyWallet),
          shares: h.amount ?? null,
        })),
      };
    }),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'polymarket_search':
      return polymarketSearch(args);
    case 'polymarket_top_markets':
      return polymarketTopMarkets(args);
    case 'polymarket_market':
      return polymarketMarket(args);
    case 'polymarket_event':
      return polymarketEvent(args);
    case 'polymarket_price_history':
      return polymarketPriceHistory(args);
    case 'polymarket_orderbook':
      return polymarketOrderbook(args);
    case 'polymarket_event_books':
      return polymarketEventBooks(args);
    case 'polymarket_trades':
      return polymarketTrades(args);
    case 'polymarket_holders':
      return polymarketHolders(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
