---
title: 分布式事务与 Seata 的 AT/XA 模式
date: 2026-03-15
description: 分布式事务的难点从来不是「怎么提交」,而是「怎么回滚」和「怎么隔离」。这篇对比 XA、AT、TCC、SAGA 四种模式的原理与代价,重点拆解 Seata AT 模式的两阶段流程、undo_log 补偿机制和它无法回避的脏写风险。
tags: [微服务, 分布式事务, Seata, 一致性]
category: 微服务
---

## 一、先界定问题

一个业务操作要跨两个服务完成:订单服务创建订单,库存服务扣减库存。两个服务各自有独立的数据库。

单机时代,这件事用 `@Transactional` 一行注解就解决了——同一个数据库连接、同一个事务,要么全成功要么全回滚。拆成微服务之后,这条注解失效了:

```
订单服务: BEGIN → INSERT order → COMMIT   ✅ 成功
库存服务: BEGIN → UPDATE stock → ???      ❌ 这里挂了怎么办?
```

订单已经提交了,库存没扣。数据不一致。

**分布式事务的定义**:一个业务操作需要多个服务协作完成,每个服务有自己的本地事务,这些本地事务必须**同时成功或同时失败**。整体叫全局事务,其中每个服务的事务叫分支事务。

这里有个关键认知要先建立:

> **分布式事务真正的难点不是「怎么让它们一起提交」,而是「已经提交的本地事务怎么撤销」。**

本地事务一旦提交,数据库层面就没有退路了。所有分布式事务方案的本质,都是在回答同一个问题:**提交之后反悔,靠什么把数据改回去?** 四种主流模式的差异,全部源于对这个问题的不同回答。

## 二、Seata 的三个角色

Seata 把分布式事务拆成三个角色:

| 角色 | 全称 | 职责 |
|---|---|---|
| **TC** | Transaction Coordinator | 事务协调者,独立部署的服务端。维护全局事务状态,驱动分支的提交和回滚 |
| **TM** | Transaction Manager | 事务管理器,发起全局事务的一方。开启全局事务、提交或回滚全局事务 |
| **RM** | Resource Manager | 资源管理器,管理分支事务。向 TC 注册分支、上报状态、执行回滚 |

一次完整的执行流程:

```
TM(订单服务)           TC(Seata Server)          RM(库存服务)
     │                        │                        │
     │── 开启全局事务 ───────→ │ 生成全局唯一 XID       │
     │←───────── XID ────────│                        │
     │                                                 │
     │── 调用库存服务(带 XID) ────────────────────────→ │
     │                        │←── 注册分支事务 ───────│
     │                        │←── 上报分支状态 ───────│
     │                        │                        │
     │── 提交/回滚全局事务 ──→ │                        │
     │                        │── 通知各分支提交/回滚 →│
```

XID 是整个链路的纽带。它通过 RPC 上下文在服务之间传递,让每个参与的数据库操作都能被追溯到同一个全局事务。

## 三、四种模式的核心差异

### XA 模式:数据库原生两阶段提交

XA 是 X/Open 组织定义的分布式事务规范,由数据库厂商实现。它把提交拆成两个阶段:

**阶段一(Prepare)**:各分支执行 SQL,但**不提交**,数据库把事务挂起并持有行锁。
**阶段二(Commit/Rollback)**:TC 收集完所有分支的 Prepare 结果,如果全部成功就通知全部 Commit,任何一个失败就通知全部 Rollback。

```
阶段一:  RM1: UPDATE stock ...  (Prepare,持锁不提交)
         RM2: INSERT order ...   (Prepare,持锁不提交)

         全部 Prepare 成功?
                 ↓ 是
阶段二:  TC → RM1: COMMIT   → 真正落库,释放锁
         TC → RM2: COMMIT   → 真正落库,释放锁
```

**优点**:强一致性。数据要么全提交要么全回滚,不存在中间状态,本质上把单机事务的语义扩展到了多库。

**缺点**:锁持有时间太长。从阶段一 Prepare 到阶段二 Commit 之间,数据库行锁一直被占着。如果某个分支的 Prepare 慢,或者 TC 通知阶段二时有延迟,这条记录会被锁上几百毫秒甚至更久——**其他事务全部阻塞等待**。这个锁是数据库层面的真实行锁,不像应用层锁那么好优化。并发一高,锁等待会迅速演变成连接池耗尽。

### AT 模式:Seata 自研的自动补偿

AT 模式是 Seata 最常用的模式,它的思路完全不同——**不强求一起提交,而是各自先提交,失败时靠反向补偿回滚**。

**阶段一**:执行业务 SQL,同时记录前后镜像到 `undo_log` 表,然后**直接提交本地事务**。

```
① 解析 SQL,得到表名、条件、类型
② 查询前镜像:  SELECT * FROM stock WHERE id = 1  →  available = 100
③ 执行业务 SQL: UPDATE stock SET available = 99 WHERE id = 1
④ 查询后镜像:  SELECT * FROM stock WHERE id = 1  →  available = 99
⑤ 把前后镜像写入 undo_log 表
⑥ 申请全局锁 → 提交本地事务(业务数据和 undo_log 一起提交)
```

**阶段二 - 提交**:异步删除 `undo_log` 记录,几乎不占时间。

**阶段二 - 回滚**:根据 `undo_log` 里的前镜像生成反向 SQL,把数据改回去。

```sql
-- undo_log 里存的 rollback_info(简化)
{
  "beforeImage": { "tableName": "stock", "rows": [{ "id": 1, "available": 100 }] },
  "afterImage":  { "tableName": "stock", "rows": [{ "id": 1, "available": 99 }] },
  "sqlType": "UPDATE"
}

-- 回滚时执行的反向 SQL
UPDATE stock SET available = 100 WHERE id = 1;
```

**优点**:本地事务一阶段就提交,数据库行锁立刻释放,并发性能远好于 XA。业务代码零侵入,加个 `@GlobalTransactional` 注解就行。

**缺点**:放弃了强一致性。一阶段提交后,数据在全局事务结束前是**对其他事务可见的**,默认隔离级别只相当于「读未提交」。这是 AT 模式最大的代价。

### TCC 模式:Try-Confirm-Cancel

TCC 把业务逻辑拆成三个方法,由开发者自己实现:

| 阶段 | 方法 | 做什么 |
|---|---|---|
| 一阶段 | Try | **资源预留**。冻结库存、预扣余额,而不是直接扣减 |
| 二阶段-成功 | Confirm | 确认使用预留资源。冻结转实扣 |
| 二阶段-失败 | Cancel | 释放预留资源。解冻、退款 |

以扣库存为例:

```java
// Try:不真扣,只冻结
public boolean tryDeduct(Long skuId, int qty) {
    // UPDATE stock SET frozen = frozen + qty
    // WHERE sku_id = ? AND available - frozen >= qty
    return stockMapper.freeze(skuId, qty) > 0;
}

// Confirm:冻结转实扣
public boolean confirmDeduct(Long skuId, int qty) {
    // UPDATE stock SET available = available - qty, frozen = frozen - qty
    return stockMapper.confirmFreeze(skuId, qty) > 0;
}

// Cancel:解冻
public boolean cancelDeduct(Long skuId, int qty) {
    // UPDATE stock SET frozen = frozen - qty
    return stockMapper.unfreeze(skuId, qty) > 0;
}
```

**优点**:不依赖数据库事务,**隔离性最好**。资源在 Try 阶段就被预留了,别人拿不走也不可见,不存在脏读问题。而且不局限于数据库——调用外部接口、发消息都能纳入事务。

**缺点**:**开发成本最高**,每个参与者都要写三个方法。而且 Try、Confirm、Cancel 三个方法都必须**幂等**(网络重试会导致重复调用),还要处理**空回滚**(Try 没执行,Cancel 却来了)和**悬挂**(Cancel 先于 Try 到达)。这三个问题每一个都是坑。

### SAGA 模式:长事务的事件驱动

SAGA 把一个长事务拆成一串本地事务 T1、T2、…、Tn,每个都直接提交。失败时反向执行补偿操作 Cn、…、C1。

```
正常:  T1 → T2 → T3 → T4  ✅
失败:  T1 → T2 → T3 ✗
       ↓ 反向补偿
       C2 ← C1        (T3 失败,T3 本身没提交,补偿 T2 和 T1)
```

**优点**:适合**长流程、跨系统**的业务,比如旅游订票(机票 + 酒店 + 租车),每一步可能耗时几分钟甚至几天。没有锁,吞吐最高。

**缺点**:完全没有隔离性,中间状态全程对外可见。补偿逻辑必须自己实现,而且**补偿不一定能成功**——如果补偿也失败,就需要人工介入。

### 四种模式横向对比

| 维度 | XA | AT | TCC | SAGA |
|---|---|---|---|---|
| 一致性 | **强一致** | 最终一致 | 最终一致 | 最终一致 |
| 隔离性 | 好(数据库行锁) | **差(读未提交)** | **好(资源预留)** | 无 |
| 一阶段锁 | 数据库行锁,持有到二阶段 | 本地行锁立即释放,**全局锁持有到全局事务结束** | 无锁,靠资源预留 | 无锁 |
| 业务侵入 | 无 | **无**(注解即可) | 高(三个方法) | 中(补偿逻辑) |
| 性能 | 低 | 中高 | 高 | 高 |
| 回滚方式 | 数据库回滚 | **undo_log 反向补偿** | Cancel 接口 | 反向补偿事务 |
| 适用场景 | 短事务、强一致要求 | 大多数业务场景 | 高隔离要求、非数据库资源 | 长流程、跨系统 |

选型的基本判断:

- 业务能接受最终一致 → 优先 **AT**,开发成本最低
- 一阶段就要隔离资源(比如秒杀扣库存) → 用 **TCC**
- 流程跨越多个系统、耗时很长 → 用 **SAGA**
- 必须强一致且事务很短 → 才考虑 **XA**

## 四、AT 模式的三个坑

### 1. 全局锁持有时间 = 全局事务持续时间

AT 模式里有两把锁,一定要分清楚:

| | 本地锁(数据库行锁) | 全局锁(Seata 维护) |
|---|---|---|
| 谁管的 | 数据库 | TC |
| 何时释放 | **本地事务提交时立即释放** | **全局事务提交/回滚时才释放** |
| 存在哪里 | 数据库锁表 | TC 内存 + 数据库表 `lock_table` |
| 作用 | 防本地并发写 | **防「写了又被回滚掉」的脏写** |

全局锁的申请时机在 Seata 官方文档里写得很明确:**「一阶段本地事务提交前,需要确保先拿到全局锁」**。拿不到全局锁,就不能提交本地事务。

所以:**事务边界划多大,这把全局锁就持有多久。** 这一条是 AT 模式性能的决定性因素,下一篇文章会用实测数据展开。

### 2. 脏写风险

全局锁能防住大多数脏写,但防不住所有情况。典型场景:

```
事务 A: 读到 stock.available = 100,执行 UPDATE 改为 99,拿到全局锁,提交本地事务
外部操作(不经过 Seata):UPDATE stock SET available = 50 WHERE id = 1
事务 B 回滚:undo_log 里的后镜像是 99,但当前值是 50 → 不一致!
```

Seata 的处理方式是**回滚前先比对后镜像**:用 `undo_log` 里的 afterImage 和当前数据库的值做比较,不一致就抛异常告警,不强行回滚。

这是个诚实的设计——它承认了「无法自动处理」,把决定权交给人。**强行回滚会把别人的修改覆盖掉,造成更严重的数据损坏;停下来告警虽然打断了自动化流程,但至少不会把数据改坏。**

### 3. TC 是新的单点

所有分支都要向 TC 注册、申请全局锁、上报状态。TC 挂了会怎样?

- **正在运行的全局事务**:无法提交也无法回滚,只能等 TC 恢复。超时后会被回滚
- **新的全局事务**:完全无法开启

所以**TC 必须集群部署 + 高可用**。Seata Server 的集群模式依赖一个共享存储(通常是数据库)来保存全局事务会话,多个 TC 节点通过数据库行锁竞争来协调。

## 五、AT 模式的基本接入

```xml
<!-- 引入依赖 -->
<dependency>
    <groupId>io.seata</groupId>
    <artifactId>seata-spring-boot-starter</artifactId>
    <version>1.7.0</version>
</dependency>
```

```yaml
seata:
  enabled: true
  application-id: order-service
  tx-service-group: my_tx_group        # 事务分组,TC 按这个找集群
  service:
    vgroup-mapping:
      my_tx_group: default             # 分组到 TC 集群的映射
  registry:
    type: nacos
    nacos:
      server-addr: 192.168.1.10:8848
      application: seata-server
```

每个参与事务的数据库都要建 `undo_log` 表:

```sql
CREATE TABLE `undo_log` (
  `id`            bigint(20)   NOT NULL AUTO_INCREMENT,
  `branch_id`     bigint(20)   NOT NULL,
  `xid`           varchar(100) NOT NULL,
  `context`       varchar(128) NOT NULL,
  `rollback_info` longblob     NOT NULL,
  `log_status`    int(11)      NOT NULL,
  `log_created`   datetime     NOT NULL,
  `log_modified`  datetime     NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_undo_log` (`xid`, `branch_id`)   -- 保证同一分支只写一条
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

业务代码只需要一个注解:

```java
@GlobalTransactional(rollbackFor = Exception.class, timeoutMills = 30000)
public void createOrder(OrderDTO dto) {
    orderMapper.insert(buildOrder(dto));       // 分支 1:本地事务
    stockClient.deduct(dto.getSkuId(), 1);     // 分支 2:远程调用,自带 XID
    // 抛异常 → TM 通知 TC → TC 驱动所有分支回滚
}
```

`timeoutMills` 一定要设。没有超时的全局事务会在 TC 端无限期挂着,全局锁也一直不释放——一旦某个分支卡住,整条业务线都会被拖住。

## 六、什么时候不该用分布式事务

这是最需要克制的部分。看到「跨服务」就上 Seata 是很常见的误区,代价是引入了 TC 这个新单点、增加了全局锁的串行点、拉长了请求链路。

判断标准很简单:**这件事真的需要原子性吗?**

| 场景 | 该用什么 |
|---|---|
| 订单创建 + 库存锁定 | ✅ 需要原子性,用 Seata AT |
| 支付成功 + 发放积分 | ❌ 允许延迟,用 MQ 最终一致 |
| 下单 + 发送通知 | ❌ 通知丢了可以重发,用 MQ |
| 下单 + 更新搜索索引 | ❌ 索引晚几秒无所谓,用 MQ |
| 转账扣款 + 入账 | ✅ 需要原子性,但通常是同库同事务 |

大量的「跨服务一致性」需求,本质上**根本不需要强一致**,只是需要一个「消息一定会被处理」的保证。这类场景用本地消息表或事务消息,成本远低于分布式事务,而且没有全局锁这个性能瓶颈。

一个务实的经验法则:

> **能用本地事务解决就不用分布式事务;能用最终一致就不用强一致;只有「同一时刻必须原子完成」的那一小段,才值得付出 Seata 的代价。**

## 七、小结

- 分布式事务的难点是**已提交的本地事务怎么撤销**,四种模式的差异全在于对这个问题的回答
- 三大角色:**TC 协调、TM 发起、RM 管理分支**,它们靠全局唯一 XID 串联
- **XA 靠数据库原生两阶段提交**,强一致但行锁持有时间长,并发差
- **AT 一阶段就提交本地事务**,靠 `undo_log` 的前后镜像反向补偿,业务侵入低是它最大的优势
- **TCC 靠资源预留获得最好的隔离性**,代价是要实现 Try/Confirm/Cancel 三个方法并处理幂等、空回滚、悬挂
- **SAGA 适合长流程**,没有隔离性,补偿逻辑要自己写
- AT 模式的两把锁要分清:**本地行锁提交即释放,全局锁持有到全局事务结束**——这是它性能的决定因素
- 脏写风险靠**回滚前比对后镜像**来发现,发现不一致就告警人工介入,不强行回滚
- **TC 是新的单点**,必须集群部署
- 大多数「跨服务一致性」需求用 MQ 最终一致就够,**不要看到一个跨服务调用就上分布式事务**

模式选对了只是第一步。真正决定这套方案在生产环境跑得好不好的,是**事务边界划在哪里**——这是下一篇要讲的事。
