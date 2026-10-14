---
title: 消息堆积了怎么办:一套应急处理流程
date: 2026-03-24
description: 堆积预警不是"加机器"就能解决的。这篇给出一套六步应急流程——定位原因、扩容、处理毒消息、限流生产者、优化消费逻辑、事后复盘,并补上扩容后必然出现的乱序问题与两种解法。
tags: [RabbitMQ, 消息队列, 消息堆积, 消费者]
category: 消息队列
---

## 一、收到堆积预警时,先别急着扩容

「队列堆积了,加消费者。」——这是最直接的反应,也是**一半情况下正确、另一半情况下会让事情更糟**的反应。

先看堆积是怎么形成的。队列的消息数是一个存量指标,它的变化只取决于一个公式:

```
队列长度变化 = 生产速率 - 消费速率
```

堆积只有三种成因:

| 成因 | 特征 | 扩容有用吗 |
|---|---|---|
| **生产突增** | 生产 TPS 陡增,消费 TPS 正常 | ✅ 有用,但可能只是推迟问题 |
| **消费变慢** | 消费 TPS 骤降,生产 TPS 平稳 | ⚠️ 要看是资源不足还是下游变慢 |
| **消费失败重入队** | 消费 TPS 高但队列不降,日志大量异常 | ❌ **有害**,越扩越乱 |

第三种是最容易被误判的。毒消息在消费者里抛异常、`requeue=true` 重新入队、立刻又被投出去,形成打转。这时候的监控表现是「消费 TPS 很高、队列却在涨」——**看起来像消费能力不足,实际是消费者在做无用功。** 加机器只会让更多实例一起打转,下游数据库的连接数瞬间被打满。

所以第一件事不是扩容,是**打开监控和日志,把这个公式的两端拆开看**。

## 二、第一步:排查原因

要看的指标不多,但每一个都要和历史基线对比:

| 指标 | 看什么 | 异常模式 |
|---|---|---|
| 生产 TPS | 是否陡增、何时开始 | 陡增 → 上游有活动/有补偿任务在刷 |
| 消费 TPS | 是否骤降 | 骤降 → 消费者卡住或宕机 |
| 队列消息数 | 增长速度 | 匀速涨 = 持续供大于求;阶梯涨 = 有突发 |
| 未确认消息数(unacked) | 是否持续高位 | 高位 → 消费者卡在某个慢调用上 |
| 消费者实例数/连接数 | 是否全部在线 | 掉线 → 实例被重启、被限流驱逐 |
| 消费失败率 | 异常日志条数 | 占比高 → 毒消息 |
| 死信队列长度 | 是否同步增长 | 增长 → 消息在被拒绝,不是被处理 |

定位路径可以浓缩成三句话:

1. **消费 TPS 正常、生产 TPS 涨了** → 生产端问题,先止血再扩容;
2. **生产 TPS 正常、消费 TPS 掉了** → 消费端问题,看是实例掉了、线程池满了,还是下游变慢;
3. **两者都正常、队列还在涨** → 消息在打转,去翻异常日志。

> **原则:优先恢复消费,保证业务;然后再定位根因。**
>
> 但有一条底线不能碰:**不要直接删消息。** 删消息会把业务数据一起删掉,堆积是性能问题,删消息是数据事故。真要丢弃,也应该是有选择地转存到死信队列或落库,保留追溯的可能。

## 三、第二步:紧急扩容

确认了是「生产确实快、消费确实慢」之后,扩容是最快的止血手段。

```yaml
# 消费者并发数:单实例内的消费线程数
spring:
  rabbitmq:
    listener:
      simple:
        concurrency: 5          # 最小并发
        max-concurrency: 20     # 弹性上限,按队列堆积自动扩线程
        prefetch: 20
```

扩容的前提条件必须提前确认,否则扩了也没用:

| 前提 | 说明 |
|---|---|
| **业务无状态** | 消费者实例可以水平扩展。如果消费逻辑依赖本地缓存或内存态,扩容会导致结果错乱 |
| **消费能力瓶颈不在下游** | 如果瓶颈是数据库或第三方接口,加消费者只会把压力转移过去,可能直接打挂数据库 |
| **实例数不超过队列数太多** | 一个队列的消息只会投给一个消费者,单队列的并行度上限受 prefetch 和投递速度限制 |
| **消息本身可并行** | 如果消息之间有顺序要求,盲目扩容会引入乱序(见第六节) |

第 2 条是最常被忽略的。经验上,**扩容前先看清下游的容量上限**:如果 MySQL 已经跑到 80% CPU,再加 10 个消费者就是压垮它的最后一根稻草。这种情况下正确的做法是**先降级下游的慢操作,再扩容**。

## 四、第三步:排查消费失败(毒消息)

如果定位结果是「消息在打转」,处理方式和扩容完全相反:**把问题消息移出去。**

```java
@RabbitListener(queues = "order.queue")
public void onMessage(Message message, Channel channel) throws IOException {
    long tag = message.getMessageProperties().getDeliveryTag();
    try {
        orderService.handle(parse(message));
        channel.basicAck(tag, false);
    } catch (JsonParseException | IllegalArgumentException e) {
        // 消息本身有问题 → 重试多少次都不会成功 → 直接进死信
        log.error("消息格式非法,转入死信队列 body={}", new String(message.getBody()));
        channel.basicNack(tag, false, false);       // requeue = false
    } catch (Exception e) {
        // 可能是临时故障 → 重试,但要有上限
        int retry = getRetryCount(message);
        if (retry >= 3) {
            log.error("重试 {} 次仍失败,转入死信", retry, e);
            channel.basicNack(tag, false, false);
        } else {
            republishWithRetryHeader(message, retry + 1);
            channel.basicAck(tag, false);
        }
    }
}
```

这里的核心判断是**区分「可重试」和「不可重试」**:

| 异常类型 | 例子 | 处理 |
|---|---|---|
| 不可重试 | JSON 解析失败、必填字段缺失、业务校验不通过 | **直接进死信**,`requeue=false` |
| 可重试 | 下游超时、连接池耗尽、死锁 | `requeue=true` 或延迟重投,但**必须设上限** |

如果没有区分,所有异常都 `requeue=true`,一条格式错误的消息就能让整个队列瘫痪:

```
投递 → 解析失败抛异常 → requeue → 立刻投给同一个消费者 → 再失败 → ...
```

这个循环的吞吐极高,能在几秒内把 CPU 打满,把正常消息全部堵在队列里。**这就是前面说的「消费 TPS 很高、队列却在涨」的真实原因。**

死信队列还必须配监控和消费方:

```java
Map<String, Object> args = new HashMap<>();
args.put("x-dead-letter-exchange", "dlx.exchange");
args.put("x-dead-letter-routing-key", "dlx.order");
args.put("x-queue-type", "quorum");
channel.queueDeclare("order.queue", true, false, false, args);
```

```yaml
# 死信队列长度必须做成告警指标,否则等于换个地方丢消息
alert:
  - metric: rabbitmq_queue_messages{queue="dlx.order.queue"}
    expr: value > 100
    level: warning
```

**死信队列堆积但没人看,和直接丢消息没有区别**——只是丢得更体面一点。

## 五、第四步:限流生产者

如果是上游生产突增(比如运营活动、批量重算任务在刷数据),临时给生产者限流能立刻缓解压力,为消费端争取恢复时间。

客户端侧限流(控制发送速率):

```java
// Guava RateLimiter:把发送速率压到消费能力之下
private final RateLimiter limiter = RateLimiter.create(2000);   // 2000 QPS

public void publish(Event event) {
    limiter.acquire();                    // 超过速率就阻塞等待
    rabbitTemplate.convertAndSend("order.exchange", "order.created", event);
}
```

服务端侧也可以限制连接和信道:

```ini
# rabbitmq.conf
channel_max = 2048
connection_max = 4096
```

不过要提醒一句:**限流是止血,不是治疗。** 它会让上游变慢甚至超时,只有在「上游本来就可以降速」时才用。如果上游是用户请求路径,限流会把堆积问题转化成用户可见的失败——那还不如让它堆积,自己抓紧扩消费。

真正做限流的场景通常是**可控的批量任务**:数据同步、离线重算、补偿任务。这些任务天然可以降速,给它们排个队,优先保证在线业务的消费。

## 六、第五步:优化消费逻辑

前面四步都是止血,这一步才是根治。消费慢的原因集中在三个地方:

### 1. 去掉消费链路里的慢 IO

```java
// ❌ 每条消息都同步调一次远程接口
public void handle(OrderEvent event) {
    User user = userFeignClient.get(event.getUserId());     // 远程调用,50ms
    Product p = productFeignClient.get(event.getSkuId());   // 远程调用,80ms
    orderMapper.insert(build(event, user, p));              // 还可能慢查询
}
```

单条消息 130ms,单线程吞吐上限只有 7.7 QPS。三条常见的优化:

| 手段 | 效果 |
|---|---|
| 把远程调用改为批量拉取,或改为本地缓存 + 定时刷新 | 消除逐条网络往返 |
| 让生产者把必要字段冗余进消息体,消费者不再回查 | 直接省掉远程调用 |
| 检查 `EXPLAIN`,补上缺失的索引 | 消除慢查询 |

### 2. 批量消费

一次取多条,把单条的网络和事务开销摊薄:

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        consumer-batch-enabled: true
        batch-size: 50
        receive-timeout: 200ms
```

```java
@RabbitListener(queues = "order.queue", containerFactory = "batchFactory")
public void onBatch(List<Message> messages, Channel channel) throws IOException {
    List<OrderEvent> events = messages.stream().map(this::parse).toList();
    orderService.handleBatch(events);          // 一次批量写库
    long lastTag = messages.get(messages.size() - 1)
            .getMessageProperties().getDeliveryTag();
    channel.basicAck(lastTag, true);           // multiple = true,一次确认一批
}
```

批量消费的收益来自「N 次数据库写变成 1 次」,在写密集型消费里通常能提升数倍吞吐。代价是**失败时的粒度变粗**——一批里有一条坏消息,整批都要重来。所以批量消费更适合「消息格式可控、处理逻辑稳定」的场景。

### 3. 调整 prefetch

`prefetch` 决定了一个消费者最多同时持有多少条未确认消息。它是个双向的旋钮:

| prefetch | 后果 |
|---|---|
| **太小**(如 1) | 消费者处理完一条才拿一条,网络往返成为瓶颈,消费者大部分时间在等消息 |
| **太大**(如 1000) | 消息被一次性推到少数消费者内存里,其他消费者空转;**未确认消息堆积,消费者重启时大量消息回退重投** |
| 合适值 | 大致等于「单条处理耗时 × 期望吞吐量」,让小批量持续流动 |

一个经验值:计算型消费(纯 CPU)取 10~50;IO 型消费(写库、调接口)取 1~10,避免大量消息同时压在同一个实例上。**调完之后一定要看「未确认消息数」这个指标**,它比队列长度更能反映消费者的真实负载。

## 七、第六步:事后复盘

堆积处理完了,但如果不做复盘,下一次还会以同样的方式发生。要回答的问题:

1. **告警是不是太晚了?** 如果堆积到 10 万条才报警,阈值就该下调。更好的做法是**用「队列增长速率」而不是「绝对长度」告警**——`5 分钟内队列增长超过 10000` 比 `队列长度超过 100000` 早得多。
2. **峰值容量是多少?** 做一次压测,得出「当前消费者配置下的最大安全消费 TPS」,和业务峰值对比,留出余量。
3. **扩容能不能自动化?** 基于队列长度自动扩缩消费者实例,比人收到告警再操作快得多。
4. **这次的根因落在哪一环?** 是容量规划不足、下游变慢、还是消息格式校验缺失?对应的长期改进是什么。

## 八、扩容之后:乱序问题

前面提到,扩容有一个前提是「消息本身可并行」。如果消息之间有顺序要求,扩容会引入一个新的、更隐蔽的问题。

### 问题长什么样

同一个用户的资料先改成「张三」,后改成「李四」。两条消息都正确发出了,但由于异步和并发,到达顺序可能反过来:

```
生产顺序:  改名为"张三"  →  改名为"李四"
到达顺序:  改名为"李四"  →  改名为"张三"     ← 乱序
最终结果:  索引里存的是"张三" —— 旧数据覆盖了新数据
```

注意这个问题**在没有堆积、没有失败、所有消息都成功处理的情况下也会发生**。它不会报错,不会进死信,只会让数据静默地错下去。而且一旦新消费者实例加入、或者重试导致某条消息延后,乱序的概率就显著上升。

### 解法 A:按业务主键 Hash 路由

RabbitMQ 保证**单个队列是 FIFO** 的。那么只要让同一个业务实体的消息永远进同一个队列,它的变更就是严格有序的。

```java
// 按业务主键做一致性 Hash,选队列
int idx = Math.floorMod(orderNo.hashCode(), QUEUE_COUNT);
String queueName = "order.queue." + idx;

// 或者用 Topic 交换机 + routing key 路由
// routing key = "order.sync." + (hash % QUEUE_COUNT)
channel.basicPublish("order.sync.exchange",
        "order.sync." + idx, null, body);
```

配套要满足三个条件:

| 条件 | 原因 |
|---|---|
| 同一个 key 的 Hash 结果稳定 | 否则同一实体在多个队列间漂移 |
| 每个队列**至少一个**消费者 | 消费者可以多,但要保证同一队列内串行消费 |
| **队列数量固定** | 扩容队列会改变 Hash 映射,迁移期间必然乱序 |

第三条是这个方案的真实代价:**Hash 路由和水平扩容是矛盾的。** 队列数一旦定下(比如 8 个),就只能通过「队列内不并发消费」来保证顺序,消费并行度的上限就被锁死了。所以它适合「顺序要求高、但吞吐量中等」的场景。

### 解法 B:数据版本号(推荐)

更通用的做法是**不依赖投递顺序,而是让每条写入自带"新旧"信息**,由存储层拒绝旧数据。

```java
// MySQL 侧:每次更新时 version 自增
// UPDATE product SET name = ?, version = version + 1 WHERE id = ?
```

消费者写索引前做一次比较:

```java
public void syncToEs(Product product) {
    // 1. 查目标文档当前的版本
    GetResponse current = esClient.get(g -> g.index("product").id(product.getId()),
            GetResponse.class);

    if (current.isExists()) {
        long esVersion = ((Number) current.getSourceAsMap().get("version")).longValue();
        if (product.getVersion() <= esVersion) {
            log.info("旧数据,忽略 productId={} mysqlV={} esV={}",
                    product.getId(), product.getVersion(), esVersion);
            return;                          // 消息比已有数据还旧,直接丢掉
        }
    }

    // 2. 只有更新的数据才写入
    esClient.index(i -> i.index("product")
            .id(String.valueOf(product.getId()))     // 指定业务主键,天然幂等
            .document(product));
}
```

但「先查再写」之间仍有窗口,并发下两条消息可能同时查到旧版本、都判断可以写。**ES 原生的乐观锁可以把这个窗口彻底堵上:**

```java
// 带上 if_seq_no 和 if_primary_term,写入时校验版本
// 版本不匹配 → ES 返回 409 version_conflict_engine_exception
IndexResponse resp = esClient.index(i -> i
        .index("product")
        .id(String.valueOf(product.getId()))
        .ifSeqNo(current.getSeqNo())
        .ifPrimaryTerm(current.getPrimaryTerm())
        .document(product), IndexRequest.class);
```

对应到 REST 接口就是:

```
PUT /product/_doc/10086?if_seq_no=12&if_primary_term=1
→ 版本不匹配时返回 409 冲突
```

消费者收到 409 时的处理非常简单:**忽略这条消息。** 因为冲突本身就说明「已经有更新的数据写进去了」,这条旧消息没有存在的价值。

| | 解法 A:Hash 路由 | 解法 B:版本号 |
|---|---|---|
| 保证顺序的方式 | 让同一实体串行 | 让存储层拒绝旧数据 |
| 是否需要固定队列数 | **是**,扩容受限 | 否,可自由扩容 |
| 能否防止旧数据覆盖新数据 | 能(顺序正确) | **能**(即使乱序到达也拒绝) |
| 额外成本 | 路由逻辑 + 并行度上限 | 业务表加 `version` 字段 + 一次读 |
| 适用 | 顺序要求强、有明确的业务键 | **通用,推荐作为默认方案** |

两个方案不冲突,生产环境常见的是**两者都做**:Hash 路由降低乱序概率,版本号兜住剩余的情况。但要清楚**版本号才是真正保证正确性的那一层**——Hash 路由是优化,版本号才是底线。

## 九、小结

- 队列长度变化 = 生产速率 − 消费速率,堆积只有**生产突增、消费变慢、消息打转**三种成因,先定位再动手
- 打转的典型特征是「**消费 TPS 很高、队列却在涨**」,此时扩容有害
- 应急流程六步:**排查原因 → 紧急扩容 → 处理毒消息 → 限流生产者 → 优化消费逻辑 → 事后复盘**
- **扩容前提**:业务无状态、下游有余量、消息可并行;盲目扩容会把压力转嫁给数据库
- 毒消息必须**区分可重试与不可重试**,不可重试的直接 `requeue=false` 转死信,并设重试上限
- 消费优化三个抓手:**去掉慢 IO、批量消费、调好 prefetch**;看「未确认消息数」比看队列长度更准
- **不要删消息**,堆积是性能问题,删消息是数据事故;死信队列必须配告警
- 扩容会引入**乱序**:解法 A 是按业务主键 Hash 路由(与扩容矛盾),解法 B 是**版本号 + ES 乐观锁 409**(推荐,乱序到达也能拒绝旧数据)
