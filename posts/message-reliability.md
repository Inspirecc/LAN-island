---
title: 消息不丢:生产者、Broker、消费者三端保障
date: 2026-02-28
description: 消息丢失从来不是某一个组件的问题,而是生产、存储、消费三段里任何一段断了都会丢。这篇逐段拆开讲:本地消息表与 Confirm 怎么配合、Broker 要开哪些持久化、消费者为什么必须手动 ACK。
tags: [RabbitMQ, 消息队列, 可靠性]
category: 消息队列
---

## 一、先接受一个前提

讨论「消息会不会丢」之前,得先接受一个事实:**MQ 无法保证消息绝不丢失,只能保证"至少一次"投递。**

AMQP 协议里没有「恰好一次」这种语义,原因很简单:确认消息需要网络往返,而网络往返的确认包本身也可能丢。生产者发出消息、Broker 落盘、消费者处理完,这三个动作跨越了两段网络和两次确认,**任何一段的确认都可能丢失**。

所以工程上的目标不是「消灭丢失」,而是:**把每一段都做成"失败可感知、可重试"**。只要失败能被发现,就有补偿的机会。

按消息的生命周期,丢失点可以精确地归到三段:

```
生产者 ──①──→ Broker(交换机 → 队列 → 磁盘) ──②──→ 消费者 ──③──→ 业务落库
        丢?                                      丢?
```

| 段落 | 典型丢失场景 |
|---|---|
| ① 生产者 → Broker | 业务写完数据库,还没来得及发 MQ 就宕机;交换机不存在;路由不到队列被静默丢弃 |
| ② Broker 内部 | 交换机/队列非持久化,重启后消失;消息非持久化,存在内存里;单节点宕机 |
| ③ Broker → 消费者 | 自动 ACK:消息刚投出去就 ACK 了,业务还没执行,进程重启 → 消息没了 |

下面逐段给方案。

## 二、生产者端:让「发消息」成为事务的一部分

### 问题在哪

最直觉的写法是在事务提交后发消息:

```java
// ❌ 危险:发消息不在事务里
@Transactional
public void createOrder(Order order) {
    orderMapper.insert(order);        // 1. 写库
    rabbitTemplate.convertAndSend(    // 2. 发消息
            "order.exchange", "order.created", order);
}
```

这里有两个独立的失败点:

- **写库成功、发消息失败**:数据库里有订单,下游永远不知道;
- **写库回滚、消息已发出**:下游收到一条不存在的订单。

把它改成「先发消息再提交事务」也不行,只是把错误方向反了过来。**跨系统没有本地事务可用,必须引入中间状态。**

### 方案一:本地消息表(推荐)

核心思路是:**不直接把"发消息"做进业务逻辑,而是把"要发消息"这件事写进数据库,让它和业务数据同生共死。**

```
[业务系统]
   │ 1. 开启本地事务
   │ 2. 写 MySQL(业务表 + 本地消息表,状态=待发送)
   │ 3. 提交本地事务        ← 此时业务与"待发消息"同时落库
   ▼
[定时任务 / 异步线程]
   │ 4. 扫描本地消息表,发送 MQ
   │ 5. 收到 Broker 确认后,状态改为"已发送"
   ▼
[RabbitMQ]
```

表结构大致是这样:

```sql
CREATE TABLE local_message (
    id           BIGINT PRIMARY KEY AUTO_INCREMENT,
    msg_id       VARCHAR(64)  NOT NULL COMMENT '全局唯一,用于幂等',
    exchange     VARCHAR(128) NOT NULL,
    routing_key  VARCHAR(128) NOT NULL,
    payload      TEXT         NOT NULL,
    status       TINYINT      NOT NULL DEFAULT 0 COMMENT '0待发送 1已发送 2已确认',
    retry_count  INT          NOT NULL DEFAULT 0,
    next_retry_at DATETIME    NOT NULL,
    create_time  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_msg_id (msg_id),
    KEY idx_status_retry (status, next_retry_at)
);
```

业务代码只剩一个事务:

```java
@Transactional
public void createOrder(Order order) {
    orderMapper.insert(order);                    // 业务数据
    localMessageMapper.insert(LocalMessage.builder()
            .msgId(order.getOrderNo())
            .exchange("order.exchange")
            .routingKey("order.created")
            .payload(JSON.toJSONString(order))
            .status(0)                            // 待发送
            .nextRetryAt(new Date())
            .build());                            // 同事务写入
}
```

独立线程负责投递:

```java
@Scheduled(fixedDelay = 1000)
public void pollAndSend() {
    List<LocalMessage> list = localMessageMapper.selectPending(100);
    for (LocalMessage msg : list) {
        try {
            rabbitTemplate.convertAndSend(
                    msg.getExchange(), msg.getRoutingKey(), msg.getPayload(),
                    m -> {
                        m.getMessageProperties().setMessageId(msg.getMsgId());
                        m.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                        return m;
                    });
            localMessageMapper.markSent(msg.getId());     // 已发送
        } catch (Exception e) {
            // 发送失败不删记录,退避重试
            localMessageMapper.backoff(msg.getId(), msg.getRetryCount() + 1);
        }
    }
}
```

这套方案的价值:**即使发 MQ 的那一刻进程直接崩溃,记录还在"待发送"状态,下一轮扫描会重发。** 业务数据和消息的原子性由本地事务保证,这是唯一不需要分布式事务、又能保证不丢的做法。

代价是引入了一张表和一个定时任务,并且**可能重复发送**(第 4 步成功、第 5 步更新状态前崩溃),所以消费端必须做幂等——这一点下一节还会说。

### 方案二:事务同步 + Confirm 回调

如果不想引入本地消息表,可以用「事务提交后发送 + Confirm 兜底 + 失败落库」的组合:

```java
TransactionSynchronizationManager.registerSynchronization(
    new TransactionSynchronization() {
        @Override
        public void afterCommit() {          // 事务提交成功后才发
            sendWithRetry(order);
        }
    });
```

`afterCommit` 解决了「回滚了还发消息」的问题,但**解决不了「提交了但进程立刻挂了」**。所以它必须配合失败落库和定时补偿,本质上退化成了一个轻量的本地消息表。

### Confirm 机制:确认 Broker 真的收到了

前面两种方案都依赖「我发出去了」这个判断,但 TCP 写入成功 **不等于** Broker 处理成功。RabbitMQ 的 `publisher-confirm` 模式解决的就是这一点。

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated   # 开启确认,带回执关联
    publisher-returns: true              # 开启路由失败回调
    template:
      mandatory: true                    # 路由失败时退回生产者
```

```java
rabbitTemplate.setConfirmCallback((correlationData, ack, cause) -> {
    if (ack) {
        // Broker 已接收(交换机收到了)
        localMessageMapper.markSent(correlationData.getId());
    } else {
        // Broker 明确拒绝,通常是内部错误
        log.error("confirm nack id={} cause={}", correlationData.getId(), cause);
        localMessageMapper.backoff(correlationData.getId(), 1);
    }
});

rabbitTemplate.setReturnsCallback(returned -> {
    // 交换机收到了,但没有任何队列匹配 → 消息会被丢弃
    log.error("路由失败 exchange={} routingKey={} reply={}",
            returned.getExchange(), returned.getRoutingKey(), returned.getReplyText());
    // 这条消息的 msgId 需要从 returned.getMessage() 里取出来,落库重投
});
```

| 回调 | 触发条件 | 触发时机 |
|---|---|---|
| **Confirm ACK** | 交换机接收成功 | 可能早于或晚于 Return |
| **Confirm NACK** | 交换机内部异常、磁盘告警等 | 异步 |
| **Return** | 交换机成功接收但**无法路由到任何队列** | 在 Confirm ACK 之后 |

这里有个必须记住的顺序问题:一条路由失败的消息,**Confirm 会回 ACK,Return 也会触发**。所以不能「收到 ACK 就标记为已发送」——那样会把路由失败的消息误标成功。正确的判断是:**只有 ACK 且没有 Return,才算真正送达。**

### 补充:备用交换机

`mandatory + Return` 依赖生产者进程在线处理回调。如果生产者那一刻正在重启,Return 回调没人接,消息照样丢。更稳的做法是给交换机配 `alternate-exchange`,让路由失败的消息直接进一个兜底队列留在 Broker 上:

```java
Map<String, Object> args = new HashMap<>();
args.put("alternate-exchange", "unrouted.exchange");
channel.exchangeDeclare("order.exchange", "topic", true, false, args);
```

兜底队列的积压量做成监控指标,一旦非零就说明有 routing key 配错了。这比翻生产者日志发现得早得多。

## 三、Broker 端:让消息活过重启

消息到了 Broker,还有三种死法。对应的开关只有三个:

```java
// 1. 交换机持久化:durable = true
channel.exchangeDeclare("order.exchange", "topic", true);

// 2. 队列持久化:durable = true
channel.queueDeclare("order.queue", true, false, false, null);

// 3. 消息持久化:delivery_mode = 2
AMQP.BasicProperties props = new AMQP.BasicProperties.Builder()
        .deliveryMode(2)     // 1=非持久化 2=持久化
        .build();
channel.basicPublish("order.exchange", "order.created", props, body);
```

三者是**与关系,缺一不可**:队列非持久化,交换机持久化也没用(重启后队列没了,消息无处可去);队列持久化了但消息非持久化,重启后队列还在、消息没了。

容易忽略的是 Spring Boot 里 `deliveryMode` 的默认值:

```yaml
spring:
  rabbitmq:
    template:
      delivery-mode: persistent   # 默认就是 2,但显式写出来更安全
```

Spring AMQP 的默认值确实是 `PERSISTENT`,但显式声明的好处是:后来有人把它改成 `NON_PERSISTENT` 做压测,能在 diff 里被看见。

### 持久化不等于不丢

这里有个反直觉的点值得强调:**开了持久化,消息也是先进内存、再由后台线程刷盘的。**

在「Broker 收到消息」到「消息落盘」之间有一个窗口。如果 Broker 进程在这个窗口内崩溃(而不是操作系统崩溃),消息就丢了。RabbitMQ 用**镜像队列**或 **Quorum Queue** 来缩小这个窗口:

| 方案 | 机制 | 说明 |
|---|---|---|
| 经典镜像队列 | 主队列 + 多个镜像副本,选举新主 | 已进入维护状态,新系统不建议用 |
| **Quorum Queue** | 基于 Raft,多数派确认后才算写入成功 | 3 节点容忍 1 节点故障,5 节点容忍 2 节点 |

```java
Map<String, Object> args = new HashMap<>();
args.put("x-queue-type", "quorum");       // 声明为 Quorum Queue
channel.queueDeclare("order.queue", true, false, false, args);
```

Quorum Queue 的语义是「多数派落盘后才 ACK 生产者」,所以它和 Confirm 配合时,ACK 的含义比经典队列强得多。代价是**吞吐量明显下降**,且不支持部分经典队列特性(如优先级队列、非持久化消息)。

选型建议很直接:**核心业务(订单、支付、库存)用 Quorum Queue;日志、埋点这类可容忍丢失的用经典队列换吞吐。**

## 四、消费者端:手动 ACK

这是三段里最容易出问题、也最容易修的一段。

### 自动 ACK 为什么危险

自动 ACK(Spring 里叫 `NONE`)的语义是:**Broker 把消息发出去的那一刻,就认为它已经被消费了。**

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        acknowledge-mode: none     # ❌ 危险
```

设想这个顺序:

```
1. Broker 投递消息给消费者
2. 消费者拿到消息,自动 ACK 已经发出去了
3. 消费者开始写 ES / 调下游接口
4. 服务被发布重启  ← 消息丢了,而且 Broker 认为它处理完了
```

**消息既不在队列里,也没被处理。** 这是最隐蔽的一类丢失:监控上消费速率正常、队列没有积压,只有下游数据少了几条。

### 手动 ACK 的正确姿势

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        acknowledge-mode: manual
        prefetch: 20                    # 每个消费者最多预取 20 条
        retry:
          enabled: false                # 关掉框架层重试,自己在业务里控制
```

```java
@RabbitListener(queues = "order.queue")
public void onMessage(Message message, Channel channel) throws IOException {
    long tag = message.getMessageProperties().getDeliveryTag();
    try {
        OrderEvent event = JSON.parseObject(message.getBody(), OrderEvent.class);
        orderService.handle(event);                 // 业务处理完成
        channel.basicAck(tag, false);               // ✅ 处理成功后才 ACK
    } catch (BusinessException e) {
        // 业务上明确不可重试(参数非法等)→ 直接进死信,别让它反复重入
        channel.basicNack(tag, false, false);       // requeue = false
    } catch (Exception e) {
        // 临时故障(网络抖动、下游超时)→ 重新入队
        channel.basicNack(tag, false, true);        // requeue = true
    }
}
```

三个参数的含义必须分清:

| 调用 | requeue | 结果 |
|---|---|---|
| `basicAck(tag, false)` | — | 消息从队列永久移除 |
| `basicNack(tag, false, true)` | true | 消息重新入队,**可能被同一个消费者立刻拿到**(打转风险) |
| `basicNack(tag, false, false)` | false | 消息变死信,进 DLX;没配 DLX 则被丢弃 |

### requeue=true 的陷阱

`requeue=true` 看起来是「重试」,但如果失败原因是**消息本身有问题**(比如 JSON 格式错误、字段缺失),它会被无限次重新投递:

```
投递 → 抛异常 → requeue → 立刻又投给同一个消费者 → 再抛异常 → ...
```

结果是**消费者 CPU 打满、队列积压不降反升,正常消息全被堵住**。这就是所谓「毒消息」。

正确的策略是**区分可重试与不可重试**,并把重试次数记在消息头里,超过阈值就转死信:

```java
Integer retry = (Integer) message.getMessageProperties()
        .getHeaders().getOrDefault("x-retry-count", 0);

if (retry >= 3) {
    channel.basicNack(tag, false, false);       // 转死信队列,人工介入
    return;
}
// 重试前把计数写回 headers,重新发布一条
```

配套的死信配置:

```java
Map<String, Object> args = new HashMap<>();
args.put("x-dead-letter-exchange", "dlx.exchange");
args.put("x-dead-letter-routing-key", "dlx.order");
channel.queueDeclare("order.queue", true, false, false, args);
```

死信队列要有专人(或定时任务)消费和告警——**死信队列堆积但是没人看,等于换个地方丢消息。**

## 五、三段方案总览

| 端 | 目标 | 手段 | 兜底 |
|---|---|---|---|
| **生产者** | 业务数据与消息同时生效 | 本地消息表(同事务写入) | 定时任务扫描重发 + Confirm 回调 + `alternate-exchange` |
| **Broker** | 消息活过重启和节点故障 | Exchange/Queue `durable=true`、`delivery_mode=2`、Quorum Queue | 镜像/多数派副本 |
| **消费者** | 处理成功才算消费完 | `acknowledge-mode: manual`、成功后 `basicAck` | 失败 nack + 重试上限 + 死信队列 |

一句话概括:**发得进、存得住、收得完,再加消费幂等。**

最后补一句容易被跳过的话:**上面所有机制合起来,只能保证"不丢",代价是一定会"重复"。** Confirm 超时重发、本地消息表重扫、`requeue=true` 重投,每一个环节都在制造重复消息。所以消费者端的幂等不是可选项,它和「不丢」是一体两面——没有幂等的不丢,只是把丢消息换成了脏数据。

## 六、小结

- 没有「恰好一次」,工程目标是**每一段失败可感知、可重试**
- 生产者端最稳的是**本地消息表**:把发消息写进业务事务,另起线程投递并更新状态
- **Confirm 只能证明交换机收到了**,路由失败要靠 `mandatory + Return` 或 `alternate-exchange` 兜底;两者可能同时触发,**只有 ACK 且无 Return 才算送达**
- Broker 端 **Exchange/Queue durable + `delivery_mode=2` 三件套缺一不可**,再叠加 Quorum Queue 抗节点故障
- 消费者端**必须关自动 ACK**:自动 ACK 的语义是「投出去就算消费完」,进程重启就丢消息
- `basicNack(requeue=true)` 遇到毒消息会无限打转,**必须配合重试计数和死信队列**,死信也要有人看
- 不丢的代价是重复,**幂等和可靠性必须成对设计**
