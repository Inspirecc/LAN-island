---
title: ThreadLocal 的原理与内存泄漏
date: 2026-02-23
description: ThreadLocal 的内存泄漏,根因在于 ThreadLocalMap 的 key 是弱引用而 value 是强引用。这篇从数据结构画到引用链,讲清泄漏怎么发生、为什么 set(null) 不管用,以及线程池下为什么还会串数据。
tags: [Java, 并发编程, ThreadLocal, 内存泄漏]
category: 并发编程
---

关于 `ThreadLocal`,流传最广的一句话是「用完记得 `remove`,不然会内存泄漏」。这句话本身没错,但它没解释**为什么会泄漏**。更常见的困惑是:`ThreadLocalMap` 的 key 明明用了弱引用,不就是为了防止泄漏吗?既然防住了,为什么还要 `remove`?

答案藏在引用链的方向里:**弱引用只保护了 key,没保护 value**。而这一个细节,决定了 `ThreadLocal` 的两大典型事故——内存泄漏和数据串户。

## 一、ThreadLocal 是什么

先明确它解决的问题。`ThreadLocal` 提供的是**线程隔离的变量**:同一个 `ThreadLocal` 对象,在不同线程里 `get()` 到的是各自独立的值。

```java
private static final ThreadLocal<String> TRACE_ID = new ThreadLocal<>();

// 线程 A
TRACE_ID.set("trace-A");
// 线程 B
TRACE_ID.set("trace-B");

// 各自读到各自的,互不干扰
```

它最典型的用途是**在一条调用链上隐式传递上下文**——链路追踪 ID、用户身份、事务连接、租户标识。这些数据从 Controller 到 Service 到 DAO 都要用,如果全靠方法参数传递,每一层的方法签名都得挂上这些"跟业务无关"的参数。`ThreadLocal` 把它们放在线程上,任何一层都能直接取。

**但"放在线程上"这个说法恰恰埋下了后面所有问题的伏笔:数据的生命周期,被绑定到了线程的生命周期上。**

## 二、数据结构:值到底存在哪

这是理解一切的关键,也是很多人搞错的地方:

> **数据不存在 `ThreadLocal` 里,而是存在 `Thread` 对象里的 `ThreadLocalMap` 中。`ThreadLocal` 只是这张表的 key。**

```
Thread 对象
├── threadLocals (ThreadLocalMap 类型, 字段声明在当前线程上)
│   └── Entry[] table
│       ├── Entry[0]  key = ThreadLocal@1a2b (弱引用)  →  value = "trace-A" (强引用)
│       ├── Entry[1]  key = ThreadLocal@3c4d (弱引用)  →  value = "trace-B"
│       └── ...
└── inheritableThreadLocals (另一张表, 给 InheritableThreadLocal 用)
```

对应到源码,`Thread` 类里有这样一个字段:

```java
public class Thread implements Runnable {
    // 由 ThreadLocal 类维护,存放本线程的所有 ThreadLocal 变量
    ThreadLocal.ThreadLocalMap threadLocals = null;
}
```

而 `ThreadLocalMap` 是一个为 `ThreadLocal` 定制的哈希表,**没有实现 `Map` 接口**,内部是数组 + 开放地址法(线性探测)解决冲突。

```java
static class ThreadLocalMap {
    static class Entry extends WeakReference<ThreadLocal<?>> {
        /** 值,注意:这里是强引用 */
        Object value;

        Entry(ThreadLocal<?> k, Object v) {
            super(k);          // key 交给 WeakReference 持有
            value = v;         // value 是自己的普通字段,强引用
        }
    }

    private Entry[] table;
}
```

看清 `Entry` 的定义,泄漏的根因就浮出水面了:

| 部分 | 引用类型 | 被谁持有 | 后果 |
|---|---|---|---|
| **key**(`ThreadLocal` 对象) | **弱引用** | `WeakReference` 内部 | GC 时可以被回收,不阻止 |
| **value**(业务数据) | **强引用** | `Entry.value` 字段 | **不会被回收**,除非 Entry 自己被清理 |

### 一张引用链图

正常持有状态下:

```
Thread (存活,比如线程池里的常驻线程)
  └── ThreadLocalMap
        └── Entry
              ├── weak → ThreadLocal 对象      ← 弱引用
              └── strong → value 对象          ← 强引用!
```

只要线程活着,`Thread` → `ThreadLocalMap` → `Entry` → `value` 这条**强引用链就是通的**。也就是说:**value 的存活与否,取决于线程活多久,而不是取决于 `ThreadLocal` 变量本身。**

## 三、内存泄漏是怎么发生的

现在来看完整的泄漏过程。

**第一步,使用。** 代码里有个 `ThreadLocal` 被 set 了值:

```java
private static final ThreadLocal<byte[]> CACHE = new ThreadLocal<>();

public void handle() {
    CACHE.set(new byte[1024 * 1024]);    // 1MB 数据
    // ...业务处理
    // 忘记 remove
}
```

此时引用关系:

```
CACHE(静态变量, 强引用) → ThreadLocal 对象 ← weak ← Entry ← ThreadLocalMap ← Thread
                                              ↑
                                         strong value = byte[1MB]
```

**第二步,`ThreadLocal` 引用断开。** 如果 `CACHE` 不是 `static final` 而是局部变量,或者被显式置空,那么"外部对 `ThreadLocal` 对象的强引用"就消失了:

```java
ThreadLocal<byte[]> cache = new ThreadLocal<>();
cache.set(new byte[1024 * 1024]);
// 方法结束,局部变量 cache 出栈 → 对 ThreadLocal 对象的强引用消失
```

**第三步,GC 回收 key。**

```
null ← weak ← Entry ← ThreadLocalMap ← Thread
              ↑
         strong value = byte[1MB]      ← 这个对象还活着!
```

`ThreadLocal` 对象被回收了,`Entry` 的 `key` 变成 `null`。但 `value` 是强引用,**依然被 `Entry` 牢牢持有着**。

**第四步,泄漏形成。** 这时 `Entry` 成了一个「key 为 null 但 value 还在」的僵尸节点:

- 通过 `ThreadLocal` 已经**永远访问不到**这个 value(没有 key,查不到);
- 但只要**线程还活着**,这条强引用链就不会断,value 就**永远无法被回收**。

在线程池场景下,线程是**长期存活**的——池里的核心线程可能几天不销毁。于是每个这样的僵尸 `Entry` 都变成一块永久的垃圾:1MB × N 次调用 = 持续的堆占用,直到 OOM。

```
❌ 泄漏链:Thread → ThreadLocalMap → Entry → value (强引用, 断不掉)
                     ↑
                key = null (已回收)
```

### 那弱引用到底在防什么

弱引用并不是没用,它防的是**另一种**泄漏:如果 key 是强引用,那么即使外部对 `ThreadLocal` 的引用都没了,`Entry` 还强引用着它,`ThreadLocal` 对象本身也会泄漏。弱引用至少让 key 能被回收。

但弱引用只解决了**一半**问题——**它回收了 key,留下了 value**。这就是为什么 `remove()` 不可省略。

## 四、ThreadLocalMap 的自我清理:能兜底但不彻底

`ThreadLocalMap` 并不是完全躺平,它在 `get()`、`set()`、`remove()` 时会做**探测式清理**(`expungeStaleEntry`):

```java
private void expungeStaleEntry(int staleSlot) {
    Entry[] tab = table;
    int len = tab.length;

    // 1. 清掉当前这个 stale 的 Entry
    tab[staleSlot].value = null;      // 关键:断开 value 的强引用
    tab[staleSlot] = null;
    size--;

    // 2. 继续往后扫描,把后面所有 key 为 null 的 Entry 也清掉,
    //    同时把因开放地址法而"错位"的元素重新安置
    for (int i = nextIndex(staleSlot, len); (e = tab[i]) != null; i = nextIndex(i, len)) {
        ThreadLocal<?> k = e.get();
        if (k == null) {
            e.value = null;
            tab[i] = null;
            size--;
        } else {
            // 重新计算位置(rehash)
        }
    }
}
```

另外,在 `set()` 时如果发现旧 key 已失效,还会顺手用新 key 替换掉那个 stale 槽位(`replaceStaleEntry`)。

但这套机制**指望不上**,原因有三:

| 兜底机制 | 触发条件 | 为什么不够 |
|---|---|---|
| `get()` 时的清理 | 只有恰好探测到 stale 槽位才清 | 清理范围有限,不是全表扫描 |
| `set()` 时的替换 | 哈希恰好落到 stale 槽位 | 概率性,可能长期不触发 |
| `expungeStaleEntry` | 每次只清理**一段连续区间** | 遇到 null 槽位就停止,不覆盖全表 |

最关键的一点:

> **兜底清理的触发条件是「后续还有人操作这张 Map」。如果这个 `ThreadLocal` 用完就再也不用了(比如一次性的临时变量),那清理永远不会被触发,泄漏就成了永久性的。**

所以结论很明确:**自动清理是补充手段,不是替代方案。必须自己 `remove()`。**

## 五、为什么必须 remove,而不是 set(null)

这是最常见的误解之一:

```java
// ❌ 这样做并不能解决泄漏
try {
    CACHE.set(data);
    doSomething();
} finally {
    CACHE.set(null);        // 只是把 value 置成 null
}
```

对比 `remove()` 的源码:

```java
public void remove() {
    ThreadLocalMap m = getMap(Thread.currentThread());
    if (m != null) {
        m.remove(this);          // 从 table 里把整个 Entry 摘掉
    }
}
```

`ThreadLocalMap.remove()` 会真正把 `Entry` 从数组里删除、断开 value 引用、并调用 `expungeStaleEntry` 做一次清理。

而 `set(null)` 只是把 `Entry.value` 字段改成了 `null`,**Entry 本身还留在 table 里**,连同它对 key 的弱引用一起占着数组槽位。占位本身不会泄漏大对象了(value 已经断开),但:

1. **槽位没释放**,Map 的 `size` 也不变,持续 `set(null)` 会让 table 只增不减;
2. **key 的弱引用仍然存在**,该 `ThreadLocal` 对象的回收时机仍然依赖 GC 判断;
3. **没有触达 `expungeStaleEntry`**,其他僵尸节点不会被顺带清理。

| 做法 | Entry 是否移除 | value 引用是否断开 | 槽位是否释放 | 能否防泄漏 |
|---|---|---|---|---|
| 什么都不做 | ❌ | ❌ | ❌ | ❌ |
| `set(null)` | ❌ | ✅(value 字段置空) | ❌ | ⚠️ 半吊子 |
| **`remove()`** | ✅ | ✅ | ✅ | ✅ |

**唯一正确做法:在 `finally` 里 `remove()`。**

```java
public void handle(Request req) {
    TRACE_ID.set(req.getTraceId());
    try {
        doHandle(req);
    } finally {
        TRACE_ID.remove();          // 无论成功失败都必须执行
    }
}
```

放在 `finally` 里的意义是:**即使业务抛异常,清理也不会被跳过**。这一点在线程池场景下尤其重要——异常路径恰恰是最容易被遗漏的路径,而线程会被归还到池里继续复用。

## 六、线程池场景:泄漏 + 串数据双重暴击

`ThreadLocal` 的另一个典型事故不是内存,而是**数据串户**。触发条件同样是线程复用。

```java
// ❌ 危险:线程池 + ThreadLocal 未清理
private static final ThreadLocal<String> TRACE_ID = new ThreadLocal<>();

public void process(Request req) {
    TRACE_ID.set(req.getTraceId());
    // 处理业务...异常路径没有清理
}

// 线程池执行
executor.submit(() -> process(reqA));     // 线程 T1 设了 TraceId=A,异常退出,未清理
executor.submit(() -> process(reqB));     // 线程 T1 复用,读到的还是 A
```

请求 B 的日志被打上了 A 的追踪 ID,排查问题时完全对不上号。这就是**日志串户**。

内存泄漏和数据串户其实是同一个原因的两个后果:

| 后果 | 表现 | 影响 |
|---|---|---|
| **内存泄漏** | 僵尸 `Entry` 长期占用堆 | 长期运行后 Full GC 频繁甚至 OOM |
| **数据串户** | 后面的任务读到前面的残留值 | 业务错误、日志错乱、权限判断出错 |

在权限、租户、用户身份这类场景里,第二类的后果比内存问题严重得多——**上一个用户的身份被下一个请求读到,直接就是越权**。

### 一个真实的味道

有个特别隐蔽的变体:子线程复用导致**日志串户**。表现是同一个请求的日志里混进了上一个请求的追踪 ID,而看代码完全找不到问题——因为 `set` 和 `get` 分别在不同的线程里发生。定位时可以从 `ThreadLocal` 的清理时机入手:**只要执行线程可能被复用,就必须在 `finally` 里 `remove()`**。

## 七、InheritableThreadLocal 与它的失效

有时候父线程的上下文需要传递给子线程。`ThreadLocal` 做不到(值只在本线程可见),Java 提供了 `InheritableThreadLocal`。

它的原理是在 `Thread` 的构造过程中,复制父线程的 `inheritableThreadLocals`:

```java
// Thread 构造函数中的关键片段(简化)
if (inheritThreadLocals && parent.inheritableThreadLocals != null) {
    // 在子线程创建时,把父线程的表复制一份过去
    this.inheritableThreadLocals =
            ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
}
```

注意加粗的那几个字:**在线程创建时复制**。

```java
public class InheritableThreadLocal<T> extends ThreadLocal<T> {
    // 子线程创建时调用,决定复制什么值(默认直接用父线程的值)
    protected T childValue(T parentValue) {
        return parentValue;
    }
}
```

### 为什么在线程池下会失效

线程池的线程是**提前创建好并长期复用**的,创建时机远早于任务提交:

```
时间线:
T0  线程池初始化,创建线程 T1
    └─ 此刻父线程(主线程)的 InheritableThreadLocal 里是空的
    └─ 复制发生 → T1 的表里什么都没有

T1  提交任务 A,T1 执行,打印 traceId → null   ❌
T2  提交任务 B,T1 执行,打印 traceId → null   ❌
```

复制只发生一次(线程创建那一刻),之后无论父线程怎么设置值,子线程都拿不到。所以:

| 方案 | 传递原理 | 线程池下是否有效 | 说明 |
|---|---|---|---|
| `ThreadLocal` | 仅本线程可见 | ❌ 完全传不过去 | 最基础,隔离性最强 |
| `InheritableThreadLocal` | **创建子线程时**复制 | ❌ 复制时机错位(T0 就复制完了) | 只适用 `new Thread()` |
| 显式传参 | 作为任务对象的字段 | ✅ | 最可靠,但侵入签名 |
| 任务装饰器 | 提交时快照,执行时恢复 | ✅ | **推荐**,对业务无侵入 |
| 阿里 `TransmittableThreadLocal` | 字节码增强 + 包装 | ✅ | 开源方案,覆盖更全 |

推荐的任务装饰器方案:

```java
public class ContextTask implements Runnable {
    private final String traceId;          // 提交时在父线程快照
    private final Runnable delegate;

    public ContextTask(Runnable delegate) {
        this.traceId = TRACE_ID.get();      // 关键:在提交线程上取值
        this.delegate = delegate;
    }

    @Override
    public void run() {
        TRACE_ID.set(traceId);             // 执行线程上恢复
        try {
            delegate.run();
        } finally {
            TRACE_ID.remove();             // 无论成败都清理
        }
    }
}
```

再配一个提交入口:

```java
public void submit(Runnable task) {
    executor.submit(new ContextTask(task));
}
```

三步走:**提交时快照 → 执行时恢复 → 结束时清理**。注意 `finally` 里的 `remove()` 不能省——否则执行线程会残留上一个任务的上下文,又回到串数据的问题上。

## 八、使用规范清单

| 规范 | 原因 |
|---|---|
| 声明为 **`private static final`** | `static` 避免每个实例重复创建 key;`final` 避免被重新赋值导致旧 Entry 永久泄漏 |
| 用完必须在 **`finally` 中 `remove()`** | `finally` 保证异常路径也清理 |
| 用 `remove()`,**不用 `set(null)`** | `set(null)` 不摘除 `Entry`,不释放槽位 |
| 线程池场景**必须清理** | 线程复用会同时导致泄漏和串数据 |
| 上下文传递用**任务装饰器** | `InheritableThreadLocal` 在线程池下失效 |
| 避免存**大对象** | 一旦忘记清理,泄漏量级大;必须存时要格外小心 |
| 注意**`@Async` / 线程池提交** | 同样是切换了执行线程,上下文会丢 |

再补一个容易忽略的点:**不要用 `ThreadLocal` 缓存本该由外部管理的资源**(如数据库连接、文件句柄)。这类资源需要显式关闭,放在 `ThreadLocal` 里容易变成"线程不结束就不释放",和连接池的设计直接冲突。

## 小结

- 数据**不存在 `ThreadLocal` 里**,而是存在 `Thread` 对象的 `ThreadLocalMap` 中,`ThreadLocal` 只是这张表的 **key**
- 泄漏根因:`Entry` 的 **key 是弱引用,value 是强引用**——GC 能回收 key,但 value 被 `Entry` 强引用着,只要线程活着就断不掉
- 弱引用只解决了一半问题,留下 key 为 null 的**僵尸 Entry**:永远访问不到,也永远回收不掉
- `ThreadLocalMap` 的**探测式清理只是兜底**:清理范围局部、触发依赖后续操作,若该 `ThreadLocal` 再也不被使用,清理永远不会发生
- 必须用 **`remove()`** 而不是 `set(null)`:`set(null)` 只置空 value 字段,**Entry 和槽位都还在**
- 清理必须放在 **`finally`** 里,异常路径最容易漏,而线程恰恰会被归还复用
- **线程池场景是双重暴击**:既泄漏内存,又让后续任务读到残留值造成**数据串户**——在身份、租户、权限场景下直接是越权
- `InheritableThreadLocal` 在**创建子线程时**复制,线程池的线程提前创建,**复制时机错位导致失效**;跨线程传递应改用**任务装饰器**(提交时快照 → 执行时恢复 → 结束时清理)
- 声明规范:**`private static final`**,这是最低成本的自我保护
