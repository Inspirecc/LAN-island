---
title: 并发容器选型:从 ConcurrentHashMap 说起
date: 2026-02-19
description: 并发容器的演进主线是「不断缩小锁的粒度」:从 Hashtable 的全表锁,到 ConcurrentHashMap 的分段锁,再到桶级锁。这篇讲清它的两代实现、CopyOnWriteArrayList 的适用边界,以及一套选型对照表。
tags: [Java, 并发编程, 集合, ConcurrentHashMap]
category: 并发编程
---

`Hashtable` 和 `Collections.synchronizedMap()` 都能让 Map 变"线程安全",但它们的做法是**给整张表加一把锁**——16 个线程读 16 个不同的 key,照样排队。而 `ConcurrentHashMap` 在 16 个线程操作 16 个不同桶时,可以真正并行。

这中间的差别,就是并发容器二十年演进的全部内容:**不断缩小锁的粒度,直到锁不再成为瓶颈**。

## 一、为什么不用 Hashtable

先看三代 HashMap 的线程安全方案对比:

| 实现 | 加锁范围 | 读操作 | 并发度 | 问题 |
|---|---|---|---|---|
| `HashMap` | 不加锁 | 无锁 | — | 并发写会丢数据、JDK 7 下成环 |
| `Hashtable` | **整张表** | 加锁 | 1 | 读写全部串行,并发度极低 |
| `Collections.synchronizedMap` | **整张表**(包装器) | 加锁 | 1 | 同上,且迭代仍需手动同步 |
| `ConcurrentHashMap` | **单个桶**(JDK 8+) | **无锁** | 桶数量级 | — |

`Hashtable` 的问题不只是慢,还在于它的"安全"是**靠牺牲全部并发换来的**。一个统计接口每秒读几万次、每秒写几次,在 `Hashtable` 上写操作会把所有读操作一起堵住。

而 `Collections.synchronizedMap` 更麻烦:它只在单个方法调用上加锁,**复合操作依然不安全**:

```java
Map<String, Integer> map = Collections.synchronizedMap(new HashMap<>());

// ❌ 依然有竞态:两个线程可能都读到 null,都执行 put
if (!map.containsKey(key)) {
    map.put(key, 1);
}
```

即使换成 `ConcurrentHashMap`,下面这段**依然是错的**——因为竞态不在 Map 内部,而在你的两次调用之间:

```java
// ❌ 仍然是 check-then-act 的复合操作
if (!map.containsKey(key)) {
    map.put(key, 1);
}
```

正确写法是用原子复合方法:

```java
map.putIfAbsent(key, 1);                             // 原子
map.computeIfAbsent(key, k -> new ArrayList<>());    // 原子
map.merge(key, 1, Integer::sum);                     // 原子
```

**这是并发容器最重要的使用原则:能用复合方法就用复合方法,别把原子操作拆成两步。**

## 二、ConcurrentHashMap 的两代实现

### JDK 7:分段锁(Segment)

JDK 7 的思路是把一张大表切成 N 个小表,每个小表一把锁:

```
ConcurrentHashMap
├── Segment[0]  (继承 ReentrantLock)  →  HashEntry[] 桶数组
├── Segment[1]
├── ...
└── Segment[15]                       默认并发级别 16
```

定位一个 key 需要两次哈希:先算出落在哪个 `Segment`,再在 `Segment` 内部算出落在哪个桶。加锁只加在目标的那个 `Segment` 上。

| 维度 | JDK 7 Segment 方案 |
|---|---|
| 锁对象 | `Segment`(继承 `ReentrantLock`) |
| 锁粒度 | 一段(默认整表的 1/16) |
| 并发度 | 等于 `Segment` 数量,构造时固定,之后不能改 |
| 定位开销 | **两次哈希**,先定位段再定位桶 |
| 内存开销 | 每个 `Segment` 都是一个锁对象,额外占用 |

分段锁解决了"全表锁"的问题,但引入了新问题:**并发度被写死在构造参数里**。初始化时定 16,业务涨到需要 64 并发也改不了,只能重建。

另一个隐忧是**内存浪费**:哪怕只有 3 个元素,16 个 `Segment` 也得全部创建出来。

### JDK 8:CAS + synchronized 的桶级锁

JDK 8 做了三处结构性改动:

1. **抛弃 `Segment`**,回到与 `HashMap` 一致的 `Node[] table` 结构,只**一次哈希**;
2. **锁对象从 `Segment` 变成桶的头节点**,粒度从"一段"细化到"一个桶";
3. **空桶插入用 CAS,非空桶用 `synchronized`**,读操作完全无锁。

写入流程大致是这样:

```java
// 简化后的 putVal 核心逻辑,展示 JDK 8 的并发策略
final V putVal(K key, V value, boolean onlyIfAbsent) {
    int hash = spread(key.hashCode());
    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int i;
        if (tab == null) {
            tab = initTable();                      // ① 懒初始化,用 sizeCtl 做 CAS 保证只初始化一次
        } else if ((f = tabAt(tab, i)) == null) {
            // ② 桶为空:直接 CAS 放进去,不加锁
            if (casTabAt(tab, i, null, new Node<>(hash, key, value)))
                break;
        } else if (f.hash == MOVED) {
            tab = helpTransfer(tab, f);             // ③ 正在扩容:当前线程也去帮忙搬数据
        } else {
            // ④ 桶非空:只锁住这个桶的头节点
            synchronized (f) {
                // ...链表遍历或红黑树插入
            }
            break;
        }
    }
    addCount(1L, binCount);                         // ⑤ 计数走 CounterCell 分散热点
    return null;
}
```

这段代码里有四个设计值得单独说:

**① 懒初始化 + `sizeCtl` CAS。** 表在第一次写入时才创建,用 `sizeCtl` 这个 volatile 字段配合 CAS 保证只有一个线程真正初始化。

**② 空桶 CAS。** 大部分写入落在空桶上(`HashMap` 默认负载因子 0.75,大量桶是空的),这类写入**完全不加锁**,一条 CAS 指令解决。

**③ 协助扩容。** 扩容时把桶标记为 `ForwardingNode`(`MOVED`),其他线程遇到这个标记不会阻塞等待,而是**加入搬运行列**。这把原本"一个线程搬、其他线程等"的过程变成了并行任务。

**④ 桶级 `synchronized`。** 只有发生哈希冲突时才加锁,而且只锁那一个桶的头节点。为什么这里用 `synchronized` 而不是 `ReentrantLock`?因为 JDK 6 之后 `synchronized` 有了偏向锁、轻量级锁的优化,**在低冲突场景下开销已经很小**;而每个桶配一把 `ReentrantLock` 会带来可观的内存开销。

### 计数为什么要用 CounterCell

`ConcurrentHashMap.size()` 的准确性一直是难点。如果用一个 `AtomicInteger` 计数,每次写入都 CAS 同一个变量,高并发下会形成严重的**热点竞争**——所有线程抢同一个缓存行。

JDK 8 的方案借鉴了 `LongAdder` 的**分散热点**思想:

```java
// 简化示意
final long sumCount() {
    CounterCell[] as = counterCells;
    long sum = baseCount;               // 基础计数
    if (as != null) {
        for (CounterCell a : as) {
            if (a != null) sum += a.value;   // 分散在各个 Cell 里
        }
    }
    return sum;
}
```

写入时优先尝试 `baseCount` 的 CAS;失败了就往 `counterCells` 数组里的某个槽位累加,槽位按线程哈希分散。这样不同线程落在不同槽位上,几乎不产生竞争。

代价是 `size()` 返回的是**估算值**——它要遍历所有 `CounterCell` 求和,求和过程中可能还有写入。

> **所以 `ConcurrentHashMap` 的 `size()` 是弱一致的近似值,不要用它做业务判断依据。** 需要精确计数时,应该由业务维护独立的计数器(比如 Redis 的原子计数)。

### 两代实现对比

| 维度 | JDK 7 | JDK 8+ |
|---|---|---|
| 数据结构 | `Segment[]` + `HashEntry[]` | `Node[]`,与 `HashMap` 一致 |
| 锁粒度 | Segment(一段) | 桶头节点(一个桶) |
| 锁类型 | `ReentrantLock` | 空桶 CAS + 桶内 `synchronized` |
| 哈希次数 | 2 次 | 1 次 |
| 并发度 | 固定(等于 Segment 数) | **随表容量动态增长** |
| 读操作 | 部分需要加锁 | **完全无锁**(`volatile` 读) |
| 扩容 | 单线程搬 | **多线程协助搬运** |
| 计数 | `Segment` 内独立计数 | `baseCount` + `CounterCell` 分散 |
| 链表过长 | 一直链表 | 转红黑树(阈值 8) |

**读操作为什么可以完全无锁?** 因为 `table` 数组的元素读写用的是 `volatile` 语义(`Unsafe.getObjectVolatile` / `putObjectVolatile`),保证可见性;而节点的 `val` 和 `next` 也是 `volatile` 的。读线程要么看到旧值要么看到新值,但不会看到"写了一半"的中间态。

## 三、CopyOnWriteArrayList:读多写极少的特化容器

`CopyOnWriteArrayList` 的思路极其直白:**写时复制整个数组**。

```java
public boolean add(E e) {
    synchronized (lock) {                    // ① 写操作加锁,保证只有一个写线程
        Object[] es = getArray();
        int len = es.length;
        es = Arrays.copyOf(es, len + 1);     // ② 复制一份新数组
        es[len] = e;
        setArray(es);                        // ③ volatile 写,切换引用
        return true;
    }
}

public E get(int index) {
    return elementAt(getArray(), index);     // ④ 读操作完全无锁,读的是快照
}
```

关键在于**读线程拿到的永远是一个不可变的数组快照**:

| 特性 | 说明 |
|---|---|
| 读操作 | **完全无锁**,不需要任何同步,性能与 `ArrayList` 相当 |
| 写操作 | 加锁 + **全量复制**,时间复杂度 O(n) |
| 内存 | 每次写入都产生一个新数组,写频繁时内存压力大 |
| 迭代器 | **快照迭代器**,迭代期间不会抛 `ConcurrentModificationException` |
| 数据一致性 | **弱一致**,迭代过程中看不到新写入的元素 |

### 迭代器不抛异常,是优点也是陷阱

`ArrayList` 在迭代中被修改会立刻抛 `ConcurrentModificationException`,而 `CopyOnWriteArrayList` 的迭代器基于快照,**永远不会抛**:

```java
CopyOnWriteArrayList<String> list = new CopyOnWriteArrayList<>();
list.add("A");

for (String s : list) {
    list.add("B");        // 不抛异常,但这次迭代看不到 "B"
}
```

这看起来很美好,但要注意:**"不抛异常"不等于"你看到了最新数据"**。如果业务逻辑依赖"迭代到的数据就是当前全部数据",这个假设在 `CopyOnWriteArrayList` 上不成立。

### 适用边界

| 场景 | 适合吗 | 原因 |
|---|---|---|
| 监听器列表、白名单、配置项 | ✅ | 写极少,读极多 |
| 本地缓存的路由表、字典表 | ✅ | 变更频率低,读取高频 |
| 作为消息队列使用 | ❌ | 写频繁,每次都全量复制 |
| 频繁增删的集合 | ❌ | O(n) 复制会成为瓶颈 |
| 必须读到最新数据 | ❌ | 弱一致性,可能读到旧快照 |

判断标准很简单:**读操作比写操作高出几个数量级时用它,读写相当或写多读少时别碰。**

## 四、其他常用并发容器

### 队列族

`BlockingQueue` 家族是生产者-消费者模型的基础设施,选型主要看两点:**有界还是无界、锁的粒度**。

| 实现 | 底层结构 | 锁粒度 | 有界 | 适用 |
|---|---|---|---|---|
| `ArrayBlockingQueue` | 数组 | **一把锁**(读写共用) | 必须指定容量 | 通用,容量可预估 |
| `LinkedBlockingQueue` | 链表 | **两把锁**(put/take 分离) | 可选(**不传即无界**) | 吞吐更高,但慎用无界 |
| `SynchronousQueue` | 无容量 | — | 容量为 0 | 直接交接,`CachedThreadPool` 用它 |
| `PriorityBlockingQueue` | 堆 | 一把锁 | 无界 | 带优先级的任务 |
| `DelayQueue` | 堆 + 延迟 | 一把锁 | 无界 | 延迟任务、超时取消 |
| `LinkedTransferQueue` | 链表 | 无锁算法 | 无界 | 高吞吐,`transfer()` 可直接交付 |

`LinkedBlockingQueue` 用**两把锁**(`putLock` / `takeLock`)把入队和出队分离,并发度比 `ArrayBlockingQueue` 的单锁更高。但它最大的坑是**默认无界**——不传容量参数时容量是 `Integer.MAX_VALUE`,下游消费不过来时会无限积压,最终把堆撑爆。

**结论:队列一律显式指定容量。**

### 原子类族

| 类 | 适用场景 | 原理 |
|---|---|---|
| `AtomicInteger` / `AtomicLong` | 单变量计数,冲突不激烈 | CAS |
| `LongAdder` / `DoubleAdder` | **高并发统计计数** | 分散到多个 `Cell`,求和时汇总 |
| `AtomicReference` | 单个对象引用的原子更新 | CAS |
| `AtomicStampedReference` | 需要感知修改过程的场景 | 值 + 版本号一起 CAS |
| `AtomicIntegerArray` | 数组元素独立更新 | 元素级 CAS |
| `AtomicFieldUpdater` | 已有类的字段原子化 | 反射 + CAS,省内存 |

`LongAdder` 和 `AtomicLong` 的取舍值得单独说:

| 维度 | `AtomicLong` | `LongAdder` |
|---|---|---|
| 实现 | 单个 `volatile long` + CAS | `base` + `Cell[]` 分散 |
| 高并发写 | 所有线程抢同一个变量,竞争激烈 | 分散到不同 Cell,几乎无竞争 |
| 高并发写吞吐 | 低 | **高** |
| 读(`sum()`) | **精确、O(1)** | 需要遍历 Cell,**近似值** |
| 适用 | 需要精确值、写不频繁 | 统计埋点、QPS 计数等写多读少场景 |

选型原则和 `ConcurrentHashMap` 的计数一致:**写多读少要吞吐就 `LongAdder`,要精确值就 `AtomicLong`。**

## 五、选型总表

| 需求 | 首选 | 备选 / 注意 |
|---|---|---|
| 高并发 KV 存储 | `ConcurrentHashMap` | 复合操作用 `computeIfAbsent` / `merge` |
| 需要排序的并发 Map | `ConcurrentSkipListMap` | 基于跳表,平均 O(log n),无锁读 |
| 读多写极少的 List | `CopyOnWriteArrayList` | 写频繁时别用 |
| 需要并发 Set | `ConcurrentHashMap.newKeySet()` | 比 `CopyOnWriteArraySet` 更通用 |
| 生产者-消费者队列 | `ArrayBlockingQueue`(有界) | 高吞吐可换 `LinkedBlockingQueue`,但**必须指定容量** |
| 高并发计数 | `LongAdder` | 需要精确值用 `AtomicLong` |
| 延迟任务 | `DelayQueue` | 或专门的调度框架 |
| 线程安全的累加器 | `LongAccumulator` | 可自定义聚合函数 |

几条贯穿始终的原则:

1. **能用现成的并发容器,就别自己拿锁拼一个**——`ConcurrentHashMap`、`CopyOnWriteArrayList`、`BlockingQueue` 已经覆盖了绝大多数场景,而且都是经过充分验证的;
2. **复合操作用原子方法**——`putIfAbsent`、`computeIfAbsent`、`merge`,别用 `containsKey` + `put` 两步;
3. **队列必须有界**——无界队列是内存泄漏的常见入口;
4. **分清精确值和近似值**——`ConcurrentHashMap.size()` 和 `LongAdder.sum()` 都是估算,别拿来做业务判断;
5. **弱一致要评估**——`CopyOnWriteArrayList` 的迭代器和 `ConcurrentHashMap` 的遍历都是弱一致的,业务能否接受取决于场景。

## 小结

- 并发容器的主线是**不断缩小锁粒度**:全表锁(`Hashtable`)→ 分段锁(JDK 7 `Segment`)→ 桶级锁 + CAS(JDK 8)
- JDK 8 的 `ConcurrentHashMap` 四板斧:**空桶 CAS 不加锁、非空桶 `synchronized` 只锁头节点、读完全无锁、扩容多线程协助搬运**
- 锁对象从 `Segment` 变成桶头节点后,**并发度不再被构造参数写死**,而是随容量动态增长
- `size()` 走 `baseCount` + `CounterCell` 分散热点,**返回的是近似值**,不能作为业务判断依据
- `CopyOnWriteArrayList` 靠**写时全量复制**实现无锁读,只适合读多写极少的场景;它的快照迭代器不抛异常,但也不保证看到最新数据
- 队列选型看两点:**有界与否**、**锁粒度**;`LinkedBlockingQueue` 的读写双锁并发度更高,但默认无界必须显式指定容量
- 计数场景:**写多读少用 `LongAdder`(近似),要精确值用 `AtomicLong`**
- 最重要的使用原则:**复合操作要用原子方法**,`containsKey` + `put` 这种两步写法在任何并发容器上都不安全
