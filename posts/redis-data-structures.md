---
title: Redis 五大数据结构与底层实现
date: 2026-03-26
description: 五种数据类型是 API 层面的名字,底层的编码远不止五种。同一个 key 可能用三种结构存,一个 List 可能是"链表套数组"。这篇从编码转换条件出发,把每种结构的实现、阈值和适用场景串起来。
tags: [Redis, 数据结构, 跳表, 内存优化]
category: Redis
---

"Redis 有五种数据类型"是个方便的说法,但它容易让人误以为底层也只有五种结构。实际上 `TYPE` 返回的是**逻辑类型**,`OBJECT ENCODING` 返回的才是**底层编码**——同一个 Set 可能是 `intset`、`listpack` 或 `hashtable`,同一个 List 可能是 `listpack` 或 `quicklist`,而 `quicklist` 本身还是"双向链表套紧凑数组"的复合结构。

理解编码的价值在于:**它决定了内存在哪里省、性能毛刺在哪里出、哪些命令在大数据量下会变慢。**

## 一、总览:类型与编码是两回事

```bash
TYPE user:1001              # → hash        (逻辑类型)
OBJECT ENCODING user:1001   # → listpack    (底层编码)
MEMORY USAGE user:1001      # → 实际占用的字节数
```

五种逻辑类型对应的编码与转换条件(阈值为 Redis 7 的默认值):

| 类型 | 底层编码 | 转换条件 |
|---|---|---|
| String | `int` / `embstr` / `raw` | 整数且长度 ≤ 20 → `int`;长度 ≤ 44 → `embstr`;否则 `raw` |
| List | `listpack` / `quicklist` | 超出 `list-max-listpack-size`(默认 `-2`,即单节点约 8KB)→ `quicklist` |
| Hash | `listpack` / `hashtable` | 字段数 > `hash-max-listpack-entries`(512)或任一 value > 64 字节 |
| Set | `intset` / `listpack` / `hashtable` | 元素全是整数且个数 ≤ 512 → `intset`;仅整数条件不满足、但个数 ≤ 128 且单元素 ≤ 64 字节 → `listpack`(7.2+);再越界 → `hashtable` |
| ZSet | `listpack` / `skiplist` | 成员数 > `zset-max-listpack-entries`(128)或任一成员 > 64 字节 |

三条需要记住的规律:

- **阈值是"或"的关系**,元素个数和单元素大小任意一个越界,都会触发转换
- **转换基本是单向的**,一旦变成 `hashtable` / `skiplist` 就不会退回紧凑编码,即使后来删掉了元素
- **转换本身可能造成延迟毛刺**,因为它要在单线程里把整个结构重新编码一遍

## 二、String:SDS 而不是 C 字符串

### 为什么不用 C 字符串

C 的 `char*` 有三个硬伤:`strlen` 是 O(n);以 `\0` 结尾所以不能存二进制;拼接要手动管理扩容,容易溢出。Redis 自己实现了 SDS(Simple Dynamic String):

```c
struct sdshdr {
    uint32_t len;    // 已用长度
    uint32_t alloc;  // 已分配的总容量
    unsigned char flags;
    char buf[];      // 柔性数组,实际数据
};
```

带来的三个能力:

| 能力 | 说明 |
|---|---|
| **O(1) 取长度** | `len` 字段直接给,`STRLEN` 不需要遍历 |
| **二进制安全** | 靠 `len` 判断结尾而不是 `\0`,可以存图片、序列化后的 Protobuf |
| **空间预分配 + 惰性释放** | 长度小于 1MB 时按翻倍扩容;超过 1MB 每次多分配 1MB。缩短时不立即归还,记在 `alloc` 里备用 |

预分配把追加操作的均摊成本降到 O(1),惰性释放避免了频繁的内存重分配。代价是**缩短字符串后内存不会立刻还给操作系统**,`MEMORY USAGE` 看到的不一定等于实际数据量。

### 三种编码

| 编码 | 条件 | 特点 |
|---|---|---|
| `int` | 值是整数且不超过 20 位 | **不额外分配内存**,直接把数值存在指针位置 |
| `embstr` | 长度 ≤ 44 字节 | 一次内存分配,整体只读;一旦执行 `APPEND`、`SETRANGE` 等修改命令,会转为 `raw` |
| `raw` | 长度 > 44 字节 | 两次分配,可自由修改 |

44 这个数字来自 jemalloc 的 64 字节分配档位减去 SDS 头部和对象头部的开销。`embstr` 只读是个容易被忽略的细节:**对它执行任何修改命令都会触发一次编码转换,这也是一个小毛刺来源。**

### 典型场景

| 场景 | 命令 |
|---|---|
| 计数器、库存余量 | `INCR` / `DECRBY`(`int` 编码下不涉及字符串解析) |
| 缓存 JSON、HTML 片段 | `SET key value EX 3600` |
| 分布式锁的持有者标识 | `SET lock:id uuid NX EX 30` |
| 签到、活跃标记 | `SETBIT` / `BITCOUNT` |
| UV 基数统计 | `PFADD` / `PFCOUNT` |

位图的省内存能力值得单独感受一下:100 万个用户的签到状态,用位图只占约 125KB。

```bash
# 位图做签到:11 月 5 日签到
SETBIT sign:202611:1001 5 1
BITCOUNT sign:202611:1001         # 本月签到天数
```

## 三、List:quicklist 是"链表套数组"

### 演进过程

| 版本 | 结构 | 问题 |
|---|---|---|
| 3.2 之前 | `ziplist` 或 `linkedlist`,由 `list-max-ziplist-entries` 决定 | 纯链表指针开销大、内存碎片多;纯 ziplist 插入删除要整体搬移,元素多时阻塞严重 |
| 3.2 ~ 7.0 | `quicklist`(外层双向链表 + 每节点 `ziplist`) | 兼顾两端 O(1) 插入和单节点的内存紧凑 |
| 7.0+ | `quicklist`(每节点改为 `listpack`) | 彻底避开 ziplist 的级联更新问题 |

`list-max-listpack-size` 的取值规则值得单独说,因为它是 Redis 里少见的"负数表示另一种含义"的配置:

| 取值 | 含义 |
|---|---|
| 正数,如 `100` | 每个 quicklist 节点**最多 100 个元素** |
| 负数,如 `-2`(默认) | 每个节点的大小**不超过 2 的幂次档位**,`-2` 表示 8KB,`-1` 表示 4KB |

按大小限制在小元素场景下更省内存,按个数限制在元素较大时更可控。除此之外还有 `list-compress-depth`,它对中间节点做 LZF 压缩——**两端节点不压缩**,因为队列的两端最常被访问。

### 用途与边界

| 场景 | 写法 |
|---|---|
| 栈(LIFO) | `LPUSH` + `LPOP` |
| 队列(FIFO) | `LPUSH` + `RPOP`,或 `RPUSH` + `LPOP` |
| 阻塞式消费 | `BRPOP key 5`,无数据时阻塞等待,比轮询友好 |
| 最新 N 条列表 | `LPUSH` + `LTRIM key 0 99`,天然固定长度 |

但要清醒:**List 做消息队列的能力很有限**——没有 ack 机制,消费者 `RPOP` 之后崩溃消息就丢了;不支持多消费组和广播;消息无法回溯重放。需要这些能力就应该用 Stream 或者专业的消息中间件,List 只适合"丢了也无所谓"的日志、通知这类场景。

命令复杂度也要留意:`LPUSH` / `RPOP` 是 O(1),但 `LRANGE key 0 -1` 是 O(N),在一个百万元素的 List 上会长时间占用主线程——**大 List 是全量读取的禁区**,应该用 `LRANGE` 分页取。

## 四、Hash:从 listpack 到 hashtable

### listpack 解决了什么

`listpack` 是 Redis 7.0 引入的紧凑结构,用来替代 `ziplist`。两者都是"一块连续内存里存多个元素",但 ziplist 有个著名的问题:**级联更新(cascade update)**。

ziplist 的每个节点用 `prevlen` 记录前一个节点的长度。如果前一个节点长度发生变化、且跨越了 254 字节这个编码边界,`prevlen` 字段本身就要扩容,进而导致本节点长度变化,再影响下一个节点……最坏情况下一次插入会连锁修改整个 ziplist,复杂度退化到 O(n²)。

listpack 的做法是**每个节点只记录自己的总长度**,不再依赖前驱信息,从结构上消掉了级联更新。

### 编码转换与取舍

```bash
# 默认阈值
hash-max-listpack-entries 512    # 字段数超过 512 → hashtable
hash-max-listpack-value 64       # 任一 value 超过 64 字节 → hashtable
```

小 hash 用 listpack 是纯粹的省内存选择:哈希表要为每个字段维护 `dictEntry`、键对象、值对象和指针,而 listpack 只是一块线性的连续内存,**内存能省到十分之一左右**。虽然查找退化成 O(N) 的线性扫描,但 N 被限制在 512 以内,均摊下来依然是常数级——这也是官方文档里说"仍然接近 O(1)"的原因。

反过来,一旦超过阈值转成 `hashtable`,内存占用会突然上升一大截。**如果一个 Hash 的字段数注定要长到几千,那它从一开始就该按哈希表的内存来估算。**

### 典型场景

| 场景 | 写法 | 好处 |
|---|---|---|
| 对象存储 | `HSET user:1001 name x age 20` | 字段级读写,不用整对象反序列化 |
| 积分、计数 | `HINCRBY point:1001 total 10` | 字段级原子自增 |
| 购物车 | `HSET cart:1001 sku:88 2` | 商品 id 做 field,数量做 value |

对比"把整个对象序列化成一个 String"的写法,Hash 的优势很明确:改一个字段不需要"读出整个 JSON → 改 → 写回",**既省带宽,也避免了并发写回的覆盖风险**。另外把一组相关字段收在一个 key 里,还省掉了每个独立 key 的元数据开销(过期字典项、LRU 字段等)。

限制也很明确:**field 不能单独设置过期时间**(只有整个 key 能过期),也不支持嵌套结构。所以"某个字段需要独立 TTL"的需求,只能拆成独立 key,或者接受"整 key 过期 + 以数据库为准、异步回填"。

## 五、Set:intset、listpack 与 hashtable

### 三种编码

| 编码 | 条件 | 特点 |
|---|---|---|
| `intset` | 元素**全是整数**,且个数 ≤ `set-max-intset-entries`(512) | 升序整数数组,内存极紧凑,`SISMEMBER` 靠二分查找 O(log N) |
| `listpack` | Redis 7.2+;含非整数元素,但个数 ≤ 128 且单元素 ≤ 64 字节 | 小集合的紧凑编码,省内存 |
| `hashtable` | 上述任一条件越界 | 通用实现,查找 O(1),内存开销显著上升 |

需要特别注意的是 `intset`:它要求**所有元素都是整数**。只要插入一个非整数成员(比如一个字符串 id),整个结构就会立刻升级,而且**升级不可逆**——即使后来把那个非整数元素删掉,也不会退回 `intset`。

实践中容易踩的坑是:用户标识通常是数字,但偶尔混进一条带前缀的脏数据,就能让整个大集合的内存翻好几倍。**写入前做类型归一化,比事后排查内存省事得多。**

### 典型场景

| 场景 | 命令 | 复杂度 |
|---|---|---|
| 点赞去重、UV 去重 | `SADD` / `SISMEMBER` / `SCARD` | O(1) |
| 标签、兴趣集合 | `SMEMBERS`(小集合) / `SSCAN`(大集合) | O(N) |
| 共同关注、可能认识的人 | `SINTER` / `SDIFF` | O(N×M) |
| 随机抽奖 | `SRANDMEMBER`(不删除) / `SPOP`(删除) | 带 count 参数时为 O(N),不带为 O(1) |

集合运算要特别留意复杂度:`SINTER` / `SUNION` / `SDIFF` 是 O(N×M),在几十万元素的两个 Set 上做交集会长时间阻塞。如果这类运算频繁,应该考虑离线计算,或者换用专门的图与推荐组件。

另外,当去重规模达到百万级时,**Set 的内存开销会变得难以接受**。这时有两条更省的路:

- **布隆过滤器**:每个元素约 10 bit 就能把误判率压到 1% 以下,代价是只能回答"可能存在 / 一定不存在",且不支持删除
- **HyperLogLog**:只做基数统计,不存具体元素,**12KB 固定内存**就能统计上亿 UV,标准误差 0.81%

HyperLogLog 只能给出近似值,而且**无法判断某个元素是否已经在集合里**。UV 统计这类"只要一个数"的需求正合适,去重判定则不行。

## 六、ZSet:dict + skiplist 的组合

ZSet 是五种类型里结构最精巧的——**它同时维护了两套索引**:

| 结构 | 作用 | 带来的复杂度 |
|---|---|---|
| 哈希表 `dict` | member → score 的映射 | `ZSCORE` 是 **O(1)** |
| 跳表 `skiplist` | 按 score 排序的多级索引 | `ZRANGE` / `ZREVRANGE` 范围查询是 O(log N + M) |

为什么不只留一个?**只留跳表**,`ZSCORE` 就要 O(log N),而"查某个成员多少分"是高频操作;**只留哈希表**,取 TopN 就得把全量拉出来排序。两个结构配合,各自处理自己擅长的查询。

跳表节点里有两个容易被忽略的字段:

```c
typedef struct zskiplistNode {
    sds ele;                        // 成员
    double score;                   // 分值
    struct zskiplistNode *backward; // 后退指针,支撑 ZREVRANGE 反向遍历
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;         // 本层跨越的节点数
    } level[];
} zskiplistNode;
```

`span` 让 `ZRANK` / `ZREVRANK` 能在 O(log N) 内算出排名,而不是从头数一遍。层高是随机决定的(概率 p=0.25,最高 32 层),期望每个节点只多带约 1.33 个指针,**用随机化换掉了平衡树的 rebalance 逻辑**。

ZSet 同样有紧凑编码:成员数 ≤ `zset-max-listpack-entries`(128)且成员长度 ≤ 64 字节时用 `listpack`。榜单类结构很容易超过这个阈值,一次性跨过阈值会触发整体重编码。

### 典型场景

| 场景 | 写法 |
|---|---|
| 排行榜 | `ZINCRBY hot:keywords 1 关键词` + `ZREVRANGE 0 9` |
| 延时队列 | score 存到期时间戳,`ZADD delay:queue <ts> <task>` |
| 滑动窗口限流 | score 存请求时间戳,`ZREMRANGEBYSCORE` 清理过期 + `ZCARD` 计数 |
| 带优先级的任务队列 | score 作为优先级,`ZPOPMIN` 取最高优先级 |

延时队列的消费逻辑很直观——只取到期的那部分:

```java
// 生产者:延迟 30 秒执行
long executeAt = System.currentTimeMillis() + 30_000;
redis.zadd("delay:queue", executeAt, taskId);

// 消费者:轮询取出所有已到期的任务
Set<String> due = redis.zrangeByScore("delay:queue", 0, System.currentTimeMillis(), 0, 100);
for (String taskId : due) {
    // 关键:用 ZREM 的返回值做争抢,只有删成功的实例才执行
    // 多实例同时扫到同一个任务时,这行保证只有一个消费者真正执行
    if (redis.zrem("delay:queue", taskId) == 1) {
        execute(taskId);
    }
}
```

这里的 `ZREM` 返回值充当了**分布式抢占**的角色。但要注意,如果执行失败任务就丢了,需要配合重试机制或者把任务状态落库。

## 七、按场景选类型

| 需求 | 类型 | 关键命令 |
|---|---|---|
| 计数、限流、缓存对象、锁 | String | `INCR` / `SET NX EX` |
| 签到位图、活跃标记 | String(bitmap) | `SETBIT` / `BITCOUNT` |
| 对象字段级更新 | Hash | `HSET` / `HINCRBY` |
| 队列、最新 N 条 | List | `LPUSH` + `BRPOP` / `LTRIM` |
| 去重、标签、交并集 | Set | `SADD` / `SINTER` |
| 排行榜、延时队列 | ZSet | `ZINCRBY` / `ZRANGEBYSCORE` |
| 海量 UV 基数 | HyperLogLog | `PFADD` / `PFCOUNT` |
| 消息持久化、消费组 | Stream | `XADD` / `XREADGROUP` |

## 八、三个通用陷阱

### 陷阱一:大 key

不管哪种类型,单个 key 过大都会带来连锁问题:

| 问题 | 说明 |
|---|---|
| 阻塞主线程 | `LRANGE`、`HGETALL`、`SMEMBERS`、`DEL` 在大 key 上都是 O(N),期间所有请求排队 |
| 内存不均 | 集群模式下无法拆到多个分片,单节点内存倾斜 |
| 删除代价 | `DEL` 同步释放内存可能造成秒级卡顿,应改用 `UNLINK` 异步删除 |
| 迁移困难 | 扩容迁移时大 key 会拖慢整个 slot 的搬迁 |

排查手段:`redis-cli --bigkeys` 扫描,或者对可疑 key 用 `MEMORY USAGE` 确认。经验上单个 String 超过 10KB、集合类元素数超过 5000 就值得考虑拆分。

### 陷阱二:编码转换的毛刺

阈值附近反复跨越会造成反复重编码。由于转换不可逆,通常不存在"来回转换"的问题,但**第一次跨越时的那一次全量重编码**仍然可能表现为延迟毛刺。压测时如果发现某一段时间 P99 突然升高,可以检查是不是恰好有大批 key 完成了编码升级。

### 陷阱三:把缓存当数据库

Redis 的持久化(RDB 快照、AOF)都存在数据丢失窗口,主从复制默认是异步的。**它适合做缓存、做加速层,不适合做唯一的数据源**。涉及金额、库存、订单状态这类数据,数据库必须是最终账本,Redis 里的值只能作为前置判断。

## 小结

- `TYPE` 是逻辑类型,`OBJECT ENCODING` 才是底层实现;**同一种类型有多种编码,转换由元素个数和单元素大小共同决定**
- String 用 **SDS**:O(1) 取长度、二进制安全、预分配 + 惰性释放;`int` / `embstr` / `raw` 三种编码影响内存占用和可修改性
- List 用 **quicklist**(双向链表 + listpack 节点),`list-max-listpack-size` 用负数表示按大小限制;做队列没有 ack、没有消费组,能力有限
- Hash 小数据量用 **listpack**(7.0 起替代 ziplist,避开了级联更新),超过 512 个字段或 64 字节的 value 转 `hashtable`;优势是字段级更新,限制是字段不能单独过期
- Set 有 `intset` / `listpack` / `hashtable` 三种编码,**插入一个非整数成员就会让 intset 永久升级**;交并集是 O(N×M),大集合上代价很高
- ZSet 用 **dict + skiplist 双结构**:前者保证 `ZSCORE` 是 O(1),后者保证范围查询和排名是 O(log N),节点里的 `span` 支撑 `ZRANK`
- 海量去重和 UV 统计应该考虑**布隆过滤器**和 **HyperLogLog**,它们用精度换内存,但都不支持"元素是否存在"之外的集合操作
- 无论哪种类型,**大 key 都是性能事故的源头**;删除用 `UNLINK`,读取要分页,设计阶段就该控制单个 key 的规模
