---
title: 线程池参数到底怎么定:从公式到压测
date: 2026-02-09
description: 核心线程数 8 还是 32?网上流传的「CPU 核数 × 2」既不是答案也不是起点。这篇给出一套四步推导法:公式定基线、压测找拐点、队列划阈值、配置中心热更新,并附上无界队列撑爆堆内存的真实教训。
tags: [Java, 线程池, 并发编程, 性能调优]
category: 并发编程
---

线程池参数是那种"怎么填都能跑,跑起来差别巨大"的配置。网上流传最广的说法是「CPU 密集型设 N+1,IO 密集型设 2N」,但真按这个填,8 核机器上跑 IO 密集任务很可能会把一个本来能到 32 并发的服务锁死在 16。

参数不是"算"出来的,是**压测出来的**。公式的作用只有一个:排除方向性错误,给你一个合理的起点。

## 一、先看清参数之间的耦合关系

`ThreadPoolExecutor` 的行为不是由某个参数单独决定的,而是下面这套判定逻辑:

```java
if (运行线程数 < corePoolSize) {
    新建线程执行;                     // 即使有空闲线程也新建
} else if (队列未满) {
    任务入队;                         // 注意:不是新建线程
} else if (运行线程数 < maximumPoolSize) {
    新建线程执行;
} else {
    交给拒绝策略;
}
```

这里有两个反直觉的点,是理解后续所有调参的前提:

1. **线程不是"忙不过来"就涨的**。只要运行线程数没到 `corePoolSize`,每个新任务都会直接开线程,哪怕刚有线程闲下来。
2. **`maximumPoolSize` 只有在队列满了之后才有意义**。如果队列是无界的,`maximumPoolSize` **永远不会被触发**——这是后面那个血泪教训的根源。

| 参数 | 决定什么 | 常见误区 |
|---|---|---|
| `corePoolSize` | 常驻线程数,低于它来任务就新建线程 | 以为"平时只用这么多个",实际是"至少要维持这么多" |
| `maximumPoolSize` | 峰值线程数上限 | 以为设大了就会涨到那儿,其实要队列满了才涨 |
| `workQueue` | 任务的缓冲区 | 用无界队列 → `maximumPoolSize` 形同虚设 + 有 OOM 风险 |
| `keepAliveTime` | 超出核心数的线程空闲多久回收 | 队核心线程默认无效,除非开 `allowCoreThreadTimeOut` |
| `RejectedExecutionHandler` | 满了之后怎么办 | 默认 `AbortPolicy` 直接抛异常,业务上往往不合适 |

## 二、四步推导法

### 第一步:用公式定基线

不要在 8 还是 32 之间凭感觉选,先用公式算一个起点。

**CPU 密集型**(加解密、序列化、复杂计算):

```
线程数 ≈ CPU 核数 + 1
```

多出来的 1 是为了在某个线程偶尔因缺页中断等原因暂停时,CPU 不至于空转。

**IO 密集型**(读写文件、调远程接口、访问数据库):

```
线程数 = CPU 核数 / (1 - 阻塞系数)
```

`阻塞系数`指线程在等待 IO 的时间占比。以 8 核、阻塞系数 0.8 为例:

```
8 / (1 - 0.8) = 8 / 0.2 = 40
```

得到基线 **40 个核心线程**。

阻塞系数怎么估?最朴素的办法是看单次任务的耗时构成:

| 任务总耗时 | 纯 CPU 时间 | 阻塞系数 | 8 核推导值 |
|---|---|---|---|
| 100ms | 20ms | 0.8 | 40 |
| 100ms | 50ms | 0.5 | 16 |
| 100ms | 80ms | 0.2 | 10 |
| 100ms | 100ms | 0 | 8 |

阻塞系数越接近 1,公式给出的线程数越趋向无穷——这恰恰说明**它只是个上界参考,不是答案**。后面压测会把 40 拉回到真实的 32。

### 第二步:压测找拐点

基线只是纸上谈兵,真正的值要靠阶梯式加压测出来。做法是把 QPS 从 100 逐步加到 1000,同时盯住三个指标:

| 监控指标 | 采集方式 | 判读标准 |
|---|---|---|
| **CPU 负载** | `top` / `vmstat` | 低于 70% 说明线程没跑满,可以继续加;超过 80% 且吞吐不再上升 → **到拐点了** |
| **上下文切换** | `vmstat 1` 的 `cs` 列 | 每秒超过几十万次,说明线程争用激烈,CPU 时间被调度吃掉,该**降线程数** |
| **GC 频率** | GC 日志 / `jstat -gcutil` | Young GC 变频繁,说明队列里堆积的任务对象太多,在挤占内存 |

这套方法的关键在于**同时看三个指标**:只看 CPU 会误判(线程多了 CPU 也高,但吞吐是降的),只看 TPS 会看不出代价在哪。

实测结果是:

```
8 核机器,核心线程 32 → 吞吐量最高,TPS 峰值
8 核机器,核心线程 36 → CPU 飙到 90%,TPS 反而下降
```

所以最终定在 **32**。注意这个值和公式给的 40 差了 20%——公式把方向指对了(量级是几十而不是几个),但**精确值只能来自压测**。

用 `jstack` 抓线程堆栈可以佐证这个结论:线程数超配时,大量线程处于 `BLOCKED` 或频繁的 `RUNNABLE` 切换中,真正在执行业务逻辑的比例反而下降。

### 第三步:用有界队列划阈值

核心定 32 之后,为什么最大还要给到 80?因为它俩之间隔着一个**队列缓冲水位**:

```
core = 32  +  有界队列(容量 1000)
             ↓
     队列积压超过阈值(比如 500,即一半)
             ↓
     maximum = 80 才被允许创建,应对突发流量
```

这样的分工很清晰:

| 状态 | 行为 | 目的 |
|---|---|---|
| 常态 | 只用 32 个线程常驻 | 省内存,减少上下文切换 |
| 突发 | 队列开始积压,涨到最多 80 个 | 临时扩容,把突发吃下来 |
| 恢复 | 超出核心的线程空闲 `keepAliveTime=5s` 后回收 | 自动缩容,不浪费资源 |

队列容量定成多少,原则是「**能撑住一次可预期的突发,但撑不住一次下游雪崩**」。容量 1000 配合水位 500,意味着系统容许短暂的积压,但一旦持续积压就会开始涨线程,再持续就会触发拒绝策略——**每一次状态跃迁都是一个可以观测、可以告警的信号**。

### 第四步:参数热更新

参数定下来不等于一劳永逸。业务量翻倍之后,原来的 32 就成了瓶颈。把关键参数放到配置中心,配合 `ThreadPoolExecutor` 的 `setCorePoolSize()` 就能在运行中平滑扩容:

```java
@ConfigurationProperties(prefix = "thread.pool.order")
@Component
public class DynamicThreadPool {

    private int coreSize = 32;
    private int maxSize  = 80;

    private ThreadPoolExecutor executor;

    @PostConstruct
    public void init() {
        executor = new ThreadPoolExecutor(
                coreSize, maxSize,
                5, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(1024),          // 必须有界
                new ThreadFactoryBuilder().setNameFormat("order-pool-%d").build(),
                new BlockingRejectHandler()               // 自定义拒绝策略,见下节
        );
    }

    /** 配置中心推送变更时调用,运行中平滑生效 */
    public void refresh(int newCore, int newMax) {
        // 扩核心:立即生效;缩核心:等现有线程空闲后逐步回收
        executor.setCorePoolSize(newCore);
        executor.setMaximumPoolSize(newMax);
        this.coreSize = newCore;
        this.maxSize  = newMax;
    }
}
```

当监控面板显示队列积压持续大于 800 时,运维直接改配置即可,**无需重启**。

一个细节:`setCorePoolSize()` 扩容是立即生效的,缩容则是等线程空闲后由内部逻辑逐步回收,所以调大调小的体感不一样。

## 三、队列的血泪教训:无界队列会撑爆堆

来看一个很多人踩过的坑。最初为了"绝对不丢任务",队列用了不传参数的 `LinkedBlockingQueue`:

```java
// ❌ 不传容量 = 无界队列(Integer.MAX_VALUE)
new ThreadPoolExecutor(32, 80, 5, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>());
```

看起来安全,实际上埋了两颗雷。

**第一颗雷:`maximumPoolSize` 彻底失效。** 无界队列永远不会满,所以判定逻辑永远停在"任务入队"这一步,`maximumPoolSize = 80` 一次都不会被触发,配置形同虚设。

**第二颗雷:下游故障时队列无限膨胀。** 有一次下游存储故障,任务消费不掉,队列疯狂积压了 **200 多万个任务**,直接把堆内存撑爆,触发 Full GC 停顿。

改成有界队列 + 自定义拒绝策略:

```java
public class BlockingRejectHandler implements RejectedExecutionHandler {

    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        if (executor.isShutdown()) {
            throw new RejectedExecutionException("线程池已关闭");
        }
        try {
            // 关键:让提交任务的线程(生产者)自己执行
            // 生产者被拖慢 -> 上游自然减速 -> 形成背压
            executor.getQueue().put(r);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RejectedExecutionException("入队被中断", e);
        }
    }
}
```

这段代码的核心思想是 **`CallerRunsPolicy` 的阻塞版**:

> 队列满时不抛异常、不丢任务,而是**让生产者自己慢下来**。

因为生产者和消费者共用同一个线程池的话,生产者执行任务时就没法继续往队列里塞——形成天然背压,系统不会崩,只是变慢。对比几种拒绝策略:

| 拒绝策略 | 行为 | 适用场景 |
|---|---|---|
| `AbortPolicy`(默认) | 抛 `RejectedExecutionException` | 能接受快速失败、上游有重试 |
| `CallerRunsPolicy` | 提交线程自己执行 | 希望形成背压,但不阻塞入队 |
| `DiscardPolicy` | 静默丢弃 | **几乎不该用**,任务无声消失 |
| `DiscardOldestPolicy` | 丢最老的再试 | 只关心最新数据的场景(如行情推送) |
| 自定义 put 阻塞 | 阻塞生产者直到有空位 | 数据不能丢、又能接受变慢 |

## 四、参数之外:三个同样重要的配套项

参数调对了,线程池也只是"能用"。要"好用",还得配三样东西。

**一、线程命名。** 用 `ThreadFactory` 给线程起名字:

```java
new ThreadFactoryBuilder().setNameFormat("order-pool-%d").build()
```

否则线上出问题时,jstack 里全是 `pool-1-thread-7`,根本认不出是哪个业务。

**二、显式创建,不用 `Executors`。** `Executors` 提供的快捷方法都有坑:

| 工厂方法 | 底层实现 | 问题 |
|---|---|---|
| `newFixedThreadPool` | 无界 `LinkedBlockingQueue` | 队列无限涨 → OOM |
| `newSingleThreadExecutor` | 无界队列 | 同上 |
| `newCachedThreadPool` | `maximumPoolSize = Integer.MAX_VALUE` | 线程数无限涨 → OOM |
| `newScheduledThreadPool` | 无界 `DelayedWorkQueue` | 队列无限涨 → OOM |

结论很干脆:**用 `ThreadPoolExecutor` 的构造函数显式指定每一个参数**,别图省事。

**三、`Future` 超时。** 只有队列满了才有拒绝,队列没满但任务很慢的情况,得靠超时兜底:

```java
Future<Result> future = executor.submit(task);
try {
    Result r = future.get(3, TimeUnit.SECONDS);   // 必须有超时
} catch (TimeoutException e) {
    future.cancel(true);                          // 中断任务
    throw new BizException("处理超时");
}
```

没有超时的 `future.get()` 会在任务卡死时把调用线程一起拖死,而这类问题在压测时往往复现不出来。

## 五、一张表看清参数怎么联动

把上面的推导收拢成一张对照表:

| 步骤 | 依据 | 产出 | 谁来验证 |
|---|---|---|---|
| 定基线 | 任务类型 + 阻塞系数公式 | `corePoolSize` 起点(如 40) | 压测推翻,终值 32 |
| 找拐点 | CPU 负载 + 上下文切换 + GC | `corePoolSize` 终值 | 阶梯压测 + `jstack` 佐证 |
| 划阈值 | 可承受的突发量 | 队列容量 + 积压水位 | 故障演练(如手动停下游) |
| 定上限 | 水位之上的临时扩容空间 | `maximumPoolSize` + `keepAliveTime` | 突发流量回放 |
| 兜底 | 数据不能丢且能接受变慢 | 自定义拒绝策略(背压) | 长稳测试 |
| 动态化 | 业务增长的不确定性 | 配置中心 + `setCorePoolSize` | 灰度观察队列水位 |

## 小结

- 线程池的判定顺序是 **核心线程 → 队列 → 最大线程 → 拒绝策略**,`maximumPoolSize` 只在队列满后才起作用
- 参数推导走四步:**公式定基线、压测找拐点、队列划阈值、配置中心热更新**
- IO 密集型可用 `核数 / (1 - 阻塞系数)` 估基线,但阻塞系数越接近 1 结果越发散,**它只是起点不是答案**
- 压测必须**同时看三个指标**:CPU 负载、上下文切换(`vmstat` 的 `cs`)、GC 频率;8 核上 32 最优、36 反而更差是典型表现
- **无界队列是双重陷阱**:让 `maximumPoolSize` 失效,并在下游故障时把堆撑爆(200 万积压任务 → Full GC 停顿)
- 队列必须有界,拒绝策略优先选**能形成背压**的方案,让生产者慢下来而不是把任务丢掉
- 别用 `Executors` 的快捷方法,显式 `new ThreadPoolExecutor`;线程命名和 `Future` 超时是同样必要的配套项
- 一句话:**参数不是定义出来的,是压测 + 监控打磨出来的**
