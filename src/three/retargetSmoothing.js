// 리타깃 후처리용 수학 도구 모음 (retarget.js 전용).
//
// 여기 있는 것들은 전부 "상태를 가진 필터"거나 순수 함수다. three 씬도 VRM 도 모른다.
// retarget.js 가 본별/손별로 인스턴스를 들고 있으므로, 실시간 경로와 FreeMoCap 경로가
// 같은 클래스를 써도 서로의 상태에 간섭하지 않는다.
//
// 배경 (실측 진단 결과):
//   3D 원본 위치는 깨끗하다(NaN 0 · 고립 스파이크 0 · 방향 반전율 0.15). 떨림은
//   위치가 아니라 "위치 → 각도" 변환 단계에서 만들어진다. 원인 두 가지:
//     (1) 각도 증폭 — 위치의 작은 오차가 회전으로 바뀌면서 크게 벌어진다
//         (팔꿈치각 |ΔAngle| p95 ≈ 10°/프레임). → One Euro 로 흡수.
//     (2) 손바닥 법선 부호 뒤집힘 — 왼손 20회 · 오른손 18회(최대 ~175° 완전 반전).
//         → retarget.js 의 법선 연속성으로 제거.
//   그래서 필터는 위치가 아니라 "최종 회전"에 건다.
//
//   한때 "팔이 펴지면 전완 roll 은 미결정"이라고 보고 roll 감쇠도 넣었지만 제거했다.
//   수어는 팔을 뻗은 채 손목을 회내/회외로 돌려 의미를 만들기 때문에 그 전제가 틀렸다.

import * as THREE from 'three';

const RAD2DEG = THREE.MathUtils.RAD2DEG;

// 모듈 스크래치. 이 함수들은 서로 중첩 호출되지 않으므로 공유해도 안전하다.
const _sq = new THREE.Quaternion();

// 두 쿼터니언 사이의 회전각(rad). q 와 -q 가 같은 회전이므로 |dot| 을 쓴다.
export function quatAngle(a, b) {
  const d = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(d);
}

export function quatAngleDeg(a, b) {
  return quatAngle(a, b) * RAD2DEG;
}

export function isFiniteQuat(q) {
  return Number.isFinite(q.x) && Number.isFinite(q.y)
    && Number.isFinite(q.z) && Number.isFinite(q.w);
}

// ---------------------------------------------------------------------------
// 쿼터니언용 One Euro 필터
//
// 성분별로 걸면 깨지므로(정규화가 안 맞고 이중피복 문제도 있다) slerp 로 구현한다:
//   1) 반구 정렬: dot(qPrev, qTarget) < 0 이면 qTarget 을 뒤집는다 (q ≡ -q)
//   2) 각속도:    speed = angle(qPrev, qTarget) / dt   [rad/s]
//   3) 적응 컷오프: fc = minCutoff + beta * speed       [Hz]
//   4) alpha = 1 / (1 + 1/(2π·fc·dt))
//   5) q = slerp(qPrev, qTarget, alpha).normalize()
//
// 이 slerp 는 기존 고정 계수 slerp(SMOOTH_*)와 "같은 연산"이고 alpha 만 적응형이다.
// 그래서 이 필터는 기존 slerp 를 대체한다 — 겹쳐 걸면 지연만 두 배가 된다.
//
// dt 는 상태마다 자기 시계로 잰다. 본 하나는 프레임당 한 번만 쓰이므로 사실상
// 프레임 간격과 같고, 호출부가 dt 를 넘겨줄 필요가 없어진다(두 주입 경로 모두 무개조).
// ---------------------------------------------------------------------------
export class QuatOneEuro {
  // minCutoff [Hz]: 정지 상태의 컷오프. 낮출수록 조용하지만 둔해진다.
  // beta [Hz / (rad/s)]: 빠를수록 컷오프를 얼마나 올릴지. 높이면 빠른 동작이 지연 없이 통과.
  // gapSec: 이보다 오래 안 불렸으면 끊겼다 재개된 것으로 보고 상태를 스냅(리셋)한다.
  constructor(minCutoff, beta, gapSec = 0.5) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.gapSec = gapSec;
    this.q = new THREE.Quaternion();
    this._t = new THREE.Quaternion(); // 반구 정렬용 사본 (호출부 쿼터니언을 안 건드리려고)
    this.reset();
  }

  reset() {
    this.q.set(0, 0, 0, 1);
    this.ready = false;
    this.time = 0;
    this.lastDelta = 0;  // 이번에 실제로 움직인 각(rad) — 계측용
    this.lastAlpha = 1;
    this.lastSpeed = 0;
  }

  // target 을 걸러서 내부 상태를 갱신하고 그 상태를 돌려준다.
  // 반환값은 내부 쿼터니언 참조다 — 호출부는 copy 해서 쓰고 보관하지 말 것.
  // NaN/Inf 목표거나 아직 유효 상태가 없으면 null (= 이번 프레임 쓰기 금지, 직전 유지).
  filter(target, nowSec) {
    if (!isFiniteQuat(target)) return this.ready ? this.q : null;

    // 첫 프레임: prev 가 없으니 필터를 통과시키고 상태만 저장한다.
    if (!this.ready) {
      this.q.copy(target).normalize();
      this.ready = true;
      this.time = nowSec;
      this.lastDelta = 0;
      this.lastAlpha = 1;
      this.lastSpeed = 0;
      return this.q;
    }

    let dt = nowSec - this.time;
    this.time = nowSec;

    // 오래 끊겼다 재개 → 이전 상태에 끌려 첫 프레임이 튀지 않게 스냅
    if (dt > this.gapSec) {
      this.q.copy(target).normalize();
      this.lastDelta = 0;
      this.lastAlpha = 1;
      this.lastSpeed = 0;
      return this.q;
    }
    // dt <= 0 (같은 타임스탬프 / 시계 역행) → alpha 계산 스킵, 직전 값 유지
    if (!(dt > 0)) { this.lastDelta = 0; return this.q; }
    dt = Math.min(0.2, Math.max(1 / 240, dt));

    // 1) 반구 정렬 — 안 하면 같은 회전인데 180° 돈 것처럼 보여 필터가 폭주한다
    this._t.copy(target);
    if (this.q.dot(this._t) < 0) {
      this._t.set(-this._t.x, -this._t.y, -this._t.z, -this._t.w);
    }

    // 2~4) 각속도 → 적응 컷오프 → alpha
    const speed = quatAngle(this.q, this._t) / dt;
    const fc = this.minCutoff + this.beta * speed;
    const tau = 1 / (2 * Math.PI * fc);
    const alpha = 1 / (1 + tau / dt);

    // 5) slerp + 정규화. 결과가 NaN 이면 직전 값을 그대로 유지한다
    //    (한 번 NaN 이 들어가면 slerp 를 타고 본 회전이 영구히 오염된다).
    _sq.copy(this.q).slerp(this._t, alpha).normalize();
    if (!isFiniteQuat(_sq)) return this.q;

    this.lastDelta = quatAngle(this.q, _sq);
    this.lastAlpha = alpha;
    this.lastSpeed = speed;
    this.q.copy(_sq);
    return this.q;
  }
}

// ---------------------------------------------------------------------------
// 각도 통계 (검증 전용 — 로직에 영향 없음)
// 프레임 간 |ΔAngle| 을 계열별로 모아 median / p95 / max 를 찍는다.
// "필터 전" 은 목표 회전끼리, "필터 후" 는 실제로 본에 들어간 회전끼리 비교한다.
// ---------------------------------------------------------------------------
const STAT_CAP = 4000; // 계열당 최대 표본 (메모리 상한)

export class AngleStats {
  constructor() {
    this.series = new Map();  // 이름 → number[]  (deg)
    this.counters = new Map(); // 이름 → number
    this.occ = new Map();      // side → { frames:Set<number>, peak:number }
  }

  reset() {
    this.series.clear();
    this.counters.clear();
    this.occ.clear();
  }

  // 가림으로 판정된 클립 프레임 하나를 기록. 같은 프레임이 두 번 와도 Set 이 흡수한다.
  occFrame(side, frame, occ) {
    let e = this.occ.get(side);
    if (!e) { e = { frames: new Set(), peak: 0 }; this.occ.set(side, e); }
    if (e.frames.size < STAT_CAP) e.frames.add(frame);
    if (occ > e.peak) e.peak = occ;
  }

  // 기록된 프레임 번호를 연속 블록으로 묶는다 → [[시작, 끝], ...]
  occBlocks(side) {
    const e = this.occ.get(side);
    if (!e || e.frames.size === 0) return [];
    const f = [...e.frames].sort((a, b) => a - b);
    const out = [[f[0], f[0]]];
    for (let i = 1; i < f.length; i++) {
      const last = out[out.length - 1];
      if (f[i] === last[1] + 1) last[1] = f[i];
      else out.push([f[i], f[i]]);
    }
    return out;
  }

  push(name, deg) {
    if (!Number.isFinite(deg)) return;
    let arr = this.series.get(name);
    if (!arr) { arr = []; this.series.set(name, arr); }
    if (arr.length < STAT_CAP) arr.push(deg);
  }

  count(name, n = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + n);
  }

  static summarize(arr) {
    if (!arr || arr.length === 0) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    return { n: s.length, med: at(0.5), p95: at(0.95), max: s[s.length - 1] };
  }

  // 한 본의 "전 → 후" 를 한 줄로. 표본이 없으면 null.
  line(label, beforeKey, afterKey) {
    const b = AngleStats.summarize(this.series.get(beforeKey));
    const a = AngleStats.summarize(this.series.get(afterKey));
    if (!b && !a) return null;
    const f = (s) => s ? `med ${s.med.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)}` : '—';
    return `${label.padEnd(14)} 전[${f(b)}] → 후[${f(a)}]`;
  }
}
