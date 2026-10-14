---
title: Spring 事务失效的六大场景
date: 2026-02-05
description: 事务失效最麻烦的地方不是报错,而是静默失效——注解照写、代码照跑,数据却已经落库了。这篇从事务赖以生效的两块基石出发,把六类失效场景的成因、复现代码和修法一次讲清。
tags: [Spring, 事务, Java]
category: 并发编程
---

`@Transactional` 大概是 Java 后端最容易被误用的注解:加上了就以为安全,实际上它失效的时候**不会抛异常、不会有日志、不会有任何提示**,方法照常执行,数据照常落库,只是那句"要么全成功要么全失败"的承诺已经悄悄消失了。

这篇文章把事务失效的六类场景拆开讲,每一类都给出可复现的写法和对应修法。

## 一、事务靠什么生效:两块基石

很多人把 `@Transactional` 理解成"给方法套了个壳",但它本身**不做任何事务工作**。真正干活的是一条调用链:

```
调用方 → 代理对象 → TransactionInterceptor → 事务管理器 → JDBC Connection
```

这条链上有两块基石,缺一个事务就没了:

| 基石 | 具体是什么 | 作用 | 被破坏的后果 |
|---|---|---|---|
| **AOP 代理** | 容器启动时由 `BeanPostProcessor` 为标注了 `@Transactional` 的 Bean 生成代理对象 | 只有**经过代理对象**的调用才会被拦截并织入事务逻辑 | 调用没走代理 → 事务根本没开启 |
| **ThreadLocal 绑定连接** | `DataSourceTransactionManager` 把 `Connection` 绑定到当前线程的 `ThreadLocal` | 同一个线程内的所有 DAO 操作**复用同一个连接**,才谈得上同事务 | 线程变了 → 拿到的是另一个连接,不在同一个事务里 |

所以事务失效的原因可以归结成一句话:

> **只要「代理闭环」或「连接传递」被破坏,事务就会失效。**

下面六类场景,全部是这两条被破坏的具体形态。

## 二、非 public 方法:代理盲区

`@Transactional` 默认**只对 public 方法生效**。写在 `private`、`protected` 或包级可见的方法上,Spring 会直接忽略它。

```java
@Service
public class OrderService {

    // ❌ private 上的 @Transactional 完全无效
    @Transactional
    private void createOrder(Order order) {
        orderMapper.insert(order);
        stockMapper.deduct(order.getSkuId());
    }
}
```

最坑的是**没有任何报错**。注解在那里,IDE 也不会提醒,只有当你手动抛异常测试回滚时才会发现数据已经进去了。

原因是基于 CGLIB 的代理只覆写 public 方法,非 public 方法压根不在拦截范围内。**修法很简单:把事务方法提升为 public。**

## 三、类内部自调用:绕过了代理

这是生产环境出现频率最高的一类。同一个 Service 里,A 方法调用 B 方法:

```java
@Service
public class OrderService {

    public void methodA() {
        // ❌ 本质是 this.methodB(),走的是原始对象,不是代理对象
        this.methodB();
    }

    @Transactional
    public void methodB() {
        orderMapper.insert(/* ... */);
    }
}
```

`this` 指向的是**目标对象本身**,而不是容器里那个被增强过的代理对象。调用没经过代理,`TransactionInterceptor` 就没机会介入,`methodB` 上的注解形同虚设。

判断方法很直接:问自己一句「这次调用是**从代理对象发出去的**吗」。同类内部调用答案永远是否。

三种常见修法:

| 修法 | 写法 | 适用与代价 |
|---|---|---|
| 注入自身代理 | `@Autowired private OrderService self;` 然后 `self.methodB()` | 改动最小,但循环依赖语义略绕 |
| 暴露 AopContext | 开启 `@EnableAspectJAutoProxy(exposeProxy = true)`,用 `((OrderService) AopContext.currentProxy()).methodB()` | 侵入代码,依赖代理配置 |
| 调整粒度 | 把 `@Transactional` 提到类上,让 `methodA` 也在事务内 | 最简单,但要评估事务范围是否过大 |

还有一种"看起来不像自调用"的情况:方法没有 `@Transactional`,类上有。这时候注解在类级别已经生效了,自调用反而无害——**关键看被调用的那个方法是怎么拿到事务语义的**。

## 四、异常被"吃掉":不回滚

Spring 的默认回滚规则只有两条:

> **遇到 `RuntimeException` 和 `Error` 回滚,遇到检查异常(Checked Exception)默认提交。**

这直接导致两种高频翻车:

```java
// 情况一:catch 之后不抛 -> 事务正常提交,数据入库
@Transactional
public void createOrder(Order order) {
    try {
        orderMapper.insert(order);
        payClient.call(order);        // 抛了异常
    } catch (Exception e) {
        log.error("下单失败", e);      // 只是记了个日志
    }
    // 方法正常返回 -> 事务提交 -> 半截数据留在库里
}
```

```java
// 情况二:抛的是检查异常 -> 默认不回滚
@Transactional
public void transfer(Long from, Long to) throws IOException {
    accountMapper.deduct(from);
    if (someCheck()) {
        throw new IOException("下游文件写入失败");  // 检查异常,Spring 默认提交
    }
    accountMapper.add(to);
}
```

修法是显式声明回滚范围,别依赖默认值:

```java
@Transactional(rollbackFor = Exception.class)
public void transfer(Long from, Long to) throws IOException { /* ... */ }
```

| 异常类型 | 默认是否回滚 | 说明 |
|---|---|---|
| `RuntimeException` 及其子类 | ✅ 回滚 | 默认规则 |
| `Error` 及其子类 | ✅ 回滚 | 默认规则 |
| 检查异常(`Exception` 直接子类) | ❌ **提交** | 必须写 `rollbackFor` |
| 被 catch 且未重新抛出 | ❌ **提交** | 事务拦截器看不到异常 |

## 五、数据库引擎不支持事务

这一条最容易被忽略,因为**它根本不在 Java 层**。

如果表用的是 MySQL 的 **MyISAM** 引擎,那么 `@Transactional` 加了等于白加——MyISAM 不支持事务,也没有回滚日志。连接照开、提交照发,但引擎层面就没有"回滚"这个概念。

```sql
SHOW TABLE STATUS LIKE 'order_info'\G
-- Engine: MyISAM  ← 看到这个就说明事务不会生效
```

上线前确认目标表全部是 **InnoDB**,这是事务能力的物理前提。

## 六、传播级别设置不当

`@Transactional(propagation = ...)` 一共七种,其中三种最容易被误用:

| 传播级别 | 行为 | 典型误解 |
|---|---|---|
| `REQUIRED`(默认) | 有事务就加入,没有就新建 | — |
| `REQUIRES_NEW` | **挂起**当前事务,另开一个独立事务 | 以为"同一个事务里的嵌套",实际是两个 |
| `NOT_SUPPORTED` | 挂起当前事务,以非事务方式执行 | 父方法有事务,子方法照样裸奔 |
| `NESTED` | 用 savepoint 实现嵌套,可局部回滚 | 只对 JDBC 有效,依赖 savepoint 支持 |

`REQUIRES_NEW` 有个特别隐蔽的坑:

```java
@Transactional
public void outer() {
    orderMapper.insert(order);
    try {
        innerService.innerMethod();   // REQUIRES_NEW,独立事务
    } catch (Exception e) {
        log.error("内层失败,已忽略", e);
    }
    // 外层继续,最后正常提交
}
```

内层是一个**独立的新事务**,它提交或回滚跟外层没有关系。外层后续如果异常回滚,内层写进去的数据**会永久留在库里**,形成典型的"局部回滚"错觉。这类结构一旦出现在资金、库存相关链路上,后果相当严重。

## 七、【最隐蔽】跨线程传递丢失

这一类跟线程池强相关,也是最不容易在测试环境暴露的一类。

事务管理器把 `Connection` 绑在**当前线程的 `ThreadLocal`** 里。当用线程池或 `new Thread()` 提交子任务时:

```java
@Transactional
public void parentMethod() {
    orderMapper.insert(order);

    threadPool.submit(() -> {
        childMethod();   // ❌ 这个子线程的事务与父线程毫无关系
    });

    // 父线程后续抛异常 -> 父事务回滚
    // 但子线程的事务早已独立提交,数据永久落库
}
```

问题有三层,一层比一层严重:

1. **子线程的 `ThreadLocal` 是全新的**,拿不到父线程绑定的那个 `Connection`;
2. 所以子线程里的 `@Transactional` 会在**一条新连接上开一个新事务**,无法与父事务合并,传播行为在跨线程处直接断裂;
3. 更致命的是**时序**:子线程跑完就提交了,父线程之后才回滚——子线程那部分数据成了无法撤销的孤儿。

| 维度 | 同线程内 | 跨线程 |
|---|---|---|
| `ThreadLocal` 中的连接 | 父线程的,复用 | 子线程自己的,全新 |
| 是否同一事务 | 是 | 否 |
| 传播行为是否有效 | 有效 | **失效** |
| 父线程回滚时子线程数据 | 一起回滚 | **已提交,回不去了** |

正确做法只有两条路:

- **要么串行**:必须在同一个事务里,就别用多线程,老老实实顺序执行;
- **要么放弃同一事务**:子任务不开事务,改用最终一致性方案——本地消息表 + MQ + 补偿任务。这也是绝大多数生产系统的选择:跨线程和跨服务本质上是同一个问题,**强一致要让位给最终一致**。

顺带一提,`@Async` 标注的方法会遇到完全相同的问题,它同样是切换了执行线程。

## 八、补一个极其隐蔽的点:多数据源

配置了主库 + 从库(或多数据源)时,`@Transactional` **默认只绑定默认的那个事务管理器**。如果在方法内部通过 `@DS`、`AbstractRoutingDataSource` 之类的手段切了数据源,事务管理器并不知情:

```java
@Transactional                                    // 绑定默认数据源的事务管理器
public void syncData(Data data) {
    masterMapper.insert(data);                    // 在事务内
    slaveMapper.insert(data);                     // 切了数据源 -> 不在事务内!
}
```

结果就是**部分操作在事务外执行**:主库的操作能回滚,从库那条已经提交了。修法是显式指定事务管理器:

```java
@Transactional(transactionManager = "slaveTransactionManager")
```

或者在方法内部避免跨数据源写入,把多数据源操作拆成两个独立事务,用补偿保证一致。

## 九、自查清单

上线前按这五条扫一遍,能拦住绝大多数事务问题:

- **看可见性**:事务方法是不是 `public`?
- **看调用方**:这次调用是不是经过了代理对象?同类内部调用一律不算。
- **看异常**:方法体内有没有吞掉异常?抛的是不是检查异常?`rollbackFor` 写了吗?
- **看引擎**:目标表是不是 InnoDB?
- **看线程与数据源**:事务链路里有没有 `threadPool.submit` / `@Async` / 数据源切换?有的话,事务边界就已经断了。

## 小结

- 事务生效依赖两块基石:**AOP 代理**和 **ThreadLocal 绑定连接**,任一被破坏即失效
- **非 public 方法**不在代理范围内,注解被静默忽略
- **类内部自调用**走的是 `this`,等于绕过代理,是最高频的失效原因
- 默认只对 **`RuntimeException` / `Error`** 回滚;异常被 catch 或抛出检查异常都会**正常提交**,用 `rollbackFor = Exception.class` 兜住
- **MyISAM 表没有事务能力**,这是数据库层面的硬前提
- `REQUIRES_NEW` 是**独立的新事务**,外层回滚救不回内层已提交的数据
- **跨线程等于跨事务**:子线程拿不到父线程的连接,父线程回滚也追不回子线程的提交,只能在"串行执行"和"最终一致性"之间选一条
- 多数据源场景必须**显式指定事务管理器**,否则部分写入会落在事务外

事务失效的共同特征是**静默**——它从不抗议,只是不再保护你。所以这些检查不该等出问题才做,而应该固化进代码评审的清单里。
