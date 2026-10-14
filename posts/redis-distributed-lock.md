---
title: Redis 分布式锁：从 SETNX 到看门狗
date: 2026-02-10
description: 分布式锁的难点不在"怎么加锁",而在"锁的主人已经换人了你还不知道"。这篇从最朴素的 SETNX 讲起,一路推到 Lua 释放、看门狗续期、Redisson 封装,最后说清主从切换丢锁这个绕不开的缺陷。
tags: [Redis, 分布式锁, Redisson, 并发]
category: Redis
---

单机应用里加锁是件很省心的事:`synchronized` 或者 `ReentrantLock` 一把,同一 JVM 内的线程互斥就成立了。但应用一旦多实例部署,内存里的锁就形同虚设——实例 A 拿到的锁,实例 B 根本看不见。

这时候通常会说"上 Redis 分布式锁"。但真正踩过坑的人会告诉你:**分布式锁出问题,很少是因为锁不够强,而是因为锁的主人早就换人了,持有者还不知道。**

这篇文章从最朴素的写法开始,一步步推到生产可用的形态。

## 一、最朴素的版本,以及它为什么不能上线

思路很直白:多个实例竞争同一个 Redis key,谁把 key 建出来谁就拿到锁,谁把 key 删掉谁就释放锁。

```bash
SETNX lock:order:1001 uuid-abc    # key 不存在才设置成功,代表抢到锁
DEL   lock:order:1001             # 释放锁
```

`SETNX` 是 "SET if Not eXists" 的缩写,返回值 1 表示抢到,0 表示被别人占了。这个版本能跑通 demo,但有两个致命问题。

**问题一:进程崩溃就是永久死锁。** 实例 A 抢到锁之后宕机,`DEL` 永远不会执行,这个 key 就一直在那里。此后所有实例都抢不到锁,对应的业务彻底卡死。这和单机锁不一样——单机锁随进程一起消失,Redis 里的 key 不会。

**问题二:删除的不是自己的锁。** 看这条时间线:

| 时刻 | 实例 A | 实例 B | Redis 中的锁 |
|---|---|---|---|
| T1 | SETNX 成功 | | A 持有 |
| T2 | 业务卡住(GC / 慢查询) | | A 持有 |
| T3 | | 以为锁没了,SETNX 成功 | B 持有 |
| T4 | 业务终于跑完,DEL | | **锁被 A 删掉了** |
| T5 | | 业务还在跑,锁却没了 | 无锁状态 |

T4 那一刀下去,B 的锁被删了。更糟的是 T5——第三个实例此时可以长驱直入,形成 A、B、C 三方同时执行临界区。

## 二、SET NX EX:一条命令解决两个问题

`SETNX` 之后补一条 `EXPIRE` 的思路很自然,但这样就退回了老问题:

```bash
SETNX lock:order:1001 uuid-abc
EXPIRE lock:order:1001 30        # ← 如果这条没执行(宕机/网络断),照样死锁
```

两条命令之间存在缝隙,而 Redis 单线程只保证**单条命令**不可打断,管不了两条命令之间发生了什么。正确写法是把它们合并成一条:

```bash
SET lock:order:1001 uuid-abc NX EX 30
```

| 参数 | 作用 |
|---|---|
| `NX` | key 不存在才设置,等价于 SETNX 的语义 |
| `EX 30` | 30 秒后自动过期,兜住"宕机不释放" |
| `uuid-abc` | 唯一标识持有者,用来判断"这把锁是不是我的" |

这里有个容易被忽略的细节:**value 必须是唯一标识**。它不参与锁的逻辑,但它是下一步安全释放锁的唯一依据。常见做法是 `UUID.randomUUID()` 拼接线程 ID,Redisson 用的就是 `UUID + 线程 ID`。

顺带一提,不要用 `SETEX` 或 `PSETEX` 替代——它们没有 `NX` 语义,会把别人的锁直接覆盖掉。

## 三、释放锁:必须用 Lua,而且必须比对 value

有了唯一标识,释放锁就可以从"盲删"变成"确认后删":

```lua
-- KEYS[1] = 锁的 key,ARGV[1] = 当前持有者的唯一标识
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
```

为什么这段判断不能用 Java 写?

```java
// ❌ 看起来对,实际有缝
if (id.equals(jedis.get("lock:order:1001"))) {   // 判断:是我的锁
    jedis.del("lock:order:1001");                // 删除
}
```

判断和删除之间隔着一次网络往返。如果锁恰好在这段时间里过期、又被别人抢到,那么这次 `DEL` 删掉的仍然是别人的锁。**"防误删"这件事本身也是个竞态,只有把它交给 Redis 在服务端一次性完成才算数。**

Redis 执行 Lua 脚本期间不会处理其他命令,所以「取值 → 比对 → 删除」对客户端来说是原子的。这一段在 Redisson 里对应的是:

```lua
-- 精简后的 Redisson 释放锁脚本:锁用 Hash 存,field 是"客户端ID:线程ID"
if redis.call('hexists', KEYS[1], ARGV[3]) == 0 then
    return nil;                                -- 锁不是我的,直接返回
end;
local counter = redis.call('hincrby', KEYS[1], ARGV[3], -1);
if counter > 0 then
    redis.call('pexpire', KEYS[1], ARGV[1]);   -- 重入计数未归零,续期后返回
    return 0;
else
    redis.call('del', KEYS[1]);                -- 计数归零,真正释放
    return 1;
end;
```

用 Hash 而不是 String,就是为了支撑**可重入**:同一个线程第二次 `lock()` 时把计数加一,解锁时减一,只有减到 0 才真正删除 key。这也是自研锁最容易漏掉的一块。

## 四、锁过期了业务还没跑完:看门狗

到这一步,锁的加、解都安全了,但还剩一个根本矛盾:

```
锁 TTL = 30s
业务耗时 = 40s
    ↓
第 30 秒锁自动过期
第 31 秒实例 B 抢到锁
第 31~40 秒 A 和 B 同时执行临界区   ← 互斥彻底失效
```

而且 A 在第 40 秒释放锁时,因为 value 对不上,Lua 脚本会返回 0 不删——**保护了 B 的锁,但并没有挽回这段时间的数据竞争**。

这个问题的本质是:**TTL 是拍脑袋估的,业务耗时不是。** 设短了会提前失锁,设长了宕机后要等很久才自动解锁。

看门狗(Watchdog)的思路是让锁自己"续命":

```
加锁成功
   ↓
后台任务每隔 1/3 的 TTL 检查一次:业务还在跑吗?
   ↓ 是
PEXPIRE 把锁重置回完整 TTL(默认 30s,即每 10s 续一次)
   ↓
业务执行完 → 显式 unlock → 停止续期
```

Redisson 已经把这套封装好了,默认参数是 `lockWatchdogTimeout = 30000ms`,续期间隔 `30s / 3 = 10s`。它有一个必须记住的行为差异:

```java
RLock lock = redisson.getLock("lock:order:1001");

// ✅ 不传 leaseTime → 启用看门狗,自动续期
lock.lock();
try {
    doBusiness();                 // 跑多久都不会非预期失锁
} finally {
    lock.unlock();
}

// ⚠️ 传了 leaseTime → 看门狗不生效,到期就释放
lock.lock(10, TimeUnit.SECONDS);  // 业务跑了 15s,第 10 秒就失锁了
```

**"显式指定过期时间会关掉看门狗"**这件事很容易踩,因为传了参数看起来更"明确",实际是把安全网撤了。只有在业务耗时确实有上界、且明确接受超时放弃锁的场景,才应该传 `leaseTime`。

另外要清楚看门狗的边界:续期是客户端发起的。如果 JVM 发生长时间的 STW(比如 Full GC 卡了 20 秒),续期请求发不出去,锁照样会过期。**看门狗降低了失锁概率,没有消除它。**

## 五、更进一步:用 fencing token 兜住"过期后的写入"

既然失锁无法根除,能不能让失锁不再造成破坏?

可以。思路是给每次加锁分配一个**单调递增的令牌**,让被保护的资源自己能识别出旧持有者:

```bash
# 加锁的同时申请一个全局递增的令牌
INCR   lock:fencing:token          # → 返回 7,这就是本次持锁的令牌
SET    lock:order:1001 token-7 NX EX 30
```

写入数据时,把令牌一起带过去:

```sql
UPDATE orders
SET status = 'PAID', lock_token = 7
WHERE id = 1001 AND lock_token < 7;   -- 只接受比已记录更新的令牌
```

这样即使 A 在第 40 秒才姗姗来迟地提交,它的令牌是 7;而 B 已经用令牌 8 写过了,`lock_token < 7` 不成立,更新影响 0 行,A 的过期写入被丢弃。

> 锁只能保证"在锁有效期内互斥",它无法撤销一个已经发生的事实。**fencing token 把"互斥"的责任从锁转移给了被保护的资源**,这才是真正严密的做法。

代价是要改造下游存储(加一列、改条件),所以它通常用在对数据正确性零容忍的路径上,比如资金流水。

## 六、Redis 锁的天然缺陷:主从切换

前面所有讨论都假设了一件事:**锁是可靠的**。但 Redis 默认的主从复制是异步的,这就留下一个窗口:

```
① 客户端 A 向 master 写入 lock:order:1001,成功
② master 还没来得及把这条命令同步给 slave
③ master 宕机,哨兵把 slave 提升为新 master
④ 新 master 上没有这把锁 → 客户端 B 加锁成功
   ↓
A 和 B 同时持有"同一把锁"
```

这个窗口很小,但问题是**它不依赖于操作出错,是架构本身的固有属性**。

Redis 官方文档提到过这个风险,也给出了主从全同步(`WAIT` 命令)等缓解手段,但代价是延迟上升。针对这个缺陷出现过 RedLock 算法(向多个独立 master 分别加锁,多数派成功才算成功),但它的有效性在社区长期存在争议——核心质疑正是 fencing token 那一节说的:**锁服务本身不能阻止一个停顿很久的客户端在锁过期后继续写入**,RedLock 并没有比单节点锁更好地解决这一点。

实际选型时可以按可靠性要求分档:

| 方案 | 一致性保证 | 性能 | 适用场景 |
|---|---|---|---|
| Redis 单节点 `SET NX EX` | 主从切换可能丢锁 | 最高 | 幂等任务、防重复执行等容忍偶发失效的场景 |
| Redis + 看门狗 | 同上,但减少超时失锁 | 高 | 业务耗时波动大的临界区 |
| ZooKeeper 临时顺序节点 | CP,session 断开即释放 | 中 | 要求不丢锁的场景 |
| etcd / 共识协议 | CP,基于 lease + revision | 中 | 同上,云原生环境常见 |
| Redis 锁 + fencing token | 逻辑上可防过期写入 | 高 | 资金、库存等正确性敏感路径 |

一句话:**Redis 锁适合"锁失效一次代价可接受"的场景;对正确性零容忍的路径,要么上共识型锁服务,要么自己加令牌兜底。**

## 七、Redisson 到底封装了什么

自研锁的问题不是写不出来,而是边界条件太多、每个都要单独测。Redisson 是一个 Redis 的 Java 客户端库,`RLock` 只是它众多分布式组件之一:

| 能力 | 自研需要自己处理 | Redisson 提供 |
|---|---|---|
| 原子加锁 | `SET NX EX` + 唯一标识 | `tryLock()` |
| 安全释放 | Lua 比对 value 再删 | `unlock()` |
| 锁续期 | 自己写调度线程 | Watchdog,默认 30s / 每 10s 续 |
| 可重入 | 自己用 Hash 维护计数 | 原生支持 |
| 阻塞等待 | 自己轮询重试 | `tryLock(waitTime, leaseTime, unit)` |
| 公平锁 | 自己用 List + 通知 | `getFairLock()` |
| 读写锁 | 几乎要重写一套 | `getReadWriteLock()` |

需要强调的是:**Redisson 是搬运工,不是发明家。** 它把「读-判断-写」这段逻辑用 Lua 脚本发到服务端执行,原子性来自 Redis 单线程执行脚本这个特性,而不是 Java 客户端。选它不等于绕开了原子性问题,只是把"自己写脚本"换成了"调用封装"。

典型用法:

```java
@Resource
private RedissonClient redisson;

public void createOrder(String orderNo) {
    RLock lock = redisson.getLock("lock:order:" + orderNo);
    boolean locked = false;
    try {
        // 最多等 3 秒;不传 leaseTime,交给看门狗
        locked = lock.tryLock(3, TimeUnit.SECONDS);
        if (!locked) {
            throw new BizException("系统繁忙,请稍后重试");
        }
        doCreateOrder(orderNo);
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();       // 恢复中断标记,别吞掉
        throw new BizException("获取锁被中断");
    } finally {
        // 关键:只有自己持有锁时才解锁,且要判断是否还被当前线程持有
        if (locked && lock.isHeldByCurrentThread()) {
            lock.unlock();
        }
    }
}
```

`unlock()` 放在 `finally` 里是常识,但**加 `isHeldByCurrentThread()` 判断**经常被漏掉:如果 `tryLock` 超时返回 false,或者锁已经被看门狗之外的原因释放,直接 `unlock()` 会抛 `IllegalMonitorStateException`,把真正的业务异常盖掉。

## 小结

- `SETNX` + `DEL` 的原始版本有两个硬伤:**宕机死锁**和**误删别人的锁**,不能上线
- 加锁必须合并成一条 `SET key value NX EX ttl`,value 存**唯一标识**,它决定了后面能不能安全解锁
- 释放锁不能先查再删,判断和删除之间也有竞态,必须交给 **Lua 脚本**在服务端一次完成
- 锁过期而业务没跑完,是分布式锁最本质的矛盾;**看门狗**用 1/3 TTL 的周期续期来缓解,但传了 `leaseTime` 就会关掉它
- 续期依赖客户端存活,长 GC 照样可能失锁;要彻底防住过期写入,用**单调递增的 fencing token** 让下游资源自己拒绝旧持有者
- Redis 主从异步复制决定了**主从切换可能丢锁**,这是架构层面的缺陷;对不丢锁有硬要求的场景,考虑 ZooKeeper / etcd,或接受 Redis 锁 + 令牌兜底
- 生产上直接使用成熟的封装,但要清楚它内部仍然是 **Lua 脚本 + 看门狗**,原子性来自 Redis 本身
