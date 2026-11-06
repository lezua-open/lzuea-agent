import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * 滚动跟随：跟着**看得见的底**走。
 *
 * 这条线是**按时间推进**的，不是按内容推进的。字什么时候亮由 CSS 的
 * animation-delay 决定，跟内容什么时候到不是一回事 —— 所以跟随不能靠
 * 「内容变了」驱动，更不能靠「还有字没起跑」决定活多久：
 *
 *   慢流时 wave.ts 给每个字的延迟都是 0（wave.test.ts 断言的就是这一点），
 *   「还有字没起跑」一早就为假，靠它收工的循环一帧就死，退化成「一个 delta
 *   滚一次」，两次 delta 之间页面掉下去几百像素（实测 p50 落后 624px）。
 *
 *   突发时波要推 240ms，这段时间内容并不变，也没有任何事件能叫醒滚动。
 *
 * 但**循环只在还有字在对焦时跑**。收工条件一放宽成「只要钉着就跑」，回复
 * 结束后它就会每帧把页面按回底部，用户往上翻一点就被拽回来 —— 表现就是
 * 「消息没办法滚动了」。
 */

function noop(): void {}

/** 「减少动态效果」下 .char-in 的动画被关掉，字落地即清晰，没有「显现前沿」可言 */
export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 一个已起跑的字「看得见的底」在视口里的 Y。
 *
 * 字可能排版在某个 `overflow` 祖先的可视高度之外 —— 思考块的 `0fr/1fr`
 * 自适应网格在文字流入时行高跟不上内容，就会把新字裁在滚动盒外面。
 * 那时 `getBoundingClientRect()` 给的是**排版**位置，不是眼睛能看到的位置；
 * 照它滚会把目标推到 `scrollHeight` 之外，被浏览器钳死在最大可滚位置，
 * 页面从此追不上显现前沿（实测 3505/5968 帧被钳住）。
 *
 * 所以沿路收一收：被哪一层裁掉，就以哪一层的底为准。
 *
 * 路上撞见**内嵌滚动口**（`overflow-y: auto|scroll`）就直接以它的底为准，
 * 不管字在窗内还是窗外。滚动口对上层来说是一扇窗，外层该看的是窗框的底，
 * 不是窗里那个会随内层滚动来回挪的字。拿窗里的字当目标，外层就会跟着内层
 * 一起抖 ——「思考块离视口底的距离一直在闪烁」就是这么来的。
 *
 * 但只认**最里层**那个滚动口，而且窗框本身还要继续被外层裁剪：
 * 收起的思考块里 `0fr` 网格把整个滚动口压成 0 高，它的 rect 仍是排版全高，
 * 是个幻影底边，得再被 `overflow: hidden` 的网格内层收掉。
 */
export function visibleBottom(c: HTMLElement, scroller: HTMLElement): number {
  let bottom = c.getBoundingClientRect().bottom
  let windowed = false
  for (let n: HTMLElement | null = c.parentElement; n && n !== scroller; n = n.parentElement) {
    const style = getComputedStyle(n)
    if (style.overflowY === 'visible' && style.overflowX === 'visible') continue
    const r = n.getBoundingClientRect()
    if (!windowed && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
      bottom = r.bottom
      windowed = true
    }
    if (bottom > r.bottom) bottom = r.bottom
  }
  return bottom
}

/** 空壳装饰（光标、占位），不算内容 */
function isBlank(c: HTMLElement): boolean {
  return c.childElementCount === 0 && c.textContent === ''
}

/**
 * 内容的末梢是不是流式字。
 *
 * 顺着「最后一个孩子」这条链走到底：末梢是 `.char-in`，说明尾部还在逐字冒出来，
 * 滚动得跟显现前沿走；末梢是别的东西（工具卡片、静态 Markdown），那是**真内容**，
 * 滚动得跟排版底走 —— 否则新卡片永远掉在折叠线下面，没人看得见工具在干什么。
 *
 * 空壳装饰（光标、占位）跳过去找前一个。React 每个 delta 都会重渲染一次，
 * 判定必须纯靠 DOM 现状，不能靠任何「上一次是什么」的状态，否则判定会在
 * 两种口径之间来回翻，页面就跟着闪。
 */
function endsInChar(el: HTMLElement): boolean {
  let n: HTMLElement = el
  for (;;) {
    let c = n.lastElementChild as HTMLElement | null
    while (c && !c.classList.contains('char-in') && isBlank(c)) {
      c = c.previousElementSibling as HTMLElement | null
    }
    if (!c) return false
    if (c.classList.contains('char-in')) return true
    n = c
  }
}

/**
 * 「看得见的底」在滚动容器内容坐标里的 Y。
 *
 * 流式时排版底部会比看得见的字高出一截 —— 还没起跑的字是 `opacity: 0` 的 span，
 * 占着排版位置但看不见。滚动跟着 scrollHeight 走就是「字还没出来，界面先掉下去」。
 * 所以取最后一个**已经起对焦**的字的底边，那才是眼睛此刻的落点。
 *
 * 口径**只有一条**：末梢还在冒字就跟显现前沿，末梢是真内容就跟排版底。
 * 绝不能按「波跑没跑完」在两个值之间切 —— 那样每次 delta 到货都要在
 * 「末字的底」和「scrollHeight」之间跳一次，差额正好是末字后面的排版尾巴，
 * 页面先掉下去再缩回来，外层就是「思考块离视口底的距离一直在闪烁」。
 */
export function visualBottom(el: HTMLElement): number {
  if (reducedMotion()) return el.scrollHeight
  const chars = el.querySelectorAll<HTMLElement>('.char-in')
  if (chars.length === 0) return el.scrollHeight
  if (!endsInChar(el)) return el.scrollHeight

  // 从尾部倒着找第一个已经起跑的字，它的底边就是眼睛此刻的落点。
  //
  // 只在**最后那条流**里找，绝不跨块回退。跨块回退就是「上下闪烁」的根源：
  // 尾部那条流一旦整体重排期（StreamText 卸载重挂、或新流刚起还没起跑），
  // 「全篇最后一个已起跑的字」会掉回上面那个块 —— 目标一次性往上抽几千像素，
  // 页面猛拽一下再回来。尾流一个字都没起跑就原地不动，宁可停住也不往回找。
  const now = performance.now()
  const top = el.getBoundingClientRect().top
  const tail = chars[chars.length - 1].parentElement
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]
    if (c.parentElement !== tail) break
    if (Number(c.dataset.revealAt ?? 0) > now) continue
    return el.scrollTop + (visibleBottom(c, el) - top)
  }
  // 尾流整波都还没起跑：当前视口底就是看得见的底，原地不动。
  return el.scrollTop + el.clientHeight
}

function stickToVisualBottom(el: HTMLElement): number {
  const target = visualBottom(el) - el.clientHeight
  // 观测点：跟随循环认为该滚到哪、实际滚到了哪。冒烟测试据此分辨
  // 「算错了」和「滚对了又被推回来」—— 两种病的修法完全不同。
  el.dataset.followTarget = String(Math.round(target))
  el.dataset.followHeight = String(Math.round(el.scrollHeight))
  el.scrollTop = target
  el.dataset.followApplied = String(Math.round(el.scrollTop))
  return el.scrollTop
}

export interface FollowHandlers {
  onScroll: () => void
  onWheel: () => void
  onTouchMove: () => void
  onPointerDown: () => void
  onKeyDown: () => void
}

export interface FollowHandle {
  /** 内容变了再叫一次。万一循环停了，下一个 token 到达时重新起跑 */
  rearm: () => void
  /** 强制接回控制权并跟一次（发出新消息时调） */
  pin: () => void
  /** 挂到滚动容器上 */
  handlers: FollowHandlers
}

/**
 * 让一个滚动容器自动跟着「看得见的底」走，用户往上翻就交出控制权，翻回底部再接回来。
 *
 * 外层消息区和思考块的内嵌滚动口用的是同一套规则 —— 后者尤其不能各写一份：
 * 内嵌口如果不跟，新字就流到 320px 窗口外面去，外层量到的「显现前沿」是个被裁掉的
 * 幻影位置，跟着它滚不是把盒子切一半，就是跑到字前面去。让它自己跟到底边，
 * 「字的底」和「盒子的底」才重合，两种口径自然一致。
 *
 * `active` 为 false 时彻底不接管滚动。历史消息里的思考块是静态的，一挂载就把它
 * 拽到末尾会让人看不见开头；只有流式中才需要跟。
 */
export function useFollowToVisualBottom(
  ref: React.RefObject<HTMLElement | null>,
  active = true
): FollowHandle {
  /** 用户有没有往上翻；翻了就不再强行拽回底部 */
  const pinned = useRef(true)
  /**
   * 这一帧的滚动是不是用户发起的。
   *
   * 只有用户手势才配改 pinned。自己设的 scrollTop、以及浏览器因上方排版高度变化
   * 做的滚动锚定，都会派发 scroll 事件 —— 把这些也算成「用户翻上去了」，一次
   * Markdown 段落毕业的高度差就会把自动跟随永久关死，页面从此追不回来
   * （实测能落后上千像素）。
   */
  const userIntent = useRef(false)
  /**
   * 我们上一次把页面滚到哪。scroll 事件是异步派发的，会晚一帧才到 ——
   * 光靠「用户意图」标记分不清「自己滚完触发的 scroll」和「用户滚的」。
   * 拿实际落点一对就知道了。
   */
  const ourTop = useRef<number | null>(null)
  /** 上一次看到的 scrollTop，用来判断用户是往上翻（交出控制权）还是往下翻 */
  const prevTop = useRef(0)
  /** 重新起跑跟随循环。用户把页面拽回底部、或发出新消息时调 */
  const arm = useRef<() => void>(() => {})
  /** 回调是 [] 依赖的，拿到的 active 是首帧的；开销极小，读实况 */
  const activeNow = useRef(active)
  activeNow.current = active

  useEffect(() => {
    const el = ref.current
    if (!el || !active) return

    let raf = 0
    const tick = (): void => {
      if (!pinned.current || !activeNow.current) return
      // 这次滚动由我们发起 —— 先收走用户意图，别让它派发的 scroll 事件
      // 反过来把跟随关掉
      userIntent.current = false
      const applied = stickToVisualBottom(el)
      ourTop.current = applied
      prevTop.current = applied
      // 还有字在对焦路上（屏上还有 .char-in）就继续跟；都落地了收工
      if (el.querySelector('.char-in')) raf = requestAnimationFrame(tick)
      else ourTop.current = null
    }
    const kick = (): void => {
      if (!activeNow.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    }
    arm.current = kick
    kick()
    return () => {
      cancelAnimationFrame(raf)
      // 失效的 kick 会拽着旧 el 的 tick 一直跑下去，必须摘掉
      arm.current = noop
    }
  }, [ref, active])

  const markUserIntent = useCallback((): void => {
    userIntent.current = true
  }, [])

  const onScroll = useCallback((): void => {
    const el = ref.current
    if (!el || !userIntent.current) return
    userIntent.current = false
    // 是我们自己滚的 —— scroll 事件晚一帧才到，别把它算成用户翻上去了
    if (ourTop.current != null && Math.abs(el.scrollTop - ourTop.current) < 2) {
      ourTop.current = null
      return
    }
    ourTop.current = null

    const top = el.scrollTop
    // 往上翻就立刻交出控制权，不看距离。否则慢速滚轮每格只有几像素，会一路
    // 被判成「还待在底部」，跟随循环把人死死按住，怎么滚都滚不上去。
    if (top < prevTop.current - 1) {
      prevTop.current = top
      pinned.current = false
      return
    }
    prevTop.current = top
    // 往下翻：回到看得见的底一行之内就恢复跟随。
    // 同样按「看得见的底」判定 —— 排版底比它高一截时，用 scrollHeight 量
    // 会得出「已经不在底部」的结论，自动跟随就永久停摆了
    pinned.current = visualBottom(el) - top - el.clientHeight <= 24
    if (pinned.current) arm.current()
  }, [ref])

  const rearm = useCallback((): void => {
    if (pinned.current) arm.current()
  }, [])

  const pin = useCallback((): void => {
    pinned.current = true
    arm.current()
  }, [])

  // 引用必须稳定：调用方会把它当依赖项（内容变化的保险丝），变了就等于每帧触发
  const handlers = useMemo<FollowHandlers>(
    () => ({
      onScroll,
      onWheel: markUserIntent,
      onTouchMove: markUserIntent,
      onPointerDown: markUserIntent,
      onKeyDown: markUserIntent
    }),
    [onScroll, markUserIntent]
  )

  return useMemo<FollowHandle>(() => ({ rearm, pin, handlers }), [rearm, pin, handlers])
}
