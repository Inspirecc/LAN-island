---
title: 消息幂等:重复消费的五种解法
date: 2026-03-06
description: MQ 只能保证「至少一次」投递,所以重复消费是必然发生的。这篇把五种幂等方案(ID+去重表、唯一约束、SETNX、状态机、天然幂等)拆开对比,并说明生产环境为什么最终常常落到「唯一约束 + 状态机」的组合。
tags: [消息队列, 幂等, 分布式]
category: 消息队列
---

## 一、重复不是 Bug,是协议的一部分

新手常有的期待是:「消息重复了,是不是 MQ 配置错了?」

不是。**「至少一次(at-least-once)」是绝大多数 MQ 的投递语义,重复消费是它正常工作的一部分。** 回顾一下消息可靠性的设计:为了让消息不丢,几乎所有环节都被做成了「失败就重试」——

| 环节 | 为了不丢做的事 | 产生重复的原因 |
|---|---|---|
| 生产者 | 本地消息表定时重扫 | 发送成功但状态更新前崩溃 → 重发 |
| 生产者 | Confirm 超时重试 | 实际已到达,只是确认包丢了 → 重发 |
| Broker | 投递后等 ACK | 消费者 ACK 丢了 → 重投 |
| 消费者 | 业务失败 `requeue=true` | 上一条其实部分成功了 → 重复执行 |

所以结论很直接:**不丢和重复是同一枚硬币的两面。** 想让消息不丢,就必须允许重发;允许重发,就一定会重复。既然丢消息是事故、重复执行只是麻烦,工程上永远选后者,然后**在消费端把麻烦消掉**。

这就是幂等的定位:**它不是可靠性的补充,而是可靠性方案能够成立的前提。**

## 二、幂等的定义要收紧

教科书上的定义是「同一操作执行一次和执行多次,结果相同」。这个定义在工程上太宽,会让人做出错误的判断。

真正要满足的条件其实有两层:

1. **结果相同**:最终业务状态一致;
2. **副作用只发生一次**:短信只发一条、库存只扣一次、账只记一笔。

第 2 条才是关键。举一个反例:

```java
// ❌ 看起来"重复执行结果一样",其实不是幂等
public void handle(OrderEvent event) {
    accountMapper.addBalance(event.getUserId(), event.getAmount());   // 累加
    smsService.send(event.getUserId(), "到账 " + event.getAmount());  // 发短信
}
```

余额累加两次结果不同,短信发两次结果也不同。哪怕把 `addBalance` 改成 `setBalance`,**短信这条副作用依然会重复**。

所以下面所有方案都要围绕一个问题:**用什么机制来识别"这件事已经做过了"?**

## 三、五种方案

### 方案一:全局唯一 ID + 去重表

最基本、最通用的做法。生产者发消息时带上一个全局唯一的 `msgId`,消费者处理前先检查这个 ID 是否出现过。

```java
@RabbitListener(queues = "order.queue")
public void onMessage(Message message, Channel channel) throws IOException {
    long tag = message.getMessageProperties().getDeliveryTag();
    String msgId = message.getMessageProperties().getMessageId();

    try {
        // 1. 先试着"占坑":插入成功说明第一次来,插入冲突说明重复
        dedupMapper.insert(new DedupRecord(msgId, new Date()));

        // 2. 只有占坑成功才执行业务
        orderService.handle(JSON.parseObject(message.getBody(), OrderEvent.class));

        channel.basicAck(tag, false);
    } catch (DuplicateKeyException e) {
        // 已经处理过,直接确认,不要重新入队
        log.warn("重复消息,已忽略 msgId={}", msgId);
        channel.basicAck(tag, false);
    } catch (Exception e) {
        channel.basicNack(tag, false, true);
    }
}
```

要点在于**靠数据库的唯一约束来占坑,而不是靠「先查后插」**。`SELECT` 再 `INSERT` 之间有时间窗口,并发下两个消费者可能同时查到「不存在」,然后都插入成功——去重表本身失效了。让唯一索引来兜底,才不会漏。

去重表需要定期清理,否则会无限膨胀:

```sql
-- 只保留 7 天,超期的记录靠业务本身的状态机兜底
DELETE FROM dedup_record WHERE create_time < DATE_SUB(NOW(), INTERVAL 7 DAY) LIMIT 5000;
```

| 优点 | 缺点 |
|---|---|
| 通用,任何业务都能用 | 多一次写库,消费吞吐下降 |
| 与业务解耦 | 去重表需要清理 |
| 并发安全(靠唯一索引) | 需要生产者保证 `msgId` 全局唯一 |

### 方案二:数据库唯一约束(业务维度)

比方案一更省一层:如果业务表本身就有唯一键,直接用那个键去重,不需要额外的表。

```sql
CREATE TABLE order_item (
    id       BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_no VARCHAR(32) NOT NULL,
    sku_id   BIGINT      NOT NULL,
    quantity INT         NOT NULL,
    UNIQUE KEY uk_order_sku (order_no, sku_id)   -- 天然幂等键
);
```

```java
try {
    orderItemMapper.insert(item);
} catch (DuplicateKeyException e) {
    log.info("订单项已存在,跳过 orderNo={} skuId={}", item.getOrderNo(), item.getSkuId());
}
```

关键区别是:**幂等键要选业务主键,而不是自增 ID 或流水号。**「同一个订单的同一个 SKU 只能有一条明细」是业务规则,把它翻译成唯一索引,数据库就替你做完了并发控制。

### 方案三:Redis SETNX

需要高性能去重时用 Redis。核心命令是 `SET key value NX EX seconds`——一条命令同时完成「不存在才设置」和「设置过期时间」,天然原子。

```java
public void consume(Message message) {
    String msgId = message.getMessageProperties().getMessageId();
    String key = "mq:dedup:" + msgId;

    Boolean first = redisTemplate.opsForValue()
            .setIfAbsent(key, "1", Duration.ofHours(1));      // SET NX EX 3600

    if (Boolean.FALSE.equals(first)) {
        log.warn("重复消息,丢弃 msgId={}", msgId);
        return;                                              // 直接返回,不执行业务
    }

    try {
        orderService.handle(message);
    } catch (Exception e) {
        redisTemplate.delete(key);                           // ⚠️ 关键:失败要删 key
        throw e;                                             // 让消息重新入队
    }
}
```

这里有一行代码是**整个方案成立的关键**:业务执行失败时**必须把 key 删掉**。

如果不删,后果是:

```
1. 消息到达,占坑成功
2. 业务执行抛异常(下游超时)
3. 消息重新入队,重试
4. 重试时发现 key 还在 → 判定为"重复" → 直接丢弃
```

**消息被静默丢掉了,业务永远没执行。** 用去重的机制把消息丢了,这是 Redis 方案最经典的坑。

另外还有几个必须知道的边界:

| 边界 | 说明 |
|---|---|
| 过期时间怎么定 | 必须**大于消息的最大重试窗口**。设 1 小时但重试持续了 3 小时,过期后重复消息会被当成新消息 |
| Redis 挂了怎么办 | 单纯 `SETNX` 方案会退化成「全部放行」。对幂等要求高的业务,应降级到数据库唯一约束 |
| 与 ACK 的顺序 | 必须先落库/落 Redis 再进行业务,不能反过来 |

### 方案四:状态机 / 乐观锁

前三种方案都是「外挂一个去重设施」,这一种是**把幂等做进业务本身**——用状态转移的合法性来挡住重复执行。

订单状态流转是一个天然的状态机:

```
待支付 ──支付──→ 已支付 ──发货──→ 已发货 ──签收──→ 已完成
   │
   └──超时/取消──→ 已取消
```

「已支付」只能从「待支付」迁移过来,这是业务规则。把它写成带条件的更新:

```sql
UPDATE `order`
SET status = 'PAID', pay_time = NOW()
WHERE order_no = '20260306001'
  AND status = 'WAITING_PAY';      -- 只有当前状态合法才更新
```

```java
int affected = orderMapper.pay(orderNo);
if (affected == 0) {
    // 要么订单不存在,要么状态已经变了 → 说明这条消息是重复的,或业务前置条件不满足
    log.info("状态不满足,忽略本条消息 orderNo={}", orderNo);
    return;
}
// 只有真正发生了状态迁移,才做后续副作用
stockService.confirm(orderNo);
smsService.sendPaidNotice(orderNo);
```

`affected == 0` 是这里的关键信号:**它同时表达了「重复消息」和「非法流转」两种情况,而两者的处理方式恰好都是"什么都不做"。**

用 `version` 字段的乐观锁是同一思路的另一种写法:

```sql
UPDATE inventory
SET quantity = quantity - 1, version = version + 1
WHERE sku_id = 1001 AND version = 3;
```

| | 状态机(条件更新) | 乐观锁(version) |
|---|---|---|
| 判断依据 | 业务状态字段 | 版本号 |
| 语义 | 「这个状态迁移合法吗」 | 「数据被别人改过吗」 |
| 失败后重试 | **通常不重试**(状态不对就是不对) | 通常需要重读重试 |
| 适合 | 有明确生命周期的实体 | 通用的并发写保护 |

注意表格里的第三行:**状态机失败时不该重试**。如果订单已经是「已支付」,再重试一万次也还是「已支付」,重试只会浪费资源。这和乐观锁失败要重读重试有本质差别,混淆两者会导致无谓的重复投递。

### 方案五:业务天然幂等

有些操作本身就幂等,不需要额外机制:

| 操作 | 为什么幂等 | 是否真的安全 |
|---|---|---|
| `SET key value` | 覆盖写,结果只与最后的值有关 | ✅ |
| `DELETE WHERE id = 1` | 删不存在的行不报错,结果一致 | ✅ |
| `PUT /index/_doc/{id}` | 指定 ID 的覆盖写入 | ✅ |
| `INSERT` | 每次都新增一行 | ❌ |
| `balance = balance + 100` | 累加 | ❌ |
| 发送短信 / 推送 | 每次都是一条新通知 | ❌ |

生产环境里最有价值的一例,是用**数据库主键作为搜索索引的文档 ID**:

```java
// 消费消息时,用 MySQL 的主键当 ES 的文档 _id
// PUT /product/_doc/10086
// ES 语义:ID 存在则覆盖更新,不存在则新建 → 天然幂等
esClient.index(i -> i
        .index("product")
        .id(String.valueOf(product.getId()))    // ← 关键:指定 ID
        .document(product));
```

对比一下两种写法:

```java
// ❌ POST:ES 自动生成 ID,重放一次就多一条重复文档
POST /product/_doc
{ "id": 10086, "name": "..." }

// ✅ PUT + 指定 ID:重放多少次,最终都只有一条
PUT /product/_doc/10086
{ "id": 10086, "name": "..." }
```

**区别只在于「谁来决定文档 ID」。** 让 ES 随机生成,它就无法判断两条消息说的是不是同一份数据;把业务主键交给它,幂等判断就变成了索引的主键查找,零额外成本。这是所有方案里性价比最高的一个——只要写代码时记得指定 ID。

## 四、五种方案横向对比

| 方案 | 判断依据 | 存储成本 | 性能 | 并发安全 | 适用场景 |
|---|---|---|---|---|---|
| 唯一 ID + 去重表 | `msgId` 是否出现过 | 一张表 + 清理任务 | 中(多一次写) | ✅ 靠唯一索引 | 通用兜底,没有业务唯一键时 |
| 数据库唯一约束 | 业务唯一键 | 零(复用业务索引) | 中 | ✅ | 业务本身有唯一键,如订单号 |
| Redis SETNX | key 是否存在 | 内存 + TTL | **高** | ✅ 靠 SET NX 原子性 | 高吞吐去重,可容忍 Redis 不可用时降级 |
| 状态机 / 乐观锁 | 状态字段 / version | 零 | **高** | ✅ 靠条件更新 | 有明确生命周期的实体 |
| 业务天然幂等 | 操作语义 | 零 | **高** | ✅ | 覆盖写、指定 ID 写入 |

### 选型建议

**优先用后三种,把前两种当作兜底。** 理由:

1. **方案四、五不引入额外组件和存储**,没有网络往返,性能最好;
2. 它们**和业务逻辑长在一起**,不会出现「去重表清了但业务状态还在」的错配;
3. 只有当业务既没有唯一键、又没有状态机可用时(比如「发送一条通知」这种纯副作用操作),才需要去重表或 Redis 来记录「做过了」。

真实系统里最常见的是**组合拳**:

```
Redis SETNX 做第一层快速拦截(挡住绝大部分重复,成本极低)
    ↓ 未命中
数据库唯一约束 / 状态机条件更新做第二层最终判定(权威,不可绕过)
```

Redis 那一层可以容忍失效(比如 Redis 重启导致 key 丢失),因为落到数据库时唯一约束仍然会拦住。反过来只有 Redis 一层是危险的——**Redis 不是权威存储,去重结果必须能在数据库里被复核。**

## 五、三个容易忽略的细节

**1. 去重记录和业务操作要在同一个事务里。** 否则可能出现「去重记录写成功、业务回滚」,下次重试被当成重复消息直接丢弃。用方案一的时候,`dedupMapper.insert` 必须和 `orderService.handle` 共享事务边界。

**2. 重复消息也要 ACK。** 很多实现的错误是在检测到重复时 `nack` 或抛异常,导致消息反复重入队。**判定为重复的正确处理是:确认它、丢掉它**——因为它要表达的意图已经实现了。

**3. 幂等键的选择比幂等机制更重要。** `msgId` 去重挡不住「同一条业务消息被生产者重新生成了一条新 msgId 再发」,而业务唯一键(订单号 + SKU)可以。所以能选业务键时优先选业务键。

## 六、小结

- 重复消费是「至少一次投递」的必然结果,**不丢和重复是一体两面,幂等是可靠性方案成立的前提**
- 幂等要同时满足**结果相同**和**副作用只发生一次**,后者才是难点
- 五种方案:**唯一 ID + 去重表**、**数据库唯一约束**、**Redis SETNX**、**状态机/乐观锁**、**业务天然幂等**
- 去重表靠**唯一索引占坑**,不能「先查后插」;Redis 方案**失败时必须删 key**,否则会把消息丢掉
- 状态机条件更新的 `affected == 0` 同时表示「重复」和「非法流转」,两者都该**忽略而非重试**
- 用 **MySQL 主键作为搜索文档的 `_id`**,把 `POST` 换成 `PUT`,是零成本的自然幂等
- 优先选与业务绑定的方案(唯一约束、状态机、天然幂等),Redis/去重表只作兜底,**且兜底结果要能被数据库复核**
