---
title: RabbitMQ 交换机类型:Direct、Topic、Fanout 与 Headers
date: 2026-02-13
description: 交换机不是消息的容器,而是路由规则本身。这篇把 Direct 与 Topic 的匹配差异、Fanout 广播、Headers 匹配、备用交换机与死信路由讲清楚,并给出一套选型决策表。
tags: [RabbitMQ, 消息队列, 路由]
category: 消息队列
---

## 一、一个常见的误解

很多人第一次接触 RabbitMQ,会本能地把它理解成「升级版的队列」:生产者往里塞,消费者从里拿。

但真正动手写第一段代码时就会卡住:**消息根本没进队列**。

```java
// 生产者只管把消息发给交换机,它甚至不知道队列存不存在
channel.basicPublish(
        "order.exchange",   // 交换机
        "order.pay",        // routing key
        null,
        body
);
```

问题在于,RabbitMQ 里**生产者从不直接发消息给队列**。它把消息交给一个叫**交换机(Exchange)**的组件,由交换机根据规则决定这条消息该进哪些队列。没有匹配到任何队列的消息,默认行为是**静默丢弃**——不报错、不告警、不留痕。

所以交换机不是「消息的容器」,**它是路由规则本身**。理解了这句话,四种交换机类型的差异就只剩下一个维度:**它在拿 routing key 和什么做比对。**

## 二、四类交换机的匹配逻辑

先看一张总表:

| 类型 | 匹配依据 | 匹配规则 | 一条消息能进几个队列 |
|---|---|---|---|
| **Direct** | routing key vs binding key | **完全相等** | 可以多个(binding key 相同的队列都收到) |
| **Topic** | routing key vs binding key | **通配符模式匹配** | 可以多个 |
| **Fanout** | 不匹配 | 忽略 routing key,**广播给所有绑定队列** | 全部绑定队列 |
| **Headers** | 消息 headers vs binding 参数 | 按 header 键值匹配,`x-match` 决定全部还是任一 | 可以多个 |

下面逐个拆。

### Direct:精确相等

Direct 是最朴素的一类。绑定关系是「队列 Q 关心 routing key 为 K 的消息」,投递时只有 `routing key == binding key` 的队列会收到。

```
Exchange(direct: order.exchange)
   ├── binding: order.pay     → Queue(pay.queue)
   └── binding: order.cancel  → Queue(cancel.queue)

发送 routing key = "order.pay"    → 只有 pay.queue 收到
发送 routing key = "order.pay.v2" → 没有任何队列匹配 → 被丢弃
发送 routing key = "order"        → 没有任何队列匹配 → 被丢弃
```

有一个容易踩的坑:**Direct 类型的交换机也允许一个队列绑定多个 key**。

```
Queue(all.queue) 绑定 order.pay 和 order.cancel
```

这在语义上等价于「这个队列订阅了两个精确主题」,和 Topic 的订阅能力有重叠。区别只在于 Direct 不支持 `*` 和 `#`。

### Topic:通配符模式匹配

Topic 把 routing key 当成一串**以点分隔的单词**,然后在单词级别上做模式匹配。两个通配符的含义必须记牢:

| 通配符 | 含义 | 匹配范围 |
|---|---|---|
| `*` | 匹配**恰好一个**单词 | `order.*.success` 匹配 `order.pay.success`,不匹配 `order.success`、也不匹配 `order.a.b.success` |
| `#` | 匹配**零个或多个**单词 | `order.#` 匹配 `order`、`order.pay`、`order.pay.success.v2` |

`#` 能匹配零个单词这一点经常被忽略,但它解释了一个实际现象:`order.#` 会连 `order` 这条裸消息一起收走。

几个典型用例:

| binding key | 能匹配的 routing key | 不能匹配的 |
|---|---|---|
| `order.*.success` | `order.pay.success`、`order.refund.success` | `order.success`、`order.pay.v2.success` |
| `order.#` | `order`、`order.pay`、`order.pay.success` | `trade.pay` |
| `*.pay.*` | `order.pay.success`、`wx.pay.fail` | `pay.success`、`order.pay` |
| `#.error` | `error`、`order.error`、`a.b.error` | `order.error.log` |

> **`*` 管一段,`#` 管任意段。** 这是 Topic 唯一需要背下来的规则,其余都是推论。

### Fanout:不看 key,全广播

Fanout 忽略 routing key,把消息复制给**所有绑定的队列**。

```
Exchange(fanout: notice.exchange)
   ├── Queue(sms.queue)
   ├── Queue(email.queue)
   └── Queue(push.queue)

发送任意 routing key → 三个队列各收到一份
```

它的价值在于**解耦「通知」和「接收方数量」**:新增一个站内信渠道,只需绑定一个新队列,生产者代码一行都不用改——它压根不知道有几个下游。

代价也很明确:**绑定即订阅,无法筛选**。你没法让某个队列「只收一部分」,那是 Direct 和 Topic 的活。

### Headers:按消息头匹配

Headers 交换机彻底不看 routing key,改看消息的 headers。绑定参数里用 `x-match` 指定匹配模式:

| `x-match` | 语义 |
|---|---|
| `all`(默认) | 所有 header 键值都匹配才算命中 |
| `any` | 任意一个 header 键值匹配即命中 |

```java
// 绑定:要求 type=order 且 level=high
Map<String, Object> args = new HashMap<>();
args.put("x-match", "all");
args.put("type", "order");
args.put("level", "high");
channel.queueBind("high.queue", "headers.exchange", "", args);

// 发送:headers 满足条件才进 high.queue
Map<String, Object> headers = new HashMap<>();
headers.put("type", "order");
headers.put("level", "high");

AMQP.BasicProperties props = new AMQP.BasicProperties.Builder()
        .headers(headers)
        .build();
channel.basicPublish("headers.exchange", "", props, body);
```

一个细节:Headers 匹配在**字符串之外也生效**——整数、布尔值会按类型比较,`1` 和 `"1"` 不是同一个值。这个特性一半是优点(表达力强),一半是麻烦(生产者写错类型时静默不匹配)。

**它在生产环境用得非常少**,原因有三:routing key 变得没有意义、绑定规则不可视化(排查问题时要去数据库里翻 headers)、性能不如 key 匹配。绝大多数所谓「Headers 才能表达的场景」,用 Topic 加一段约定好的 key 命名就够了。

## 三、四种类型横向对比

| 维度 | Direct | Topic | Fanout | Headers |
|---|---|---|---|---|
| routing key 是否重要 | 是,必须精确相等 | 是,模式匹配 | 否,完全忽略 | 否,完全忽略 |
| 是否支持通配符 | 否 | `*` / `#` | — | — |
| 路由开销 | 最低(哈希查找) | 中(模式匹配) | 最低 | 较高(逐 header 比较) |
| 表达能力 | 弱 | 强 | 只有「全发」 | 最强 |
| 可读性/可排查性 | 高 | 高 | 高 | 低 |
| 典型场景 | 点对点任务分发、按事件类型分流 | 日志分级、按业务维度订阅 | 广播通知、缓存刷新、配置下发 | 极少,特殊多条件筛选 |

### 怎么选

决策路径其实很短:

1. **要不要筛选?** 不需要 → 用 **Fanout**。
2. **要筛选,条件能不能编码成一段带点的 key?** 能 → 用 **Topic**(即使当前只需要精确匹配,未来加维度时不用改交换机)。
3. **要筛选,且必须按消息属性而非 key 筛选?** → 再考虑 **Headers**,但优先想想能不能把它编码进 key。
4. **只用 Direct 的场景**:当 key 是明确的枚举值、且确定不会衍生出层次时,Direct 的哈希查找更省一点,语义也更干净。

**实践建议:不确定就上 Topic。** 它兼容 Direct 的全部用法(把 binding key 写成没有通配符的字符串即可),而反向迁移需要改生产者和绑定。

## 四、路由失败:消息去哪了

回到开头那个坑:消息没匹配到队列时,默认是**静默丢弃**。这是生产事故的常见来源——上线新队列时少了两个字,消息全进了黑洞,而监控上一切正常。

RabbitMQ 提供了两个补救机制。

### 1. mandatory + Return 回调

发送时把 `mandatory` 置为 `true`,Broker 在无法路由时会把消息**退回给生产者**:

```java
channel.addReturnListener((replyCode, replyText, exchange, routingKey, props, body) -> {
    // replyCode = 312 NO_ROUTE
    log.error("消息路由失败 exchange={} routingKey={} reason={}",
            exchange, routingKey, replyText);
    // 落库补偿 / 告警
});

channel.basicPublish(
        "order.exchange",
        "order.pay",           // 写错了,没有队列绑定
        true,                  // mandatory = true
        null,
        body
);
```

注意 `mandatory` **必须配合 Return 监听器**才有意义。只设 `true` 不监听,消息一样丢,只是多了一次无意义的回调。

另外,`mandatory` 只能捕获「交换机存在但没路由到队列」;**如果交换机本身不存在,消息会先被丢弃,连 Return 都不会触发**。这时要靠 Confirm 机制的 NACK 才能感知(参见消息可靠性一文)。

### 2. 备用交换机(Alternate Exchange)

比 Return 更省心的做法是给交换机配一个「兜底出口」。声明交换机时用 `alternate-exchange` 参数指定:

```java
// 1. 先声明兜底交换机(通常用 Fanout)
channel.exchangeDeclare("unrouted.exchange", "fanout", true);

// 2. 声明业务交换机,并绑定备用交换机
Map<String, Object> args = new HashMap<>();
args.put("alternate-exchange", "unrouted.exchange");
channel.exchangeDeclare("order.exchange", "topic", true, false, args);

// 3. 兜底队列接住所有无法路由的消息
channel.queueDeclare("unrouted.queue", true, false, false, null);
channel.queueBind("unrouted.queue", "unrouted.exchange", "");

// 4. 专人/定时任务消费 unrouted.queue,排查后重投或人工处理
```

| | mandatory + Return | 备用交换机 |
|---|---|---|
| 消息去哪 | 退回生产者,需要生产者在线处理 | 进入兜底队列,消息留在 Broker |
| 生产者宕机时 | 退不回,消息丢失 | 消息照样进兜底队列 |
| 排查方式 | 看生产者日志 | 看兜底队列积压量,可做成告警指标 |
| 适用 | 发送方强控制、需要即时补偿 | 想留一份「无法路由」的证据 |

生产环境常见做法是**两个都开**:备用交换机接住消息,兜底队列的积压量做成监控告警。队列一开始堆积,说明有绑定的 routing key 写错了。

### 3. 死信交换机(DLX)

备用交换机处理的是「从来没进过队列」的消息,死信交换机处理的则是**进过队列、又被吐出来**的消息。一条消息进入死信队列有三种原因:

1. 消费者 `basicNack` / `basicReject` 且 `requeue=false`;
2. 消息 TTL 过期(队列级或消息级);
3. 队列达到最大长度,队头消息被挤掉。

配置方式是在队列参数上挂死信路由:

```java
Map<String, Object> args = new HashMap<>();
args.put("x-dead-letter-exchange", "dlx.exchange");     // 死信去哪
args.put("x-dead-letter-routing-key", "dlx.order");     // 可选:重写 routing key
args.put("x-message-ttl", 30 * 60 * 1000);              // 队列级 TTL,30 分钟

channel.queueDeclare("order.delay.queue", true, false, false, args);
```

死信队列是最常用的延迟消息实现方式,细节(包括它的队头阻塞问题)另有一篇专门讨论。

## 五、小结

- 生产者发消息给**交换机**,交换机按规则路由到队列,**没有匹配默认静默丢弃**
- **Direct** 精确相等,**Topic** 支持 `*`(一个单词)和 `#`(零到多个单词),**Fanout** 全广播,**Headers** 按消息头匹配(生产环境极少用)
- Topic 是 Direct 的超集,不确定选什么就选 Topic
- 路由失败有两个兜底:**mandatory + Return 回调**(退给生产者)、**备用交换机**(进兜底队列);前者依赖生产者在线,后者能留下堆积证据
- **死信交换机**处理的是「进过队列又被吐出」的消息,触发条件是 nack/reject、TTL 过期、队列超长
- 上线新交换机/队列时,务必确认绑定关系真实存在——静默丢弃不报错,是最难发现的一类故障
