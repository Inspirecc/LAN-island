---
title: 多线程的三种典型应用场景
date: 2026-02-12
description: 多线程不是为了「看起来快」,它只在三类问题上真正有价值:抢资源的、跑管道的、别挡路的。这篇用秒杀库存、离线数据管道、异步日志三个场景,把线程安全、生产者-消费者、上下文传递三条主线一次讲清。
tags: [Java, 并发编程, 线程池, 高并发]
category: 并发编程
---

「多线程用在哪」这个问题很容易被答成一张技术清单——线程池、锁、并发容器挨个报一遍。但多线程不是一种可以到处套用的优化手段,它只解决三类结构性问题:

1. **抢资源**:多个请求竞争同一份有限资源,需要保证判定和扣减不出错;
2. **跑管道**:数据要从 A 搬到 B,生产速度和消费速度不匹配,需要缓冲和解耦;
3. **别挡路**:主链路上有耗时但不影响结果的副操作,需要挪出去异步做。

三种场景的难点完全不同,对应的解法也不同。下面逐个拆开。

## 一、秒杀库存扣减:难点在「判定依据会过期」

场景特征:瞬时并发极高,所有请求抢同一份库存,任何一次错误的判定都可能导致超卖。

早期的写法往往是直接锁住整个扣减方法:

```java
// ❌ 方法级悲观锁,压测时 QPS 直接腰斩
public synchronized boolean deduct(Long skuId, int qty) {
    Stock stock = stockMapper.selectById(skuId);
    if (stock.getAvailable() < qty) {
        return false;
    }
    stock.setAvailable(stock.getAvailable() - qty);
    stockMapper.updateById(stock);
    return true;
}
```

锁的粒度太粗——**读库存这种完全无冲突的操作也被迫排队**,而库存查询在秒杀链路上占了绝大多数请求。压测时 QPS 直接腰斩,CPU 却几乎没跑满,典型的"锁在等人不在干活"。

第一轮优化:拆锁粒度。

```java
private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();

public boolean deduct(Long skuId, int qty) {
    // 读库存:共享锁,大量请求可并发
    rwLock.readLock().lock();
    try {
        Stock stock = stockMapper.selectById(skuId);
        if (stock.getAvailable() < qty) {
            return false;                       // 快速失败,不必升级锁
        }
    } finally {
        rwLock.readLock().unlock();
    }

    // 真正扣减:排他锁,只有一小部分请求走到这里
    rwLock.writeLock().lock();
    try {
        return doDeduct(skuId, qty);
    } finally {
        rwLock.writeLock().unlock();
    }
}
```

这里有个容易出错的地方:**读写锁不支持锁升级**。持有读锁时再去拿写锁会死锁,所以上面的写法是"读完先放锁,再重新拿写锁",中间那个缝需要用后续的 CAS 或条件更新兜住。

第二轮优化:往无锁化方向走,把压力分层卸掉。

| 层 | 组件 | 承担什么 | 失败语义 |
|---|---|---|---|
| 本地限流 | `AtomicInteger` 令牌桶 | 单机预扣,把大部分流量挡在本地 | 令牌耗尽 → 立即拒绝 |
| 分布式预扣 | Redis `DECR` / 信号量 | 全局库存原子预扣 | 不足 → 立即售罄 |
| 最终账本 | DB 条件更新或乐观锁 | 权威库存,兜底 | 影响 0 行 → 回滚预扣 |

本地令牌桶的写法:

```java
// 单机令牌桶:在请求到达 Redis 之前先削掉一层
private final AtomicInteger localToken = new AtomicInteger(0);

/** 定时任务或在库存加载时重置令牌数 */
public void refillLocalToken(int permits) {
    localToken.set(permits);
}

public boolean tryAcquireLocal() {
    int cur;
    do {
        cur = localToken.get();
        if (cur <= 0) {
            return false;                    // 本地就没令牌了,直接拒绝
        }
    } while (!localToken.compareAndSet(cur, cur - 1));
    return true;
}
```

这三层各有分工:**本地令牌桶挡掉重复请求和部分超发流量,Redis 做全局裁决,数据库作为最终账本**。这一轮改造把接口 TP99 从 800ms 降到了 120ms。

为什么这样分层有效?因为每一层过滤的比例是乘起来的。假设本地挡掉 60%,Redis 挡掉剩余里的绝大部分,最终打到数据库的请求只有个位数百分比——**数据库只需要处理"真正要扣"的那一点点流量**。

这里也解释了一个常见误区:**乐观锁(version 字段)并不适合热点库存**。热点 SKU 上冲突率极高,几乎每个更新都会失败然后重读重试,形成重试风暴。库存场景更适合"条件更新版"——一次判断定生死:

```sql
UPDATE stock SET available = available - #{qty}
WHERE sku_id = #{skuId} AND available >= #{qty};
-- 影响 0 行 = 库存不足,直接返回,不重试
```

关键在于**失败语义是「资源不足」而不是「冲突」,所以不该重试**。

### 这个场景的三个坑

| 坑 | 表现 | 应对 |
|---|---|---|
| 锁粒度太粗 | QPS 腰斩但 CPU 空闲 | 读写分离锁 / 无锁化 |
| 乐观锁重试风暴 | 热点 SKU 上 DB 被打满 | 换条件更新,失败不重试 |
| 忘记回补幂等 | 取消订单重复回补 → 库存超过总量 | 按订单号去重回补 |

## 二、离线数据同步管道:难点在「速度不匹配」

场景特征:从消息队列拉取海量日志写入存储,生产速度和消费速度天然不匹配,需要缓冲、需要背压。

经典结构是生产者-消费者:

```java
public class SyncPipeline {

    // 有界队列,是背压的物理载体
    private final BlockingQueue<Task> queue = new ArrayBlockingQueue<>(1000);

    // 生产者:单线程批量拉取,组装任务
    private final ExecutorService producer = Executors.newSingleThreadExecutor(
            r -> new Thread(r, "sync-producer"));

    // 消费者:IO 密集型,核数 * 2 起步
    private final ExecutorService consumer = new ThreadPoolExecutor(
            Runtime.getRuntime().availableProcessors() * 2,
            Runtime.getRuntime().availableProcessors() * 2,
            0L, TimeUnit.MILLISECONDS,
            new LinkedBlockingQueue<>(2000),
            r -> new Thread(r, "sync-consumer"),
            new BlockingRejectHandler());     // 背压,而非丢弃

    public void start() {
        producer.submit(this::pullLoop);
        for (int i = 0; i < consumerCount; i++) {
            consumer.submit(this::consumeLoop);
        }
    }

    private void pullLoop() {
        while (running) {
            List<Message> batch = kafka.poll(Duration.ofMillis(500));
            if (batch.isEmpty()) continue;
            Task task = Task.of(batch);          // 拆包 + 压缩在消费者里做
            try {
                queue.put(task);                 // 队列满则阻塞 -> 背压
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void consumeLoop() {
        while (running) {
            try {
                Task task = queue.take();
                task.unpack().compress().flush();   // 拆包、压缩、批量刷盘
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                log.error("任务处理失败,转入重试", e);   // 不能让消费者线程死掉
            }
        }
    }
}
```

核心线程数用 `CPU 核数 * 2` 起步——因为任务是 IO 密集的(压缩 + 刷盘),线程大部分时间在等 IO。但**这只是起点**,最终值要靠压测确定(见下一节)。

这个结构里有三处设计值得说明:

**一、队列必须有界。** 无界队列在下游故障时会无限膨胀,把堆撑爆。有界队列 + 阻塞入队,把"积压"这个信号转化为"生产者被拖慢",压力自然向上传导。

**二、拒绝策略要让生产者阻塞。** 当队列积压超过阈值时,不是抛异常也不是丢任务,而是让生产者等一等:

```java
public class BlockingRejectHandler implements RejectedExecutionHandler {
    @Override
    public void rejectedExecution(Runnable r, ThreadPoolExecutor executor) {
        if (executor.isShutdown()) {
            throw new RejectedExecutionException("线程池已关闭");
        }
        try {
            executor.getQueue().put(r);      // 阻塞,形成天然背压
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RejectedExecutionException(e);
        }
    }
}
```

**三、配合 `Future` 超时。** 除了队列溢出的保护,还要防单个任务卡死:

```java
Future<?> f = consumer.submit(task);
try {
    f.get(30, TimeUnit.SECONDS);
} catch (TimeoutException e) {
    f.cancel(true);
    metrics.counter("sync.timeout").increment();
}
```

### 参数怎么来的:压测而不是拍脑袋

这套管道的线程数不是"设 8 个吧"定下来的。推导过程是:

**第一步,公式定基线。** 假设 8 核、阻塞系数估 0.8:`8 / (1 - 0.8) = 40`,得到起点 40。

**第二步,阶梯压测找拐点。** 从 QPS 100 逐步加到 1000,同时看三个指标:

| 指标 | 采集 | 判读 |
|---|---|---|
| CPU 负载 | `top` / `vmstat` | < 70% 可继续加;> 80% 且吞吐不涨 → 拐点 |
| 上下文切换 | `vmstat 1` 的 `cs` 列 | 每秒几十万次 → 争用激烈,要减线程 |
| GC 频率 | GC 日志 | Young GC 频繁 → 队列任务对象挤占内存 |

实测下来,**8 核机器上核心线程 32 时吞吐最高,调到 36 时 CPU 飙到 90% 但 TPS 反而下降**,所以定在 32。注意它比公式给的 40 低了 20%——**公式指方向,压测定终值**。

**第三步,配置中心热更新。** 业务增长后 32 可能过时,把参数放到配置中心,配合 `setCorePoolSize()` 运行中平滑生效,队列积压持续超阈值时直接调,不用重启。

### 这个场景的三个坑

| 坑 | 后果 | 应对 |
|---|---|---|
| 无界队列 | 下游故障时积压 200 万任务 → 堆爆 → Full GC 停顿 | 强制有界队列 + 压测定容量 |
| 线程数超配 | CPU 100% 但吞吐下降 | `jstack` 看堆栈 + `vmstat` 看 `cs`,回调线程数 |
| 消费者异常未捕获 | 消费线程意外退出,管道静默停摆 | 循环体内 `catch Exception`,不能让它逃出去 |

第二条值得展开:线程数开太大时,大量 CPU 时间花在了**线程调度和上下文切换**上,而不是干活上。判断依据就是 `vmstat` 的 `cs` 列——切换次数暴涨而吞吐不涨,说明线程开多了。

## 三、异步日志与监控:难点在「上下文会丢」

场景特征:链路追踪、埋点上报、日志刷盘这类操作耗时但不影响主流程结果,挪到异步线程去做。

```java
// 自定义调度器,避免同步打日志阻塞主链路
private final ScheduledExecutorService flusher =
        new ScheduledThreadPoolExecutor(2,
                r -> new Thread(r, "log-flusher"));

public void record(String traceId, String message) {
    traceIdHolder.set(traceId);              // 上下文先放进去
    buffer.add(new LogEntry(traceId, message));
}

@PostConstruct
public void startFlush() {
    flusher.scheduleWithFixedDelay(() -> {
        List<LogEntry> batch = buffer.drain();
        if (!batch.isEmpty()) {
            logStorage.batchWrite(batch);    // 定时批量刷盘
        }
    }, 1, 1, TimeUnit.SECONDS);
}
```

结构本身不复杂,坑全在**上下文传递**上。

### 坑一:ThreadLocal 内存泄漏

如果链路追踪的 `TraceId` 存在 `ThreadLocal` 里,而执行任务的是**线程池中的复用线程**,那么:

- 请求 A 把 `TraceId=A` 放进 `ThreadLocal`;
- 请求处理完毕,线程归还池中,但 `ThreadLocal` 里的值**没被清理**;
- 请求 B 复用同一个线程,读到的是 `TraceId=A`。

结果就是**日志串户**——B 的日志被打上了 A 的追踪 ID,排查问题时完全对不上。更糟的是,线程池线程长期存活,那个残留的 `Entry` 也长期存活,形成内存泄漏。

解决方式是在 `finally` 里强制清理:

```java
public void handle(Request req) {
    traceIdHolder.set(req.getTraceId());
    try {
        doHandle(req);
    } finally {
        traceIdHolder.remove();     // 必须 remove,不能只 set(null)
    }
}
```

注意是 `remove()` 而不是 `set(null)`——`set(null)` 只是把值置空,`ThreadLocalMap` 里的 `Entry` 仍然占着位置。原因和 `ThreadLocalMap` 的弱引用设计有关:**key 是弱引用,value 是强引用**,只置空 value 并不能让 `Entry` 被回收。

### 坑二:跨线程拿不到上下文

`ThreadLocal` 的值只在**当前线程**可见。把任务提交到线程池,子线程读到的是 `null`:

```java
traceIdHolder.set("trace-001");
executor.submit(() -> {
    log.info("traceId = {}", traceIdHolder.get());   // null!
});
```

一种处理方式是换成 `InheritableThreadLocal`,它在创建子线程时会把父线程的值复制过去:

```java
private static final InheritableThreadLocal<String> traceIdHolder =
        new InheritableThreadLocal<>();
```

但**线程池会让它失效**:池里的线程是提前创建好的,创建时机远早于任务提交,复制发生的那一刻父线程上还没有 `TraceId`。所以:

| 方案 | 原理 | 在线程池下 |
|---|---|---|
| `ThreadLocal` | 仅当前线程可见 | 子线程读不到 |
| `InheritableThreadLocal` | 创建子线程时复制父线程的值 | ❌ 线程复用导致复制时机错位 |
| 显式传参 | 把上下文作为任务对象的字段 | ✅ 最可靠 |
| 任务装饰器 | 提交时快照、执行时恢复、结束时清理 | ✅ 通用做法 |

推荐的任务装饰器写法:

```java
public class TraceTask implements Runnable {
    private final String traceId;        // 提交时快照
    private final Runnable delegate;

    public TraceTask(Runnable delegate) {
        this.traceId = traceIdHolder.get();   // 在提交线程上取值
        this.delegate = delegate;
    }

    @Override
    public void run() {
        traceIdHolder.set(traceId);           // 执行线程上恢复
        try {
            delegate.run();
        } finally {
            traceIdHolder.remove();           // 无论成败都清理
        }
    }
}
```

核心思路是**把"隐式传递"改成"显式快照 + 恢复 + 清理"**:提交时在父线程取值,执行时在子线程恢复,结束时无论如何都清理掉。

### 坑三:用 Condition 精确控制状态

定时刷盘常见的需求是"缓冲池满则立刻刷,空则继续等"。用 `wait/notify` 实现容易出错(必须配合 `synchronized`、有虚假唤醒问题),`ReentrantLock` + `Condition` 的语义更清晰:

```java
private final ReentrantLock lock = new ReentrantLock();
private final Condition notFull  = lock.newCondition();
private final Condition notEmpty = lock.newCondition();

public void add(LogEntry entry) throws InterruptedException {
    lock.lock();
    try {
        while (buffer.size() >= capacity) {
            notFull.await();              // 满了就等
        }
        buffer.add(entry);
        notEmpty.signal();                // 通知消费者
    } finally {
        lock.unlock();
    }
}

public List<LogEntry> drainIfNeeded() throws InterruptedException {
    lock.lock();
    try {
        while (buffer.isEmpty()) {
            notEmpty.await();             // 空了就等
        }
        List<LogEntry> batch = new ArrayList<>(buffer);
        buffer.clear();
        notFull.signalAll();
        return batch;
    } finally {
        lock.unlock();
    }
}
```

用 `while` 而不是 `if` 判断条件,是为了应对**虚假唤醒**——线程被唤醒不代表条件一定成立,必须重新检查。

## 四、三种场景的对照

| 维度 | 抢资源(库存) | 跑管道(数据同步) | 别挡路(异步日志) |
|---|---|---|---|
| 核心问题 | 判定依据会过期 | 生产消费速度不匹配 | 上下文跨线程丢失 |
| 主要手段 | 细粒度锁 → 无锁化 → 分层削峰 | 有界队列 + 背压 + 线程池 | 任务装饰器 + `finally` 清理 |
| 关键指标 | QPS、TP99、超卖数 | 吞吐、队列水位、`cs` | 链路完整性、内存占用 |
| 典型坑 | 乐观锁重试风暴 | 无界队列撑爆堆 | `ThreadLocal` 未 `remove` |
| 失败语义 | 资源不足(不重试) | 背压(变慢但不丢) | 降级(丢日志不丢业务) |

三种场景共享几条通用原则:

1. **优先用并发容器,实在不够才用显式锁**——`ConcurrentHashMap`、`CopyOnWriteArrayList`、`BlockingQueue` 已经把大量场景封装好了;
2. **用锁必须配套 `try-finally`**,释放动作不能依赖正常流程执行到;
3. **线程池一律显式创建**,不用 `Executors` 的快捷方法;
4. **队列必须有界**,拒绝策略优先选能形成背压的;
5. **`ThreadLocal` 用完必须 `remove()`**,而且要在 `finally` 里。

最后一条关于本质:**多线程是"用安全性换性能"的交易**。它换来的性能有上限,但引入的复杂度是实打实的。所以判断要不要用的标准,不是"能不能并行",而是"这条链路是不是真的卡在上面三类问题上"。

## 小结

- 多线程真正有价值的只有三类场景:**抢资源、跑管道、别挡路**
- 库存扣减的难点是**判定依据会过期**:细粒度读写锁解冲突,`AtomicInteger` 本地令牌桶 + Redis 原子预扣 + DB 条件更新做分层削峰,TP99 从 800ms 降到 120ms
- 热点库存**不用乐观锁**:冲突率高会形成重试风暴,条件更新"一次判断定生死"更合适,且失败语义是「资源不足」不该重试
- 离线采集管道用**生产者-消费者 + 有界队列**:队列满时让生产者阻塞形成背压,而不是抛异常或丢任务
- 线程数不是拍出来的:**公式定基线(40)→ 压测找拐点(实测 32)→ 配置中心热更新**;8 核上 36 反而比 32 差
- **无界队列是隐形炸弹**:一度积压 200 万任务把堆撑爆,触发 Full GC 停顿
- 异步链路最隐蔽的坑是**上下文丢失**:`ThreadLocal` 不 `remove` 会串户并泄漏,`InheritableThreadLocal` 在线程池下因复用而失效,应改用任务装饰器做"快照 → 恢复 → 清理"
- 记住:多线程是**用安全性换性能**的交易,不该为了并行而并行
