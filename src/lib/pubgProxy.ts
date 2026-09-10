// PUBG API 프록시 헬퍼 — axios로 PUBG 호출 + Upstash Redis 캐싱. 도메인 라우트(/api/pubg/*)가 공유한다.
import "server-only"; // 클라 컴포넌트가 실수로 import하면 빌드타임 차단 (API 키 보호)
import axios from "axios";
import { Redis } from "@upstash/redis";
import { reportSwallowed, reportUnexpected } from "./reportError";

const PUBG_API_KEY = process.env.PUBG_API_KEY ?? "";
const PUBG_BASE_URL = "https://api.pubg.com";

// TTL에 기본값을 두지 않는다.
//
// 예전에는 60초가 기본이었는데, 그건 "적절하다"가 아니라 "정하지 않았다"는 뜻이었다.
// 세 호출이 인자를 빠뜨려 그 값을 그대로 썼고, 전적 페이지가 PUBG 호출 4회 중 3회를
// 거의 매번 새로 쓰고 있었다. 분당 한도가 10회인데 그게 조용히 새고 있었다.
//
// 필수 인자로 두면 다음에 빠뜨릴 때 컴파일이 선다. 주석으로는 못 막는다.

// 실패를 기억해 두는 시간 — 5분.
//
// 없는 닉네임이 5분 안에 생길 일은 드물고, 생기더라도 5분 뒤엔 보인다. 길게 잡으면
// 새 계정이 한참 "없음"으로 보이고, 짧게 잡으면 오타를 고쳐 가며 검색하는 동안 한도가 샌다.
const FAILURE_TTL = 60 * 5;

// ms — 개별 PUBG 호출 상한. 응답 없는 소켓 하나가 호출부를 무한정 붙잡지 못하게 막는 안전장치라
// 기본값은 넉넉히 잡는다. 짧게 잡으면 평소 느린 시간대에 정상 응답까지 끊겨,
// 닉네임 조회는 전역 에러로, 시즌 스탯은 "기록 없음"으로 둔갑한다.
// 여러 건을 병렬로 여는 호출부만 options.timeout으로 더 짧게 조인다.
const DEFAULT_TIMEOUT = 8000;

// 남은 호출 수가 이 값 이하로 떨어지면 로그에 남긴다.
// 한도는 분당 10회이고 프로필 1회가 4회를 쓰므로, 3 이하면 다음 조회가 막힐 수 있다는 뜻이다.
const RATE_LIMIT_WARN_AT = 3;

// 이 프로젝트가 지원하는 플랫폼 shard
export const SHARDS = ["steam", "kakao", "xbox", "psn"] as const;

// 쿼리로 들어온 shard가 유효한 값인지 검사하는 타입 가드
export function isValidShard(shard: unknown): shard is string {
  return typeof shard === "string" && (SHARDS as readonly string[]).includes(shard);
}

// Upstash Redis — UPSTASH_REDIS_REST_URL / _TOKEN 필요. 로컬 미설정 시 캐시만 건너뜀(에러 없이).
let redis: Redis | null = null;
try {
  redis = Redis.fromEnv();
} catch (err) {
  // 로컬에서 값을 안 채운 것과 배포에 값을 안 넣은 것이 여기서는 똑같이 생겼다.
  // 후자가 훨씬 나쁘다 — 캐시가 통째로 꺼진 채로 돌아, 모든 요청이 PUBG로 직행하고
  // 분당 10회에서 막힌다. 조용히 넘어가면 그 상태를 아무도 모른다.
  redis = null;
  reportSwallowed("redis:init", err);
}

export interface ProxyPubgOptions {
  // 이 호출에만 적용할 타임아웃(ms). 기본 DEFAULT_TIMEOUT.
  timeout?: number;
  // 기본 `pubg:{shard}:{path}:{params}` 대신 이 키로 캐시 (프리페치와 키 스킴 통일용)
  cacheKey?: string;
  // 캐시 저장·응답 전에 raw를 이 함수로 변환 (리더보드 정제 등)
  transform?: (raw: unknown) => unknown;
  // 캐시를 이미 읽었으니 다시 읽지 말 것 — `readCachedValues`로 일괄 조회한 뒤 미스만
  // 여기로 보내는 경로에서 쓴다. 안 켜면 방금 미스로 판정한 키를 한 번 더 GET해서
  // 일괄 읽기로 아낀 명령이 그대로 도로 나간다.
  skipCacheRead?: boolean;
}

// 기본 캐시 키 — shard + path + 쿼리 조합 (같은 경로라도 필터가 다르면 다른 응답)
function buildCacheKey(
  shard: string,
  path: string,
  params: Record<string, string>,
  override?: string,
): string {
  return override ?? `pubg:${shard}:${path}:${new URLSearchParams(params).toString()}`;
}

// 한도에 얼마나 근접했는지 남긴다.
// matches 는 rate limit 대상이 아니라 헤더가 아예 없다 — 그때는 조용히 넘어간다.
// 평소에는 찍지 않고 임계 이하일 때만 남겨 로그가 묻히지 않게 한다.
function logRateLimit(shard: string, path: string, headers: unknown): void {
  const raw = (headers as Record<string, unknown> | undefined)?.["x-ratelimit-remaining"];
  const remaining = Number(raw);
  if (!Number.isFinite(remaining) || remaining > RATE_LIMIT_WARN_AT) return;
  console.warn(`[pubg] 호출 한도 임박 — 남은 ${remaining}회 (${shard}/${path})`);
}

// PUBG는 429에 Retry-After를 주지 않는다. 대신 x-ratelimit-reset(유닉스 초)으로
// 창이 언제 열리는지 알려준다. 이 값을 Retry-After 초로 환산해 클라이언트가 쓸 수 있게 한다.
// 환산하지 않으면 클라이언트는 헤더가 없다고 보고 눈감고 지수 백오프를 돈다.
function secondsUntilReset(headers: unknown): number | null {
  const reset = Number((headers as Record<string, unknown> | undefined)?.["x-ratelimit-reset"]);
  if (!Number.isFinite(reset)) return null;
  const seconds = Math.ceil(reset - Date.now() / 1000);
  return seconds > 0 ? seconds : null;
}

// 캐시 조회 — 히트면 값, 미스/미설정/실패면 null (실패해도 PUBG 호출로 계속)
async function readCache(cacheKey: string): Promise<unknown> {
  if (!redis) return null;
  try {
    return (await redis.get(cacheKey)) ?? null;
  } catch (err) {
    // 읽기 실패는 그나마 낫다 — PUBG를 한 번 더 부르면 값은 나온다. 그래도 한도를
    // 쓰는 건 맞으므로 남긴다.
    reportSwallowed("redis:read", err, { cacheKey });
    return null;
  }
}

/**
 * 캐시에서 되살린 실패. 상태 코드를 들고 다닌다.
 *
 * 들고 다니는 것이 요점이다. 호출부는 `err.response?.status === 404`로 "없는 닉네임"과
 * 진짜 오류를 가리는데, 그냥 던지면 그 검사를 통과하지 못해 없는 닉네임이
 * "찾을 수 없습니다" 대신 오류 화면이 된다.
 */
export class CachedPubgFailure extends Error {
  constructor(readonly status: number) {
    super(`PUBG ${status} (캐시된 실패)`);
    this.name = "CachedPubgFailure";
  }
}

/** PUBG 호출이 낸 상태 코드. 방금 받은 것이든 캐시에서 되살린 것이든 같게 읽힌다. */
export function pubgErrorStatus(error: unknown): number | null {
  if (error instanceof CachedPubgFailure) return error.status;
  if (axios.isAxiosError(error)) return error.response?.status ?? null;
  return null;
}

/** 실패 표시. 성공값과 같은 키에 담으므로 둘을 가려낼 수 있어야 한다. */
interface FailureMark {
  pubgFailed: number;
}

function isFailureMark(value: unknown): value is FailureMark {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FailureMark).pubgFailed === "number"
  );
}

/**
 * 이 실패를 기억해 둘 것인가.
 *
 * **다시 물어도 같은 답이 올 것만** 담는다.
 * - 404·400 — 없는 닉네임, 잘못된 경로. 5분 안에 생길 리 없다
 * - 429 — 우리 한도다. 담으면 창이 열린 뒤에도 실패를 내주게 된다
 * - 5xx·타임아웃 — 남의 사정이고 일시적이다
 */
function shouldRememberFailure(status: number | null): status is number {
  return status !== null && status >= 400 && status < 500 && status !== 429;
}

// PUBG 호출 → (transform 적용) payload를 캐시에 저장하고 반환. 실패 시 throw.
async function fetchAndStore(
  shard: string,
  path: string,
  params: Record<string, string>,
  ttl: number,
  cacheKey: string,
  transform?: (raw: unknown) => unknown,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<unknown> {
  let response;
  try {
    response = await axios.get<unknown>(`${PUBG_BASE_URL}/shards/${shard}/${path}`, {
      timeout,
      headers: {
        Authorization: `Bearer ${PUBG_API_KEY}`,
        Accept: "application/vnd.api+json",
      },
      params,
    });
  } catch (err) {
    // 실패도 잠깐 기억한다. 안 그러면 같은 오타·같은 없는 계정이 매번 한도를 쓴다.
    //
    // 성공값과 같은 키에 담는다. 키를 따로 두면 잘 되는 동안에도 조회마다 GET이 한 번씩
    // 더 나가 평상시 비용이 두 배가 된다 — `steam/*`가 쓰는 것과 같은 수법이다.
    //
    // `IfAbsent`인 이유는 내가 실패하는 사이 다른 요청이 성공했을 수 있어서다.
    // 확인 없이 쓰면 늦게 실패한 쪽이 먼저 성공한 값을 지운다.
    const status = pubgErrorStatus(err);
    if (shouldRememberFailure(status)) {
      await writeCachedValueIfAbsent(cacheKey, { pubgFailed: status }, FAILURE_TTL);
    }
    throw err;
  }
  logRateLimit(shard, path, response.headers);

  const payload = transform ? transform(response.data) : response.data;
  if (redis) {
    try {
      await redis.setex(cacheKey, ttl, payload);
    } catch (err) {
      // 이번 응답은 이미 손에 있으니 그대로 반환한다. 문제는 **다음 요청**이다 —
      // 저장이 안 됐으니 같은 조회가 또 PUBG를 부른다. 이게 계속되면 분당 10회
      // 한도에서 사이트가 통째로 막힌다. 이 프로젝트에서 제일 조용한 사고다.
      reportSwallowed("redis:write", err, { cacheKey, ttl });
    }
  }
  return payload;
}

// PUBG 경로가 아닌 값도 같은 Redis에 담을 수 있게 열어둔다.
// 텔레메트리 요약처럼 CDN에서 받아 직접 가공한 결과가 여기 해당한다.
export async function readCachedValue<T>(cacheKey: string): Promise<T | null> {
  return (await readCache(cacheKey)) as T | null;
}

/**
 * 여러 키를 한 번에 읽는다(`MGET`) — 키가 몇 개든 Redis 명령 1개다.
 *
 * Upstash는 MGET을 키 개수와 무관하게 명령 하나로 센다. 문서에 없어서 직접 쟀다
 * (2026-09-09, `docs/local/findings/upstash-mget-billing.md` — mget 1,000회에 Reads가
 * 정확히 +1,000). **속도 이득은 없다**(병렬 GET 37ms vs MGET 37ms). 줄어드는 것은
 * 명령 수뿐이고, 그게 이 함수가 있는 유일한 이유다.
 *
 * 반환 배열은 **입력 키와 같은 길이·같은 순서**다. 값이 없거나 못 읽은 자리는 null이다.
 * 호출부가 인덱스로 키와 값을 맞추므로, 이 보장이 깨지면 남의 매치가 내 카드에 뜬다.
 *
 * 값을 해석하지 않고 그대로 준다 — 실패 표시(`{pubgFailed}`)가 섞여 있을 수 있다.
 * PUBG 경로에서 읽었다면 `unwrapCachedPubgValue`로 풀 것.
 */
export async function readCachedValues<T>(cacheKeys: string[]): Promise<(T | null)[]> {
  if (cacheKeys.length === 0) return [];
  // 캐시가 없으면 전부 미스다. 호출부는 평소와 같은 경로로 PUBG를 부르면 된다.
  if (!redis) return cacheKeys.map(() => null);
  try {
    const values = await redis.mget<unknown[]>(...cacheKeys);
    // 짧은 배열이 오면 뒤쪽 키가 조용히 사라진다. 길이를 맞춰 미스로 채운다.
    return cacheKeys.map((_, i) => (values?.[i] ?? null) as T | null);
  } catch (err) {
    // 한 건이 아니라 이 배치 전체가 미스가 된다. 매치 요약은 PUBG 한도를 안 쓰지만
    // 그만큼 화면이 느려지고, 이게 계속되면 캐시가 사실상 꺼진 것과 같다.
    reportSwallowed("redis:read-many", err, { count: cacheKeys.length });
    return cacheKeys.map(() => null);
  }
}

/**
 * 일괄로 읽은 값을 `fetchPubgCached`와 같은 규칙으로 푼다.
 *
 * `readCachedValues`는 값을 해석하지 않으므로 실패 표시도 그냥 객체로 보인다. 그걸 요약인
 * 줄 알고 화면에 넘기면 `{"pubgFailed":404}`가 카드로 그려진다. 여기서 걸러
 * `fetchPubgCached`가 던지는 것과 **같은 오류**로 바꿔, 두 경로가 호출부에 같게 보이게 한다.
 */
export function unwrapCachedPubgValue<T>(cached: unknown): T {
  if (isFailureMark(cached)) throw new CachedPubgFailure(cached.pubgFailed);
  return cached as T;
}

export async function writeCachedValue(cacheKey: string, value: unknown, ttl: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.setex(cacheKey, ttl, value);
  } catch (err) {
    // 호출부는 이미 값을 갖고 있으니 여기서 던지지 않는다. 위 `fetchAndStore`와 같은
    // 이유로 남긴다 — 다음 요청이 캐시를 못 쓴다.
    reportSwallowed("redis:write", err, { cacheKey, ttl });
  }
}

/**
 * 키가 비어 있을 때만 쓴다(`SET ... NX`). **썼으면 true, 이미 뭔가 있어서 못 썼으면 false.**
 *
 * 한 키에 성질이 다른 두 값을 담는 자리를 위한 것이다. 조회 실패를 성공값과 같은 키에
 * 표시해 두는 곳(`steam/*`)이 그렇다 — "먼저 읽어 보고 성공값이면 안 쓴다"로 막아 두어도
 * 읽기와 쓰기 사이의 Redis 왕복 한 번이 창으로 남는다. 그 사이에 다른 요청이 성공값을 써
 * 두면 늦게 실패한 쪽이 그걸 지운다. 조건을 Redis에 맡기면 창이 없다.
 *
 * 결과를 돌려주는 것이 요점이다. 안 돌려주면 호출부가 "내가 썼나"를 알아내려고 키를 한 번
 * 더 읽어야 하는데, 그건 대개 헛읽기다 — 실패는 보통 키가 비어 있을 때 일어나고 그때는
 * 이 함수가 이긴다. false일 때만 읽으면 실패 경로마다 나가던 GET 한 번이 사라진다.
 *
 * Redis가 없으면 false다. 못 썼다는 뜻으로는 맞지만 "남이 이겼다"는 뜻은 아니므로,
 * 호출부는 false를 받았을 때 무엇이 있는지 실제로 확인해야 한다.
 */
export async function writeCachedValueIfAbsent(
  cacheKey: string,
  value: unknown,
  ttl: number,
): Promise<boolean> {
  if (!redis) return false;
  try {
    return (await redis.set(cacheKey, value, { ex: ttl, nx: true })) === "OK";
  } catch (err) {
    // 호출부는 이미 값을 갖고 있다. 다만 실패 표시가 안 남았으므로 같은 오타·같은
    // 없는 계정이 5분간 계속 한도를 쓴다.
    reportSwallowed("redis:write-if-absent", err, { cacheKey, ttl });
    return false;
  }
}

// 서버 컴포넌트/배치용 — Response가 아닌 "데이터"를 반환하는 캐시 우선 조회. 실패 시 throw.
export async function fetchPubgCached<T = unknown>(
  shard: string,
  path: string,
  params: Record<string, string>,
  ttl: number,
  { cacheKey: cacheKeyOverride, transform, timeout, skipCacheRead }: ProxyPubgOptions = {},
): Promise<T> {
  const cacheKey = buildCacheKey(shard, path, params, cacheKeyOverride);
  // 일괄 읽기로 이미 미스 판정이 난 키면 다시 읽지 않는다.
  if (!skipCacheRead) {
    const cached = await readCache(cacheKey);
    // 조금 전에 실패한 조회면 PUBG를 또 두드리지 않는다. 상태 코드를 들고 던져,
    // 호출부가 방금 받은 실패와 똑같이 다루게 한다.
    if (isFailureMark(cached)) throw new CachedPubgFailure(cached.pubgFailed);
    if (cached !== null) return cached as T;
  }
  return (await fetchAndStore(shard, path, params, ttl, cacheKey, transform, timeout)) as T;
}

// 허용된 PUBG 하위 경로(path)만 프록시. 캐시 우선 조회 후 Response 반환.
// path 예시: 'players', 'seasons', 'matches/{id}', 'players/{id}/seasons/{seasonId}/ranked'
export async function proxyPubg(
  shard: string,
  path: string,
  params: Record<string, string>,
  ttl: number,
  { cacheKey: cacheKeyOverride, transform, timeout }: ProxyPubgOptions = {},
): Promise<Response> {
  const cacheKey = buildCacheKey(shard, path, params, cacheKeyOverride);

  // 캐시 있으면 PUBG 호출 없이 반환 (rate limit 절약)
  const cached = await readCache(cacheKey);
  // 실패도 캐시에 담기므로 성공값과 갈라야 한다. 안 가르면 `{"pubgFailed":404}`가
  // 200으로 나가고, 브라우저는 그걸 정상 응답으로 읽는다.
  if (isFailureMark(cached)) {
    return Response.json(
      { error: `PUBG ${cached.pubgFailed}` },
      { status: cached.pubgFailed, headers: { "X-Cache": "HIT" } },
    );
  }
  if (cached !== null) {
    return Response.json(cached, { headers: { "X-Cache": "HIT" } });
  }

  try {
    const payload = await fetchAndStore(shard, path, params, ttl, cacheKey, transform, timeout);
    return Response.json(payload, {
      headers: {
        "Cache-Control": `s-maxage=${ttl}, stale-while-revalidate`,
        "X-Cache": "MISS",
      },
    });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? 500;
      const headers: Record<string, string> = {};
      // PUBG가 429(rate limit) 응답 시 Retry-After를 그대로 클라이언트에 전달
      if (status === 429) {
        // PUBG가 Retry-After를 주면 그대로, 아니면 reset 시각에서 환산한다.
        const retryAfter =
          err.response?.headers?.["retry-after"] ?? secondsUntilReset(err.response?.headers);
        console.warn(`[pubg] 429 한도 초과 (${shard}/${path}) — ${retryAfter ?? "?"}초 후 재시도 가능`);
        if (retryAfter) headers["Retry-After"] = String(retryAfter);
      }
      return Response.json({ error: err.response?.data ?? err.message }, { status, headers });
    }
    // axios 에러가 아닌 것이 여기 왔다는 건 우리 쪽 버그다 — transform이 던졌거나
    // 예상 못 한 값이 들어왔거나. 화면에는 그대로 500을 주되(사용자에게 스택을 보일
    // 이유가 없다) 스로틀 없이 올린다. 드물게 나는 것이라 가려지면 안 된다.
    reportUnexpected(err, { shard, path });
    return Response.json({ error: "서버 내부 오류가 발생했습니다" }, { status: 500 });
  }
}
