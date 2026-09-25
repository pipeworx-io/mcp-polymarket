interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Polymarket');
}

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
    summary: 'Polymarket prediction markets matching a keyword, each with its live Yes/No price.',
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
    summary: 'The highest-volume open Polymarket markets right now, over a 24-hour to all-time window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window: { type: 'string', description: '24hr | 1wk | 1mo | 1yr | all (default 24hr)' },
        limit: { type: 'number', description: '1–100 per page (default 10)' },
        offset: { type: 'number', description: 'Pagination offset into the volume-ranked list (default 0). Use offset=100 (with limit=100) to fetch ranks 101–200, offset=200 for 201–300, etc. — walk the pages to build a true top-N-by-volume set.' },
      },
      required: [],
    },
  },
  {
    name: 'polymarket_market',
    description:
      'AUTHORITATIVE detail for a single Polymarket market by slug or numeric id. Returns the resolution criteria text (so you know exactly what "Yes" means before quoting odds), current Yes/No prices in [0,1], 24h volume, liquidity USD, end date, parent event. Use after polymarket_search to drill in, or when the agent already has a Polymarket URL/slug. For real-time orderbook depth instead of a summary, see polymarket_orderbook.',
    summary: 'One Polymarket market in full, including the exact wording that decides how it resolves.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug_or_id: { type: 'string', description: 'Market slug (e.g. "will-bitcoin-hit-150k-by-december-31-2027") or numeric id. A dated slug stops resolving once it settles — Polymarket de-indexes resolved markets — so if a plausible slug 404s, re-find it with polymarket_search rather than assuming the market never existed.' },
      },
      required: ['slug_or_id'],
    },
  },
  {
    name: 'polymarket_event',
    description:
      'Get a Polymarket event with EVERY child market at once. Events group RELATED outcomes (e.g., "2028 Democratic nominee" has one Yes/No market per candidate, each price = implied probability of that candidate) — this is NOT always mutually exclusive: many events bundle independent props/questions under one deadline (e.g. per-senator vote markets) where multiple legs can resolve YES together. Check the returned `neg_risk` field (event- and market-level) before assuming the child markets sum to ~1 — only `neg_risk: true` means Polymarket has verified exclusivity. Use when you need the full slate — election candidates, championship contenders, multi-option outcomes — instead of one specific market. Returns event metadata + array of child markets with live prices, volumes, end dates.',
    summary: 'A Polymarket event with every child market, for questions that have more than two outcomes.',
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
    summary: 'How a Polymarket market\'s Yes-side probability moved over time, as a timestamped series.',
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
    summary: 'The live bid and ask ladder for one Polymarket market, with the size available at each price.',
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
    summary: 'Live order books for every tradable market in a single Polymarket event, in one request.',
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
    summary: 'Trades recently executed on a Polymarket market — side, outcome, size and price, newest first.',
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
    summary: 'The largest Yes and No position holders in a Polymarket market, with their share counts.',
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
  const res = await pwFetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error('Polymarket: not found');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket Gamma: ${res.status} ${text.slice(0, 200)}`);
  }
  return parseJson<T>(res, 'Polymarket');
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
  const res = await pwFetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket CLOB: ${res.status} ${text.slice(0, 200)}`);
  }
  return parseJson<T>(res, 'Polymarket');
}

async function clobPost<T = unknown>(
  path: string,
  body: unknown,
  creds?: BuilderCreds | null,
): Promise<T> {
  const payload = JSON.stringify(body);
  const headers = await clobHeaders(creds ?? null, 'POST', path, payload);
  const res = await pwFetch(CLOB + path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket CLOB: ${res.status} ${text.slice(0, 200)}`);
  }
  return parseJson<T>(res, 'Polymarket');
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
  // Fleet #2042 — Polymarket's own structured exclusivity marker. A market
  // (and its parent event) is only a verified mutually-exclusive partition
  // when this is true — a shared end-date is NOT sufficient (independent
  // props like "which senators vote yea" share a deadline and are not
  // exclusive). See RawEvent.negRisk for the event-level flag, which is
  // what handlePolymarketArbitrage actually gates on.
  negRisk?: boolean;
  // Polymarket's OWN taker-fee parameters, per market. Gamma carries the
  // actual schedule rather than a category we would have to map:
  //   feeSchedule = { exponent, rate, takerOnly, rebateRate }
  //   feeType     = 'crypto_fees_v2' | 'politics_fees' | 'general_fees' | …
  //   feesEnabled = false on the fee-free categories (geopolitics/world events)
  // Measured across 100 live markets 2026-09-13: feeSchedule.rate and feeType
  // populated on 94, feesEnabled on 100 — while `category` and `tags` were
  // populated on ZERO. So the rate is read, never inferred (fleet #1927).
  feeSchedule?: { exponent?: number; rate?: number; takerOnly?: boolean; rebateRate?: number } | null;
  feeType?: string | null;
  feesEnabled?: boolean | null;
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
  // Fleet #2042 — true only when Polymarket has deployed its neg-risk
  // adapter for this event, i.e. the event's outcomes are a VERIFIED
  // mutually-exclusive partition (the adapter is what keeps YES prices
  // summing to ~1). Absent/false does not mean "not exclusive" in some
  // philosophical sense — it means Polymarket itself has not certified
  // it, which is the only basis strong enough to suggest a sum-based
  // arbitrage trade on.
  negRisk?: boolean;
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
    // Fleet #2042 — market-level neg-risk flag; see RawEvent.negRisk for
    // the event-level flag the arbitrage tool actually gates on.
    neg_risk: m.negRisk ?? null,
    // Taker-fee parameters as Polymarket publishes them per market, so a
    // caller costing a trade does not have to guess the category. Fee is
    // charged to TAKERS ONLY: fee = shares × rate × (p × (1-p))^exponent.
    // fees_enabled false means the market is genuinely fee-free (the
    // geopolitics / world-events categories), which is different from
    // "we don't know" — that is fee_rate_taker null.
    fee_rate_taker: m.feesEnabled === false ? 0 : (m.feeSchedule?.rate ?? null),
    fee_exponent: m.feeSchedule?.exponent ?? null,
    fee_taker_only: m.feeSchedule?.takerOnly ?? null,
    fee_maker_rebate_rate: m.feeSchedule?.rebateRate ?? null,
    fee_category: m.feeType ?? null,
    fees_enabled: m.feesEnabled ?? null,
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
    // Fleet #2042 — Polymarket's own mutually-exclusive-partition marker.
    // polymarket_arbitrage reads this to decide whether a same-deadline
    // multi-leg event is actually exclusive before suggesting a sum-based
    // trade — a shared deadline alone is not exclusivity (independent
    // props/questions share deadlines too).
    neg_risk: e.negRisk ?? null,
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

// Gamma /public-search matches literally: "Fed rate cut next meeting" finds only a
// $52-volume 2028-horizon market while "Fed rate" finds the $5.8M "Fed Decision in
// July?" book. Filler words in agent phrasing sink recall, so when the first pass
// comes back thin we retry with the filler stripped, then with the first two
// content words, and merge.
const SEARCH_FILLER = new Set([
  'the', 'a', 'an', 'of', 'at', 'on', 'in', 'for', 'to', 'and', 'or',
  'next', 'current', 'currently', 'latest', 'will', 'be', 'what', 'are',
  'is', 'was', 'odds', 'chance', 'chances', 'probability', 'meeting',
  'upcoming', 'today', 'now', 'right',
]);

function broadenQueries(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  const content = words.filter((w) => !SEARCH_FILLER.has(w.toLowerCase()));
  const out: string[] = [];
  const stripped = content.join(' ');
  if (stripped && stripped.toLowerCase() !== query.toLowerCase()) out.push(stripped);
  if (content.length > 2) out.push(content.slice(0, 2).join(' '));
  return out;
}

async function polymarketSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required (e.g. "election", "rate cut").');
  const limit = clamp(toNum(args.limit, 5), 1, 25);
  const includeClosed = args.include_closed === true;

  const fetchEvents = async (q: string): Promise<RawEvent[]> => {
    const data = await gammaGet<{ events?: RawEvent[] }>('/public-search', { q, limit_per_type: 25, events_status: includeClosed ? 'all' : 'active' });
    let events = data.events ?? [];
    if (!includeClosed) {
      events = events.filter((e) => e.active === true && e.closed === false && e.archived !== true);
    }
    return events;
  };
  const maxVol = (es: RawEvent[]) => es.reduce((m, e) => Math.max(m, e.volume24hr ?? 0), 0);

  let events = await fetchEvents(query);
  // Exact-query matches are events Gamma judged to contain EVERY word the
  // caller typed — the most specific match possible. Record their ids before
  // broadening runs (broadening below merges more events into `events`).
  // Bug (fleet #1319, Bruce dogfooding 2026-09-07): querying
  // "Presidential Election Winner 2028" returned only 2 exact hits (below
  // the `< 3` threshold), so the code broadened to "Presidential Election"
  // (broadenQueries keeps the first two content words, which are
  // disproportionately the GENERIC domain terms — the specific ones,
  // "Winner 2028", sit at the end and get dropped). The broadened fetch
  // pulled in "Brazil Presidential Election" at $588K 24h volume, versus
  // $341K for the exact "Presidential Election Winner 2028" — and the old
  // sort-by-volume-only below put the wrong country's market first. A
  // broadened variant is structurally biased toward generic, high-volume
  // noise, because it necessarily dropped the caller's most discriminating
  // words to get there — so it must never be allowed to outrank an exact
  // match on volume alone.
  const exactIds = new Set(events.map((e) => e.id));
  let broadened: string | null = null;
  if (events.length < 3 || maxVol(events) < 1000) {
    // Run EVERY broadened variant (there are at most 2) and merge — the
    // shortest one often has the best recall ("Fed rate" finds the $5.8M
    // "Fed Decision in July?" book that "Fed rate cut" misses because the
    // title doesn't contain "cut").
    for (const alt of broadenQueries(query)) {
      const more = await fetchEvents(alt);
      if (more.length > 0) {
        const seen = new Set(events.map((e) => e.id));
        events = events.concat(more.filter((e) => !seen.has(e.id)));
        broadened = broadened ? `${broadened}, ${alt}` : alt;
      }
    }
  }
  // Exact matches always outrank broadened-only matches — a specific match
  // wins when one exists, full stop — then actively-traded books within
  // each tier: a near-zero-volume market's mid price is noise, and quoting
  // it as "the odds" misleads (its spread can be 70pp wide).
  events.sort((a, b) => {
    const aExact = exactIds.has(a.id) ? 1 : 0;
    const bExact = exactIds.has(b.id) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return (b.volume24hr ?? 0) - (a.volume24hr ?? 0);
  });

  // `count` must describe what's actually returned (matches polymarket_top_markets'
  // convention) — the old `events.length` reported the full pre-truncation match
  // count (e.g. 21) while only `limit` events were returned (e.g. 5), with no
  // signal that more existed. Expose total_matched + truncated so a caller can
  // raise `limit` to page deeper.
  const matched = events.length;
  const shaped = events.slice(0, limit).map(shapeEvent);
  return {
    query,
    ...(broadened
      ? {
          broadened_query: broadened,
          note_broadened: `Your exact query matched few or thin-volume markets, so this ALSO searched a broadened term ("${broadened}") and merged in its results. Broadened results are sorted after any exact match (never above one) because broadening drops the words that made your query specific, and a dropped-word search can surface an unrelated event — a different country or year — that just happens to share the generic words and trade more volume.`,
        }
      : {}),
    count: shaped.length,
    total_matched: matched,
    truncated: matched > shaped.length,
    events: shaped,
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
    throw new Error(`user_error: Invalid window "${window}". Valid: 24hr | 1wk | 1mo | 1yr | all.`);
  }
  const limit = clamp(toNum(args.limit, 10), 1, 100);
  // Pagination: Gamma /markets honours `offset` alongside `limit`, so callers
  // can walk past the first page (e.g. offset=100 → ranks 101–200) to assemble
  // a true top-N-by-volume set instead of being capped at a single 100 page.
  const offset = clamp(toNum(args.offset, 0), 0, 10000);
  const markets = await gammaGet<RawMarket[]>('/markets', {
    limit,
    offset,
    active: true,
    closed: false,
    order: sortKey,
    ascending: false,
  });
  return {
    window,
    offset,
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
  const res = await pwFetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Polymarket Data API: ${res.status} ${text.slice(0, 200)}`);
  }
  return parseJson<T>(res, 'Polymarket');
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
