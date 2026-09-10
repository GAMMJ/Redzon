// 조용히 삼켜지던 실패를 Sentry로 올린다.
//
// `src/lib` 곳곳의 `catch {}`는 **의도적으로** 비어 있다. 캐시 쓰기가 실패해도 응답은
// 이미 손에 있고, 거기서 던지면 멀쩡한 요청이 죽는다. 그 판단은 지금도 맞다.
//
// 틀린 것은 **아무도 모른다**는 부분이었다. 삼키더라도 알리기는 해야 한다.
import "server-only"; // 클라 번들로 새지 않게 빌드타임에 막는다
import * as Sentry from "@sentry/nextjs";

/**
 * 삼킨 실패의 종류. 여기 없는 이름은 못 보낸다.
 *
 * 문자열을 부르는 자리에서 지어 쓰면 오타 하나가 새 태그가 되고, 대시보드에서 둘로
 * 갈린 뒤에야 알아차린다. `AnalyticsEvent`와 같은 이유로 타입이 먼저 막는다.
 */
export type SwallowedFailure =
  /** Upstash 설정 자체가 없다 — 캐시가 통째로 꺼진 상태다. 제일 위험하다. */
  | "redis:init"
  /** 캐시 읽기 실패. 이건 그나마 낫다 — PUBG를 한 번 더 부르면 값은 나온다. */
  | "redis:read"
  /** 일괄 캐시 읽기(`MGET`) 실패. 한 건이 아니라 그 배치 전체가 미스가 된다. */
  | "redis:read-many"
  /** 캐시 쓰기 실패. **다음 요청도 캐시를 못 쓴다는 뜻이라 한도가 새기 시작한다.** */
  | "redis:write"
  /** 실패 표시 쓰기(`SET NX`) 실패. 같은 오타가 계속 한도를 쓴다. */
  | "redis:write-if-absent";

/** 실패에 딸리는 값. 중첩 없이 평평하게. */
export type FailureContext = Record<string, string | number | boolean>;

/**
 * 같은 종류를 다시 올리기까지 기다리는 시간 — 5분.
 *
 * Redis가 죽으면 **모든 요청이** 실패한다. 그대로 보내면 무료 한도(월 5천 건)가
 * 몇 분 만에 타고, 그 뒤로는 진짜 봐야 할 에러가 잘려 나간다. 스로틀은 "홍수"를
 * "일정 간격 신호"로 바꾼다 — 장애가 계속되는 동안 5분마다 한 건씩 올라오므로
 * 시작과 끝이 그대로 보인다.
 */
const THROTTLE_MS = 5 * 60 * 1000;

/**
 * 종류별 마지막 발송 시각.
 *
 * 서버리스라 인스턴스마다 따로 센다 — 인스턴스 수만큼 중복될 수 있다. 그래도
 * 요청 수만큼 오는 것보다 몇 자릿수 적고, 정확한 횟수는 어차피 여기서 알 값이 아니다.
 * 키가 위 유니온으로 고정이라 이 Map은 무한히 자라지 않는다.
 */
const lastSentAt = new Map<SwallowedFailure, number>();

/**
 * 인프라 실패를 알린다. 종류당 5분에 한 번만 나간다.
 *
 * 되풀이될 것이 뻔한 실패(캐시·외부 저장소)에만 쓴다. 논리 버그처럼 드물게 나는
 * 것은 스로틀에 가려 다음 것을 놓칠 수 있으니 `reportUnexpected`를 쓸 것.
 */
export function reportSwallowed(
  failure: SwallowedFailure,
  error: unknown,
  context?: FailureContext,
): void {
  try {
    const now = Date.now();
    const last = lastSentAt.get(failure);
    if (last !== undefined && now - last < THROTTLE_MS) return;
    lastSentAt.set(failure, now);

    Sentry.captureException(error, {
      tags: { swallowed: failure },
      extra: context,
    });
  } catch {
    // 관측 도구가 서비스를 인질로 잡지 않는다. `analytics.ts`와 같은 규칙이다.
  }
}

/**
 * 예상 못 한 에러를 알린다. **스로틀하지 않는다.**
 *
 * 여기 오는 것은 원래 나면 안 되는 것이라 드물다. 스로틀을 걸면 방금 배포한 버그가
 * 5분간 가려져, 바로 다음에 터진 **다른** 버그를 못 보게 된다. Sentry가 지문으로
 * 묶어 주므로 같은 버그가 반복돼도 이슈는 하나다.
 */
export function reportUnexpected(error: unknown, context?: FailureContext): void {
  try {
    Sentry.captureException(error, { extra: context });
  } catch {
    // 위와 같다
  }
}
