---
title: ES 与 MySQL 的数据一致性方案
date: 2026-03-17
description: 业务只写 MySQL，用消息队列异步写 ES，这条链路从生产到消费每一环都可能丢数据。这篇按生产、传输、消费三个阶段拆解本地消息表、Confirm、手动 ACK、幂等与乱序治理，并给出定时对账兜底方案。
tags: [Elasticsearch, 数据一致性, 消息队列, 幂等]
category: Elasticsearch
---

## 一、为什么不能双写

把数据同时写进 MySQL 和 ES，最直觉的写法是：

```java
// ❌ 看起来对称，实际不成立
mysql.insert(sku);
es.index(sku);
```

这段代码的问题在于**两个写操作不在同一个事务里**，任何一个失败都会留下不一致：

| 失败位置 | 结果 |
|---|---|
| MySQL 成功、ES 失败 | 数据库有新数据，搜不到 |
| MySQL 失败、ES 成功 | 搜得到，但点进去 404 |
| MySQL 成功、发 ES 请求前宕机 | ES 完全没有这条数据 |
| 先写 ES 后写 MySQL，MySQL 失败 | ES 里有一条脏数据 |

更麻烦的是重试。给两个写操作都加重试，会出现「MySQL 写成功、ES 写成功、但客户端超时又重试一次」，如果没有幂等键，ES 里就多了一条重复文档。

所以基本结论是：**业务只写 MySQL，通过消息队列异步通知消费者写 ES。** MySQL 是事实源，ES 只是查询侧的副本，可以慢一点、可以重建，但不能成为业务正确性的依赖。

但从「发一条消息」到「ES 里真的有一条数据」，中间要跨过三个阶段，每个阶段都有丢数据的可能。

## 二、整体架构流程

```
[业务系统] 
   │ 1. 开启本地事务
   │ 2. 写 MySQL (业务表 + 本地消息表)
   │ 3. 提交本地事务
   ▼
[定时任务/异步线程] 
   │ 4. 读取本地消息表，发送 MQ
   ▼
[RabbitMQ] 
   │ 5. 持久化存储
   │ 6. 消费者确认 (ACK)
   ▼
[消费者服务] 
   │ 7. 接收消息，写入 ES
   │ 8. 处理成功，手动 ACK
```

这张图的关键在于：**发消息这件事被拉进了数据库事务里**。第 1 到 3 步是一个原子操作，业务数据和「待发送的消息记录」要么都成功、要么都失败，不存在「写完库还没来得及发消息就宕机」的中间状态。

## 三、生产者端：怎么保证消息一定发出去

### 本地消息表

流程：

1. 开启 MySQL 事务
2. 执行业务 SQL（比如 `INSERT INTO sku ...`）
3. **同时**往本地消息表插入一条记录，状态为「待发送」
4. 提交事务
5. 由单独的定时任务或异步线程扫描本地消息表，把「待发送」的消息投递给 RabbitMQ
6. 发送成功后，把该记录更新为「已发送」或直接删除

```sql
CREATE TABLE local_message (
    id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    biz_type     VARCHAR(32)  NOT NULL COMMENT '业务类型，如 sku_upsert',
    biz_id       BIGINT       NOT NULL COMMENT '业务主键，用于幂等',
    payload      TEXT         NOT NULL COMMENT '消息体',
    status       TINYINT      NOT NULL DEFAULT 0 COMMENT '0待发送 1已发送',
    retry_count  INT          NOT NULL DEFAULT 0,
    next_retry_at DATETIME    NOT NULL COMMENT '下次重试时间，退避用',
    create_time  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_status_next (status, next_retry_at)
) COMMENT '本地消息表';
```

好处是**完美保证业务与消息的原子性**：即使发 MQ 失败，定时任务会不断重试，最终一定能发出去。代价是消息会延迟一小段时间（取决于扫描频率），而且本地消息表本身会成为业务库的一部分，需要定期归档。

`idx_status_next` 这个联合索引是必须的。定时任务按 `status = 0 AND next_retry_at <= now()` 捞数据，没有索引时会全表扫，消息表涨到百万级就变成慢查询。

### RabbitMQ 的 Confirm 机制

RabbitMQ 提供 `publisher-confirm` 模式：

- 消息发给 Broker，Broker 收到后异步回调一个 ACK
- 收到 ACK，说明 MQ 服务器收到了
- 收到 NACK 或超时，需要在代码里重试

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated   # 开启异步确认
    publisher-returns: true              # 路由失败时回调
    template:
      mandatory: true                    # 无法路由的消息不静默丢弃
```

要清楚 Confirm 的边界：**它只能保证 Broker 收到了，不能保证消费者消费了**。所以 Confirm 通常和本地消息表配合使用，而不是替代它。另外 `publisher-returns` 和 `mandatory` 要一起开，否则消息路由不到任何队列时会被静默丢弃，Confirm 那边可能还返回成功。

## 四、Broker 端：怎么保证消息不丢

消息到了 RabbitMQ，如果 Broker 挂了，内存里的消息就没了：

| 措施 | 做法 | 防的是什么 |
|---|---|---|
| 交换机持久化 | 声明 Exchange 时 `durable=true` | 重启后交换机元数据丢失 |
| 队列持久化 | 声明 Queue 时 `durable=true` | 重启后队列消失 |
| 消息持久化 | 发送时 `delivery_mode=2` | 重启后消息内容丢失 |
| 备份交换机 | 绑定 Alternate Exchange | 消息无法路由时被静默丢弃 |

前三项要同时配，缺一项都不算持久化——交换机持久化但队列不持久化，重启后队列没了，消息照样丢。

## 五、消费者端：丢消息、重复消费、乱序

消费者是真正写 ES 的地方，三个问题要分别处理。

### 手动 ACK

**绝对不要用自动 ACK。** 消费者拿到消息、刚准备写 ES，服务突然重启，自动 ACK 已经告诉 MQ 消费成功了，这条消息就永久丢了。

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        acknowledge-mode: manual
        prefetch: 20        # 每个消费者预取上限，避免消息全压在一个实例上
```

```java
@RabbitListener(queues = "sku.sync.queue")
public void onMessage(SkuMessage msg, Channel channel,
                      @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
    try {
        esService.upsert(msg);          // ① 先写 ES
        channel.basicAck(tag, false);   // ② 写成功才 ACK
    } catch (RetryableException e) {
        // 网络抖动、ES 短暂不可用 → 重新入队，稍后重试
        channel.basicNack(tag, false, true);
    } catch (Exception e) {
        // 数据本身有问题（如字段类型不符）→ 死信队列，避免无限重试堵住队列
        channel.basicNack(tag, false, false);
    }
}
```

这里的分类很重要：**可重试异常重新入队，不可重试异常进死信队列**。如果所有异常都 `requeue=true`，一条脏消息会被反复投递，把队列堵死，后面的正常消息全被卡住——这比丢一条消息严重得多。

另外要注意 `basicAck` 必须放在写 ES 成功之后，且 `basicNack` 的第三个参数（requeue）决定消息去向，写错一个布尔值就是另一个故事。

### 幂等：用 MySQL 主键做 ES 文档 ID

网络抖动会让 MQ 以为没消费成功，把同一条消息发两次。如果写 ES 用的是 `POST`（自动生成 ID），ES 里就会出现两条一模一样的文档。

**解法是把 MySQL 的主键作为 ES 文档的 `_id`**：

```
PUT /sku/_doc/10086
{
  "title": "智能洗地机 X1",
  "brand": "品牌A",
  "price": 2999.00,
  "update_time": "2026-03-17T10:00:00"
}
```

ES 的内部机制是：这个 ID 存在就覆盖更新，不存在就新建。天然幂等，重复消费多少次结果都一样，不需要额外的去重表。

这个做法还有个附带好处：**文档 ID 与业务主键一一对应**，排查问题时可以直接用商品 ID 去 ES 里 `GET`，不用先查一次数据库拿 `_id`。

### 乱序：旧数据覆盖新数据

考虑这个场景：用户先把商品名改成「A」，几秒后又改成「B」。因为 MQ 是异步的，写「B」的消息先到了 ES，写「A」的消息后到，ES 里的名字最终变成了「A」——**旧值覆盖了新值**。

两种解法：

**解法 A：按业务主键 Hash 路由到同一队列。** RabbitMQ 保证单队列 FIFO，只要保证同一个商品的变更消息都进同一个队列，这个商品的变更就是严格有序的。

```java
@Bean
public Queue skuQueue() {
    return QueueBuilder.durable("sku.sync.queue")
            .withArgument("x-queue-type", "quorum")   // 仲裁队列，持久性更强
            .build();
}
```

注意这个方案的作用范围：它只能保证**单个商品内部有序**。如果同一商品的消息被路由到不同队列（比如扩容时改了 Hash 函数），有序性就没了。而且单队列有序意味着并行度受限——队列数决定了消费的并行上限。

**解法 B：数据版本号（更推荐）。** 在 MySQL 里加 `update_time` 或 `version` 字段，消费者写 ES 前先比较版本：

```java
// 伪代码：先读 ES 当前版本，再决定是否更新
Long esVersion = esService.getVersion(msg.getId());
if (msg.getVersion() > esVersion) {
    esService.upsert(msg);
} else {
    // 消息比 ES 里的数据还旧，直接忽略
    log.warn("stale message ignored, id={}, msgVersion={}, esVersion={}",
             msg.getId(), msg.getVersion(), esVersion);
}
```

这个「先读再写」有竞态窗口，更严谨的做法是让 ES 自己判断。ES 原生支持乐观锁：

```
PUT /sku/_doc/10086?if_seq_no=12&if_primary_term=1
{
  "title": "智能洗地机 X1 Pro"
}
```

`if_seq_no` 和 `if_primary_term` 不匹配时 ES 返回 409 冲突，消费者捕获后直接忽略这条消息即可，不需要额外加锁。

| | 解法 A：Hash 路由 | 解法 B：版本号 |
|---|---|---|
| 有序范围 | 同一队列内 | 同一文档内 |
| 并行度 | 受队列数限制 | 不受限 |
| 扩容影响 | 改路由规则会破坏有序性 | 无影响 |
| 实现复杂度 | 低（配置层） | 中（要加字段、处理 409） |
| 适用场景 | 变更频率低、队列数固定 | 并发写多、需要水平扩容 |

`version` 字段必须是**单调递增**的。用数据库自增或单独的版本服务都行，唯一不能做的是用 `update_time` 且精度只到秒——同一秒内的两次更新版本相同，比较就失效了。真要用时间戳，至少精确到毫秒。

## 六、兜底：定时对账

即使上面所有机制都做对了，代码 Bug、网络分区、磁盘写满依然会导致极个别的数据不一致。所以**所有保证最终一致性的系统，都必须有一个定时对账机制**。

- **时机**：每天凌晨业务低峰期
- **扫描范围**：MySQL 中 `update_time` 在 24 小时前的记录，或者对比 MySQL 与 ES 的数据条数、关键字段
- **处理**：发现不一致就重新发一条 MQ 消息，或者直接调 ES API 强制覆盖

```sql
-- 找出最近一天变更过的记录，逐条与 ES 比对
SELECT id, title, brand, price, update_time
FROM sku
WHERE update_time >= DATE_SUB(NOW(), INTERVAL 1 DAY);
```

对账要注意三件事：

1. **不要全量扫**。按 `update_time` 增量比对比全量比对快几个数量级，全量对账只适合数据量小或索引刚重建完的场景。
2. **对账本身要能观测**。把不一致条数、修复条数、耗时打成指标，趋势突然抬升说明上游同步链路出问题了，这比单次修复更有价值。
3. **ES 里多出来的文档也要处理**。对账通常只检查「MySQL 有、ES 没有或不对」，但 MySQL 删掉的记录如果消息丢了，ES 里会留一条永远查不到的幽灵文档。可以按 `_id` 反向抽样校验。

## 七、三个阶段的故障对照

把整条链路的失效点列出来，能更清楚地看到每个机制在防什么：

| 阶段 | 故障 | 对应机制 |
|---|---|---|
| 生产 | 写完库没发消息就宕机 | 本地消息表（与业务事务同提交） |
| 生产 | 消息发了但 Broker 没收到 | Confirm + 定时重扫待发送记录 |
| 传输 | Broker 重启后消息丢失 | 交换机/队列/消息三重持久化 |
| 传输 | 消息路由不到任何队列 | 备份交换机 + `mandatory` |
| 消费 | 拿到消息还没写 ES 就重启 | 手动 ACK（写完才 ACK） |
| 消费 | 同一条消息投递两次 | 用 MySQL 主键做 ES `_id` |
| 消费 | 旧变更覆盖新变更 | Hash 路由 或 `version` + `if_seq_no` |
| 全部 | 无法预料的 Bug 与故障 | 定时对账 |

## 小结

- 不要双写 MySQL 和 ES，两个写操作不在同一事务里，任何一步失败都会留下不一致
- 正确方向是**业务只写 MySQL，用 MQ 异步同步到 ES**，MySQL 是事实源，ES 是可重建的副本
- 生产者端用**本地消息表**把「发消息」变成数据库事务的一部分，保证业务与消息的原子性
- Confirm 只保证 Broker 收到，**不保证消费者消费**，要和本地消息表配合而不是替代它
- Broker 端三重持久化（交换机、队列、消息）必须同时配，另加备份交换机防静默丢弃
- 消费者端用手动 ACK，**写完 ES 才 ACK**；可重试异常重新入队，脏数据进死信队列
- 幂等靠 **MySQL 主键作为 ES 的 `_id`**，PUT 天然幂等，不需要额外去重表
- 乱序有两种解法：按业务主键 Hash 路由到同一队列（受并行度限制），或加单调递增 `version` 配合 `if_seq_no` / `if_primary_term`（推荐）
- 所有最终一致性系统都需要**定时对账**兜底，并把它做成可观测指标而不只是修复脚本
