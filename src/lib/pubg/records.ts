import "server-only";
import {
  fetchPubgCached,
  pubgErrorStatus,
  readCachedValue,
  readCachedValues,
  unwrapCachedPubgValue,
  writeCachedValue,
  type ProxyPubgOptions,
} from "@/lib/pubgProxy";
import type { GameMode, Platform } from "@/lib/constants";
import type {
  Player,
  PlayerRankedResponse,
  PlayerSeasonResponse,
  RankedGameMode,
  RankedGameModeStats,
  SeasonStats,
} from "@/types/player";
import type { LeaderboardEntry } from "@/types/leaderboard";
import type { MatchSummary } from "@/types/match";
import type { LifetimeResponse, LifetimeStats, SurvivalMastery, WeaponMastery } from "@/types/stats";
import {
  LIFETIME_SCHEMA_VERSION,
  LIFETIME_TTL,
  MASTERY_TTL,
  PLAYER_ID_SCHEMA_VERSION,
  PLAYER_ID_TTL,
  PLAYER_REFRESH_TTL,
  SEASON_STATS_TTL,
} from "@/lib/pubg/playerConstants";
import { summarizeWeaponMastery, WEAPON_MASTERY_SCHEMA_VERSION } from "@/lib/pubg/weaponMastery";
import { isValidMatchId } from "@/lib/pubg/matchId";
import {
  MATCH_BATCH_TIMEOUT,
  MATCH_DETAIL_TTL,
  MATCH_SUMMARY_SCHEMA_VERSION,
  MATCH_SUMMARY_TTL,
  MAX_SUMMARY_IDS,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_TIMEOUT,
  TELEMETRY_TTL,
} from "@/lib/pubg/matchConstants";
import { summarizeTelemetry } from "@/lib/pubg/telemetry";
import type { MatchTelemetry } from "@/types/telemetry";

/**
 * 조회 결과와 "실패해서 이렇게 됐는가"를 함께 들고 내려온다.
 *
 * 빈 값으로 내려앉는 것(degrade) 자체는 옳다. 리더보드 하나 못 불러왔다고 페이지를 통째로
 * 오류로 만들면 지금보다 나쁘다. 문제는 **빈 값만 남는 것**이다. 화면은 그것을 "없다"로밖에
 * 읽을 수 없어, 랭크를 실제로 돌린 사람에게 "이번 시즌 기록 없음"이라고 단정하게 된다.
 *
 * 실패했다는 사실을 함께 들고 내려오면 화면이 "없음"과 "못 불러옴"을 가려 말할 수 있다.
 *
 * `failed`를 따로 두고 `data`를 `null`로 겸용하지 않는 이유는, 이 코드에 이미 "없음"을
 * 뜻하는 `null`이 있기 때문이다(현재 시즌이 없는 기간). 거기에 실패까지 얹으면 지금 문제를
 * 이름만 바꿔 옮기는 셈이 된다.
 */
export interface Loaded<T> {
  data: T;
  /** true면 `data`는 실패로 인한 빈 값이다 — "없음"이 아니라 "모른다"는 뜻이다. */
  failed: boolean;
}

const loaded = <T,>(data: T): Loaded<T> => ({ data, failed: false });
const unavailable = <T,>(data: T): Loaded<T> => ({ data, failed: true });

interface SeasonsResponse {
  data?: Array<{ id: string; attributes: { isCurrentSeason: boolean } }>;
}
interface PlayersResponse {
  data?: Player[];
}

/**
 * 닉네임으로 플레이어 조회 — 없으면 null (PUBG는 존재하지 않는 닉네임에 404를 반환).
 *
 * **최근 매치 id가 함께 실려 온다.** PUBG엔 매치 목록 엔드포인트가 없어서 이 응답의
 * `relationships.matches`가 최근 전적의 유일한 출처다. 그래서 이건 오래 캐시할 수 없다 —
 * 한 판 뛰면 바뀌는 값이 같은 페이로드에 얹혀 있다.
 *
 * id만 필요하면 `getPlayerIdByName`을 쓸 것. 그쪽은 하루를 산다.
 */
export async function getPlayerByName(shard: string, name: string): Promise<Player | null> {
  return lookupPlayer(shard, name, PLAYER_REFRESH_TTL);
}

/**
 * 닉네임 → 계정 id. 매치 목록을 떼어 내고 하루 캐시한다.
 *
 * 통계 페이지처럼 최근 전적이 필요 없는 곳을 위한 것이다. 떼어 내는 것이 요점이다 —
 * 응답이 13KB에서 250바이트로 줄고(매치 id 200여 개가 대부분이다), 무엇보다 하루 동안
 * 얼어붙어도 곤란한 값이 남지 않는다.
 */
export async function getPlayerIdByName(shard: string, name: string): Promise<Player | null> {
  return lookupPlayer(shard, name, PLAYER_ID_TTL, {
    cacheKey: `player:id:${PLAYER_ID_SCHEMA_VERSION}:${shard}:${name}`,
    transform: (raw) => stripMatches(raw),
  });
}

/** 매치 관계를 뗀 응답. 담는 필드를 바꾸면 `PLAYER_ID_SCHEMA_VERSION`을 올릴 것. */
function stripMatches(raw: unknown): PlayersResponse {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return {};
  const players = raw.data.filter(isRecord).map(({ relationships, ...rest }) => {
    void relationships; // 떼어 내는 것이 목적이라 쓰지 않는다
    return rest as unknown as Player;
  });
  return { data: players };
}

async function lookupPlayer(
  shard: string,
  name: string,
  ttl: number,
  options?: ProxyPubgOptions,
): Promise<Player | null> {
  try {
    const res = await fetchPubgCached<PlayersResponse>(
      shard,
      "players",
      { "filter[playerNames]": name },
      ttl,
      options,
    );
    return res.data?.[0] ?? null;
  } catch (err) {
    // 방금 받은 404든 캐시에서 되살린 404든 같게 읽는다.
    // `axios.isAxiosError`만 보면 캐시된 실패가 그 검사를 통과하지 못해,
    // 없는 닉네임이 "찾을 수 없습니다" 대신 오류 화면이 된다.
    if (pubgErrorStatus(err) === 404) return null;
    throw err;
  }
}

// 현재 시즌 id — 진행 중인 시즌이 없으면 data가 null, 조회 실패면 failed.
// seasons 캐시키는 라우트와 통일(30분).
export async function getCurrentSeasonId(shard: string): Promise<Loaded<string | null>> {
  try {
    const res = await fetchPubgCached<SeasonsResponse>(shard, "seasons", {}, 1800, {
      cacheKey: `season:list:${shard}`,
    });
    return loaded(res.data?.find((season) => season.attributes.isCurrentSeason)?.id ?? null);
  } catch {
    // 실패(429·네트워크 등)해도 헤더 자체는 렌더한다. 다만 "시즌이 없다"고 말하지는 않는다.
    return unavailable(null);
  }
}

// 시즌 id 끝자리 = 시즌 번호 ("division.bro.official.pc-2018-33" → 33)
function parseSeasonNumber(id: string): number {
  const matched = id.match(/(\d+)$/);
  return matched ? Number(matched[1]) : 0;
}

// 현재 시즌 id + 번호 — 홈 시즌 배지/부제용. 진행 중인 시즌이 없으면 data가 null.
export async function getCurrentSeason(
  shard: string,
): Promise<Loaded<{ id: string; number: number } | null>> {
  const season = await getCurrentSeasonId(shard);
  if (!season.data) return { data: null, failed: season.failed };
  return loaded({ id: season.data, number: parseSeasonNumber(season.data) });
}

// 플레이어 랭크 스탯(모드별) — 플레이한 모드만 키로 존재.
//
// 시즌을 통째로 받는 이유는 실패가 전염되기 때문이다. 시즌 조회가 실패해 id를 모르면
// 이 스탯도 "없다"가 아니라 "모른다"다. id만 넘기면 호출부가 그 구분을 따로 이어 붙여야 하고,
// 한 곳만 빠뜨려도 화면이 다시 "기록 없음"이라고 단정한다.
export async function getPlayerRanked(
  shard: string,
  playerId: string,
  season: Loaded<string | null>,
): Promise<Loaded<Partial<Record<RankedGameMode, RankedGameModeStats>>>> {
  if (season.failed) return unavailable({});
  if (!season.data) return loaded({}); // 진행 중인 시즌이 없다 — 이건 실제로 "없음"이다
  try {
    const res = await fetchPubgCached<PlayerRankedResponse>(
      shard,
      `players/${playerId}/seasons/${season.data}/ranked`,
      {},
      SEASON_STATS_TTL,
    );
    return loaded(res.data?.attributes?.rankedGameModeStats ?? {});
  } catch {
    return unavailable({});
  }
}

// 플레이어 일반전 시즌 스탯(모드별) — 안 한 모드도 0값으로 내려올 수 있음.
// 시즌을 통째로 받는 이유는 랭크 쪽과 같다.
export async function getPlayerSeason(
  shard: string,
  playerId: string,
  season: Loaded<string | null>,
): Promise<Loaded<Partial<Record<GameMode, SeasonStats>>>> {
  if (season.failed) return unavailable({});
  if (!season.data) return loaded({});
  try {
    const res = await fetchPubgCached<PlayerSeasonResponse>(
      shard,
      `players/${playerId}/seasons/${season.data}`,
      {},
      SEASON_STATS_TTL,
    );
    return loaded(res.data?.attributes?.gameModeStats ?? {});
  } catch {
    return unavailable({});
  }
}

/**
 * 리더보드가 받는 shard는 따로다.
 *
 * `players`·`seasons`는 platform shard(`steam`·`xbox`)를 받지만, 리더보드에 같은 값을 넣으면
 * **400**이다. 문서가 "deprecated"라 적어 둔 platform-region 형태만 리더보드를 준다
 * (`docs/local/findings/pubg-shards.md` 실측).
 *
 * 리전은 하나씩 고정한다. steam은 한국 리더보드가 비어 아시아(`pc-as`)를 쓴다. 콘솔은
 * NA·EU·SA만 있고 AS·OC는 404라 NA로 잡았다. 리전 선택은 화면이 붙는 별건이다.
 */
const LEADERBOARD_REGION: Partial<Record<Platform, string>> = {
  steam: "pc-as",
  kakao: "pc-kakao",
  xbox: "xbox-na",
  psn: "psn-na",
};

// getLeaderboard limit 기본값 — 홈 카드는 상위 10명, 랭킹 페이지는 100명 전달.
const DEFAULT_LEADERBOARD_LIMIT = 10;

// 캐시에는 transform을 거친 LeaderboardEntry[]가 저장되고, 캐시 히트 시엔 검증 없이 캐스팅만 한다.
// 따라서 LeaderboardEntry의 필드가 바뀌면 옛 모양의 캐시가 TTL 동안 그대로 나가 런타임 에러가 난다.
// → 엔트리 모양을 바꿀 때마다 이 버전을 올려 캐시를 무효화할 것.
const LEADERBOARD_SCHEMA_VERSION = "v3";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// 리더보드 raw(JSON:API) → 상위 limit개 정제 배열. data.relationships.players.data(랭크순)를
// included(순서 무보장)에 id로 조인해 rank=순서로 부여한다.
function toLeaderboardEntries(raw: unknown, limit: number): LeaderboardEntry[] {
  if (!isRecord(raw)) return [];
  const data = isRecord(raw.data) ? raw.data : null;
  const relationships = data && isRecord(data.relationships) ? data.relationships : null;
  const players = relationships && isRecord(relationships.players) ? relationships.players : null;
  const refs = players && Array.isArray(players.data) ? players.data : [];
  const included = Array.isArray(raw.included) ? raw.included : [];

  const byId = new Map<string, Record<string, unknown>>();
  for (const item of included) {
    if (isRecord(item) && typeof item.id === "string") byId.set(item.id, item);
  }

  const entries: LeaderboardEntry[] = [];
  for (const ref of refs) {
    if (!isRecord(ref) || typeof ref.id !== "string") continue;
    const player = byId.get(ref.id);
    if (!player) continue;
    const attributes = isRecord(player.attributes) ? player.attributes : null;
    if (!attributes) continue;
    const stats: Record<string, unknown> = isRecord(attributes.stats) ? attributes.stats : {};
    entries.push({
      rank: entries.length + 1,
      name: toStr(attributes.name),
      tier: toStr(stats.tier),
      subTier: toStr(stats.subTier),
      rankPoints: toNumber(stats.rankPoints),
      games: toNumber(stats.games),
      averageDamage: toNumber(stats.averageDamage),
      averageKill: toNumber(stats.averageKill),
      winRatio: toNumber(stats.winRatio),
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

// 현재 시즌 리더보드 상위 limit개(정제본).
// 미지원 플랫폼은 빈 배열(실제로 없음), 조회 실패는 failed로 구분한다.
export async function getLeaderboard(
  platform: Platform,
  gameMode: GameMode,
  seasonId: string,
  limit: number = DEFAULT_LEADERBOARD_LIMIT,
): Promise<Loaded<LeaderboardEntry[]>> {
  const region = LEADERBOARD_REGION[platform];
  // 리더보드가 없는 플랫폼이다. 못 불러온 게 아니라 애초에 없는 것이라 실패가 아니다.
  //
  // 지금은 네 플랫폼이 다 매핑돼 있어 여기 오지 않는다. 맵을 Partial로 둔 것은 리더보드가
  // 없는 플랫폼이 생길 수 있어서고, 그때 이 줄이 받는다. 키 오타는 타입이 먼저 잡는다.
  if (!region) return loaded([]);
  try {
    const entries = await fetchPubgCached<LeaderboardEntry[]>(
      region,
      `leaderboards/${seasonId}/${gameMode}`,
      {},
      1800,
      {
        // limit별 캐시 분리 — 홈(10건)과 랭킹(100건)이 서로를 덮어쓰지 않게 한다.
        cacheKey: `leaderboard:${LEADERBOARD_SCHEMA_VERSION}:${region}:${gameMode}:${seasonId}:${limit}`,
        transform: (raw) => toLeaderboardEntries(raw, limit),
      },
    );
    return loaded(entries);
  } catch {
    // 실패해도 페이지는 그린다. 다만 빈 목록을 "랭킹이 없다"로 읽히게 두지는 않는다.
    return unavailable([]);
  }
}

// ─────────────────────────────────────────────────────────────
// 매치 (최근 전적)
// ─────────────────────────────────────────────────────────────

// 플레이어 응답에 실려 온 최근 매치 ID(최신순). PUBG엔 매치 목록 엔드포인트가 없다.
export function getPlayerMatchIds(player: Player): string[] {
  const refs = player.relationships?.matches?.data;
  if (!Array.isArray(refs)) return [];
  return refs.map((ref) => ref.id).filter((id): id is string => typeof id === "string");
}

// 매치 원본(JSON:API) → 특정 플레이어 기준 요약. 형태가 어긋나면 null.
// 참가자와 로스터가 included 한 배열에 섞여 오므로 type으로 갈라 처리한다.
function toMatchSummary(raw: unknown, playerId: string): MatchSummary | null {
  if (!isRecord(raw)) return null;
  const data = isRecord(raw.data) ? raw.data : null;
  if (!data || typeof data.id !== "string") return null;
  const attributes = isRecord(data.attributes) ? data.attributes : null;
  if (!attributes) return null;

  const included = Array.isArray(raw.included) ? raw.included : [];
  let totalTeams = 0;
  let stats: MatchSummary["stats"] = null;

  for (const item of included) {
    if (!isRecord(item)) continue;

    // 로스터 하나 = 팀 하나. 등수 분모로 쓴다.
    if (item.type === "roster") {
      totalTeams += 1;
      continue;
    }
    if (item.type !== "participant" || stats) continue;

    const itemAttributes = isRecord(item.attributes) ? item.attributes : null;
    const participantStats =
      itemAttributes && isRecord(itemAttributes.stats) ? itemAttributes.stats : null;
    // 조회 대상 플레이어의 기록일 때만 채택
    if (!participantStats || participantStats.playerId !== playerId) continue;

    stats = {
      winPlace: toNumber(participantStats.winPlace),
      kills: toNumber(participantStats.kills),
      assists: toNumber(participantStats.assists),
      damageDealt: toNumber(participantStats.damageDealt),
      headshotKills: toNumber(participantStats.headshotKills),
      timeSurvived: toNumber(participantStats.timeSurvived),
    };
  }

  return {
    id: data.id,
    matchType: toStr(attributes.matchType),
    gameMode: toStr(attributes.gameMode),
    mapName: toStr(attributes.mapName),
    createdAt: toStr(attributes.createdAt),
    isCustomMatch: attributes.isCustomMatch === true,
    totalTeams,
    stats,
  };
}

// 매치 여러 건을 캐시 우선으로 모아 요약으로 투영한다.
// 개별 실패(429 등)는 건너뛴다 — 한 건 때문에 목록 전체가 비는 것보다 낫고,
// 성공한 건은 캐시에 남아 다음 방문에 회복된다.
export async function getMatchSummaries(
  shard: string,
  playerId: string,
  matchIds: string[],
): Promise<MatchSummary[]> {
  // 형식이 어긋난 id는 PUBG 경로에 넣기 전에 떨군다
  const targets = matchIds.filter(isValidMatchId).slice(0, MAX_SUMMARY_IDS);
  if (targets.length === 0) return [];

  // 원본(약 63KB)이 아니라 투영한 요약(약 200바이트)을 캐시한다.
  // 원본을 캐시하면 목록 한 페이지를 그릴 때마다 630KB를 읽어와 2KB로 줄이는 셈이 된다.
  //
  // 요약은 플레이어 기준 투영이라 캐시 키에 playerId가 들어간다.
  // 같은 매치라도 사람마다 다른 요약이 나오므로 키를 공유할 수 없다.
  const cacheKeys = targets.map(
    (id) => `match:sum:${MATCH_SUMMARY_SCHEMA_VERSION}:${shard}:${playerId}:${id}`,
  );

  // 키가 매치마다 따로인 채로 **읽기만** 한 번에 묶는다(`MGET` = 명령 1개).
  // 키를 한 덩어리로 합치지 않는 이유는 TTL이다 — 매치 하나를 더하려고 덩어리를 다시 쓰면
  // 그 안의 모든 매치가 수명을 연장받는다. MATCH_SUMMARY_TTL의 7일은 신선도가 아니라
  // **용량**을 정하는 값이라(matchConstants 주석) 그 청소가 멈추면 무료 256MB가 위험해진다.
  // `unknown`으로 받는다 — 이 자리에는 요약뿐 아니라 실패 표시도 들어 있을 수 있다.
  // MatchSummary로 받아 두면 타입이 거짓말을 하고, unwrap을 빠뜨려도 컴파일이 통과한다.
  const cached = await readCachedValues<unknown>(cacheKeys);

  const settled = await Promise.allSettled(
    targets.map(async (id, i) => {
      // 히트한 값은 저장할 때 이미 transform을 거친 요약이다. 다시 변환하지 않는다.
      // 실패 표시가 섞여 있을 수 있어 unwrap이 필요하다 — 그냥 넘기면 {pubgFailed}가 카드가 된다.
      if (cached[i] !== null) return unwrapCachedPubgValue<MatchSummary | null>(cached[i]);

      // 미스만 PUBG로. 방금 미스로 판정했으므로 캐시를 다시 읽지 않는다.
      return fetchPubgCached<MatchSummary | null>(shard, `matches/${id}`, {}, MATCH_SUMMARY_TTL, {
        cacheKey: cacheKeys[i],
        transform: (raw) => toMatchSummary(raw, playerId),
        timeout: MATCH_BATCH_TIMEOUT,
        skipCacheRead: true,
      });
    }),
  );

  // 실패는 화면에서 "N건을 불러오지 못했습니다"로 사용자에게 보이지만 서버 로그에는 안 남는다.
  // 원인(타임아웃·네트워크·형태 불일치)을 나중에 추적하려면 여기서 한 줄 남겨야 한다.
  const rejected = settled.filter((result) => result.status === "rejected").length;
  if (rejected > 0) {
    console.warn(`[pubg] 매치 요약 ${rejected}/${targets.length}건 조회 실패 (${shard} ${playerId})`);
  }

  // allSettled는 입력 순서를 지키므로 최신순이 그대로 유지된다.
  // stats가 없는 요약(대상 플레이어가 그 매치 참가자에 없음)은 카드로 그릴 수 없어 여기서 뗀다.
  // 남겨두면 화면 단에서 조용히 사라져 "몇 건이 빠졌는지" 셈이 어긋난다.
  //
  // 결과가 요청보다 짧아지는 경로는 넷이다 — 조회 실패(네트워크·타임아웃), stats 없음,
  // toMatchSummary 형태 불일치, isValidMatchId 탈락. 화면에는 모두 "불러오지 못했습니다"로 수렴한다.
  //
  // transform이 null을 내면 캐시에 남지 않아 다음에도 다시 부른다.
  // 형태가 깨진 매치에 한정되고 매치 호출은 한도를 안 쓰므로 그대로 둔다.
  return settled
    .filter((result): result is PromiseFulfilledResult<MatchSummary | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((summary): summary is MatchSummary => summary !== null && summary.stats !== null);
}

// ─────────────────────────────────────────────────────────────
// 텔레메트리
// ─────────────────────────────────────────────────────────────

interface MatchAssetResponse {
  included?: Array<{ type?: string; attributes?: { URL?: string } }>;
}

// 매치 응답의 included에 asset이 정확히 1개 있고 거기 텔레메트리 주소가 들어 있다.
// 매치 6건으로 확인했다. 없으면 null.
async function getTelemetryUrl(shard: string, matchId: string): Promise<string | null> {
  try {
    const res = await fetchPubgCached<MatchAssetResponse>(
      shard,
      `matches/${matchId}`,
      {},
      MATCH_DETAIL_TTL,
    );
    const asset = res.included?.find((item) => item.type === "asset");
    return asset?.attributes?.URL ?? null;
  } catch {
    return null;
  }
}

/**
 * 매치 텔레메트리 요약. 실패하면 null로 degrade한다.
 *
 * 텔레메트리는 PUBG API가 아니라 CDN에 있다. 인증도 rate limit도 없어서
 * 프록시를 거치지 않고 직접 받는다. 대신 30MB가 넘으므로 원본은 캐시하지 않고
 * 요약(약 30KB)만 남긴다.
 *
 * 요약은 매치 단위라 그 매치에 참가한 모든 플레이어가 같은 캐시를 공유한다.
 */
export async function getMatchTelemetry(
  shard: string,
  matchId: string,
): Promise<MatchTelemetry | null> {
  if (!isValidMatchId(matchId)) return null;

  const cacheKey = `match:tel:${TELEMETRY_SCHEMA_VERSION}:${shard}:${matchId}`;
  const cached = await readCachedValue<MatchTelemetry>(cacheKey);
  if (cached) return cached;

  const url = await getTelemetryUrl(shard, matchId);
  if (!url) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const summary = summarizeTelemetry(await res.json());
    if (!summary) return null;

    await writeCachedValue(cacheKey, summary, TELEMETRY_TTL);
    return summary;
  } catch {
    // 네트워크·타임아웃·형태 불일치는 상세에서 텔레메트리 구역만 생략하고 넘어간다
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 통계 페이지 (통산 · 무기 · 생존)
// ─────────────────────────────────────────────────────────────

/**
 * 통산 스탯(모드별).
 *
 * 시즌과 달리 시즌 id가 필요 없다 — 경로가 `seasons/lifetime`으로 고정이다.
 * 그래서 시즌 조회 실패가 여기까지 번지지 않는다.
 */
export async function getLifetime(
  shard: string,
  playerId: string,
): Promise<Loaded<Partial<Record<GameMode, LifetimeStats>>>> {
  try {
    const res = await fetchPubgCached<LifetimeResponse>(
      shard,
      `players/${playerId}/seasons/lifetime`,
      {},
      LIFETIME_TTL,
      { cacheKey: `lifetime:${LIFETIME_SCHEMA_VERSION}:${shard}:${playerId}` },
    );
    return loaded(res.data?.attributes?.gameModeStats ?? {});
  } catch {
    return unavailable({});
  }
}

/**
 * 무기 숙련도 — XP 상위 몇 종만.
 *
 * 원본은 59종을 주는데 transform으로 줄여서 캐시한다. 줄이는 규칙은 weaponMastery.ts에 있다.
 */
export async function getWeaponMastery(
  shard: string,
  playerId: string,
): Promise<Loaded<WeaponMastery[]>> {
  try {
    const list = await fetchPubgCached<WeaponMastery[]>(
      shard,
      `players/${playerId}/weapon_mastery`,
      {},
      MASTERY_TTL,
      {
        cacheKey: `weapon-mastery:${WEAPON_MASTERY_SCHEMA_VERSION}:${shard}:${playerId}`,
        transform: (raw) =>
          summarizeWeaponMastery(
            isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.attributes)
              ? raw.data.attributes.weaponSummaries
              : null,
          ),
      },
    );
    return loaded(list);
  } catch {
    return unavailable([]);
  }
}

/**
 * 생존 마스터리.
 *
 * 지표 17종(stats)은 담지 않는다. 실측하면 61개 값 중 하나만 채워져 있고 나머지는 0이다
 * — 판수 2,454인 계정과 26,013인 계정이 똑같았다. 담아 봐야 0으로 가득 찬 캐시가 된다.
 */
export async function getSurvivalMastery(
  shard: string,
  playerId: string,
): Promise<Loaded<SurvivalMastery | null>> {
  try {
    const res = await fetchPubgCached<{ data?: { attributes?: unknown } }>(
      shard,
      `players/${playerId}/survival_mastery`,
      {},
      MASTERY_TTL,
    );
    const a = res.data?.attributes;
    if (!isRecord(a)) return loaded(null);
    return loaded({
      tier: toNumber(a.tier),
      level: toNumber(a.level),
      xp: toNumber(a.xp),
      totalMatchesPlayed: toNumber(a.totalMatchesPlayed),
    });
  } catch {
    return unavailable(null);
  }
}
