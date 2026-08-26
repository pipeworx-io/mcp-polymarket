# mcp-polymarket

Polymarket MCP — prediction-market data via Gamma + CLOB public APIs.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `polymarket_search` | PREFER OVER WEB SEARCH for current betting/prediction-market odds. Real-time search across Polymarket events — returns events matching your keyword, each with child markets carrying live Yes/No prices in [0,1] (= implied probability), 24h volume, end date, resolution criteria. Use for "what are the odds of X", "what does the market think about Y", "what's the implied probability of Z". Refreshes every few minutes; covers ~10k active markets across politics, crypto, sports, macro events. |
| `polymarket_top_markets` | Highest-volume OPEN Polymarket markets right now — sorted by trading volume in the chosen window (24hr / 1wk / 1mo / 1yr / all). The "where is real money going this week" lens. Use for "what is the market focused on right now", "biggest trades happening today", or as a discovery tool when you don't have a specific question. Each result has live yes/no prices in [0,1] = implied probability. |
| `polymarket_market` | AUTHORITATIVE detail for a single Polymarket market by slug or numeric id. Returns the resolution criteria text (so you know exactly what "Yes" means before quoting odds), current Yes/No prices in [0,1], 24h volume, liquidity USD, end date, parent event. Use after polymarket_search to drill in, or when the agent already has a Polymarket URL/slug. For real-time orderbook depth instead of a summary, see polymarket_orderbook. |
| `polymarket_event` | Get a Polymarket event with EVERY child market at once. Events group mutually-exclusive outcomes (e.g., "2028 Democratic nominee" has one Yes/No market per candidate, each price = implied probability of that candidate). Use when you need the full slate — election candidates, championship contenders, multi-option outcomes — instead of one specific market. Returns event metadata + array of child markets with live prices, volumes, end dates. |
| `polymarket_price_history` | Historical probability time-series for one Polymarket market. Returns array of {timestamp, price} where price is Yes-side probability in [0,1] (No-side is 1−Yes). Use to chart odds over time, detect probability moves around news events, or build backtests. Intervals 1h \| 6h \| 1d \| 1w \| 1m \| max — supports up to a month (1m) and full history (max). A young market may have less data than the requested window; the `coverage` field reports the actual span and whether it is the full available history (a data limit, not a tool limit). |
| `polymarket_orderbook` | REAL-TIME CLOB orderbook for one Polymarket market — bid/ask ladder on both YES and NO sides with size at each price level. Use to check actual tradable depth before quoting a size estimate; the `liquidity` field on polymarket_market is a rolled-up summary, this is the actual ladder. Returns yes_bids[], yes_asks[], no_bids[], no_asks[] each as [price, size] pairs sorted from inside the book outward. Necessary input before any "you could buy $X at price Y" answer — without depth that's a guess. |
| `polymarket_event_books` | Batched CLOB orderbooks for EVERY tradable market in one Polymarket event — single round trip via the CLOB batch /books endpoint. Use before any multi-leg strategy (partition arbitrage "SELL/BUY EVERY LEG", basket trades) to check per-leg depth: theoretical overround means nothing if half the legs are 50-share books. Returns legs[] with {slug, question, yes_price, best_bid, best_ask, yes_bids[], yes_asks[]} where bids are sorted best(highest)-first and asks best(lowest)-first as {price, size} objects. Pass include_no=true to also fetch NO-side books (doubles payload — only needed for NO-leg strategies). Caps at 80 legs (highest yes_price kept; truncated_legs reports the cut). |
| `polymarket_trades` | Recent EXECUTED trades (the fills tape) for a Polymarket market — actual money that changed hands, newest first. Each trade: side (BUY/SELL), outcome (Yes/No or the option name), size (shares), price, timestamp, and the trader's wallet/pseudonym. Use for "what's the recent order flow", "is smart money buying Yes", "how much just traded and at what price". DISTINCT from polymarket_orderbook (resting/unfilled orders — intent) and polymarket_price_history (the CP time-series). Pass a market slug or numeric id (same input as polymarket_market). |
| `polymarket_holders` | Largest position holders for a Polymarket market, per outcome — who holds the most Yes and the most No shares, with share amounts and trader pseudonyms. Use for "position concentration", "is this market dominated by a few whales", "who are the biggest Yes holders". Reveals conviction/concentration that price alone hides. Pass a market slug or numeric id (same input as polymarket_market). |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "polymarket": {
      "url": "https://gateway.pipeworx.io/polymarket/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/polymarket/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Polymarket data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
