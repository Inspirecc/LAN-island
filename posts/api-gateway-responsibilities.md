---
title: API 网关到底该做什么
date: 2026-02-27
description: 网关不是「反向代理换个名字」。路由和负载均衡只是它的入场券,真正的价值在于把鉴权、限流、日志这些每个服务都要写一遍的横切逻辑收拢到一处。这篇讲清网关的六项职责、断言与过滤器模型,以及它和 Nginx 的分工。
tags: [微服务, API 网关, Spring Cloud Gateway, 鉴权]
category: 微服务
---

## 一、网关最容易做错的一件事

很多团队引入网关之后,架构图上多了一个方框,但代码里什么都没变:每个微服务仍然各自解析 token、各自写 CORS 配置、各自记一遍请求日志。网关退化成了一个会转发请求的 Nginx。

这不叫网关,这叫**多了一跳网络开销**。

判断网关有没有用到位,有个很简单的标准:

> **随便挑一个横切关注点——鉴权、限流、日志、跨域——如果它在两个以上微服务里都有一份实现,那网关就没做对。**

网关的本质不是「加一层代理」,而是**把分散在 N 个服务里的公共逻辑收敛到 1 个地方**。想清楚这一层,后面所有的设计取舍都顺了。

## 二、六项职责

### 1. 路由转发

按规则把外部请求转发到对应的后端服务。规则一般基于路径、请求头、Host 或者查询参数。

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-service
          uri: lb://order-service          # lb:// 表示走服务发现取实例
          predicates:
            - Path=/api/order/**
          filters:
            - StripPrefix=2                # 去掉 /api/order 前缀再转发
```

`lb://` 这个前缀很关键。它不是写死的地址,而是告诉网关「去注册中心查 order-service 的实例列表,自己挑一个」。这一行就同时完成了服务发现和负载均衡。

### 2. 负载均衡

同一个服务多实例时,网关负责把请求分散出去。默认是轮询,也可以换成权重、最少连接、同机房优先等策略。

要注意网关的负载均衡和 RPC 框架(比如 Dubbo、Feign)的负载均衡是**两个层次**的事:网关做的是南北向流量的第一跳分发,RPC 框架做的是服务之间东西向流量的分发。两者互不替代。

### 3. 统一鉴权认证

这是网关价值最大的地方。登录 token 的校验、权限判断全放网关,后端服务不再重复写鉴权代码。

网关验完签之后,把解析出的用户身份放进请求头透传给下游:

```java
// 网关过滤器:验签通过后注入用户身份,下游服务直接读取
ServerHttpRequest mutated = exchange.getRequest().mutate()
        .header("X-User-Id", String.valueOf(userId))
        .header("X-User-Role", role)
        .build();
chain.filter(exchange.mutate().request(mutated).build());
```

下游服务从 `X-User-Id` 里直接拿用户 ID,不需要再引入 JWT 依赖、不需要再配一次密钥。

**这里有个必须处理的安全细节**:上游传进来的 `X-User-Id` 是不可信的,客户端完全可以自己伪造一个。所以网关在注入之前,必须先把客户端传来的同名请求头**删掉**:

```java
// 先清理客户端可能伪造的头部,再注入网关验签后的可信值
ServerHttpRequest mutated = exchange.getRequest().mutate()
        .headers(h -> h.remove("X-User-Id"))
        .header("X-User-Id", String.valueOf(userId))
        .build();
```

漏了这一步,就等于给所有接口开了个「任意用户身份」的后门。而且这个漏洞非常隐蔽:功能测试完全正常,只有人刻意构造请求头时才会暴露。

### 4. 全局横切逻辑

跨域、请求日志、参数校验、响应包装、链路追踪的 traceId 注入,全在这一层做。

```yaml
spring:
  cloud:
    gateway:
      globalcors:
        cors-configurations:
          '[/**]':
            allowedOrigins: "https://example.com"
            allowedMethods: [GET, POST, PUT, DELETE]
            allowCredentials: true
            maxAge: 3600
```

跨域尤其适合放网关。浏览器发起的预检请求(OPTIONS)会被网关直接拦下返回,压根到不了后端服务——省掉每个服务都配一遍 CORS 的重复劳动,也省掉一堆莫名其妙的预检失败排查。

### 5. 流量管控

限流、熔断降级放在网关,是保护后端的第一道闸门。这一层的意义在于**把无效流量拦在门外**,不要让它们穿透到服务里再被拒绝——穿透本身就是成本。

```yaml
filters:
  - name: RequestRateLimiter        # Spring Cloud Gateway 内置的限流过滤器
    args:
      redis-rate-limiter.replenishRate: 100    # 令牌桶填充速率 = 长期平均 QPS
      redis-rate-limiter.burstCapacity: 200    # 桶容量 = 允许的瞬时突发量
      key-resolver: "#{@ipKeyResolver}"        # 按 IP 限流
```

### 6. 接口聚合

把多个微服务的接口结果合并成一个响应返回给前端,减少客户端往返次数。

这个能力要克制使用。聚合意味着网关要知道业务语义、要处理部分失败的降级逻辑,BFF(Backend For Frontend)层做这件事通常比网关合适。网关里的聚合逻辑一旦复杂起来,它会变成一个新的单体。

## 三、Spring Cloud Gateway 的模型:断言 + 过滤器

Spring Cloud Gateway 的核心只有两个概念。

**断言(Predicate)决定「这个请求归哪条路由管」**,多个断言之间是「与」的关系:

```yaml
predicates:
  - Path=/api/order/**
  - Method=POST
  - Header=X-Client-Version, v2.*      # 支持正则
  - Query=debug, true
```

**过滤器(Filter)决定「这个请求在转发前后要做什么」**。按作用范围分两种:

| 类型 | 声明方式 | 作用范围 | 典型用途 |
|---|---|---|---|
| GatewayFilter | 挂在某条 route 的 `filters` 下 | 只对这条路由生效 | 去前缀、加请求头、局部限流 |
| GlobalFilter | 实现 `GlobalFilter` 接口 | **所有路由**都生效 | 鉴权、全局限流、日志、traceId |

这两者的执行顺序由 `Ordered` 接口的返回值决定,数值越小越先执行。一次请求的完整处理链是一个「洋葱模型」:

```
请求进来
  ↓ 前置过滤器(pre filter)按 order 从小到大依次执行
  ↓ 转发到后端服务
  ↑ 后置过滤器(post filter)按 order 从大到小依次返回
响应返回客户端
```

这个模型解释了一个常见困惑:**为什么在 pre 阶段加的响应头会覆盖 post 阶段的?** 因为它们操作的是同一个 `exchange` 对象,先执行完的 pre filter 已经把值写进去了。

一个自定义的全局鉴权过滤器大概长这样:

```java
@Component
public class AuthGlobalFilter implements GlobalFilter, Ordered {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String token = exchange.getRequest().getHeaders().getFirst("Authorization");

        // 白名单直接放行(登录、注册、健康检查等)
        if (isWhiteList(exchange.getRequest().getPath().value())) {
            return chain.filter(exchange);
        }
        if (token == null || !jwtUtil.verify(token)) {
            exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
            return exchange.getResponse().setComplete();   // 直接结束,不再往下走
        }
        // 验签通过,注入可信用户身份后继续
        return chain.filter(exchange.mutate()
                .request(exchange.getRequest().mutate()
                        .header("X-User-Id", jwtUtil.getUserId(token))
                        .build())
                .build());
    }

    @Override
    public int getOrder() {
        return -100;      // 负数,保证在转发前的最早阶段执行
    }
}
```

注意 `Ordered` 返回 `-100`。全局鉴权的 order 必须比业务过滤器和转发动作都小,否则会出现「先转发到后端、再验签」的荒谬情况——请求已经打到服务上了,才发现 token 无效。

Spring Cloud Gateway 基于 WebFlux 和 Reactor Netty 实现,全程异步非阻塞。**这带来一个硬性约束:过滤器里不能写阻塞代码。** 在过滤器中调用同步的 JDBC、`Thread.sleep`、或者阻塞式 HTTP 客户端,会占死 Netty 的事件循环线程,整个网关的吞吐会断崖式下跌。这类操作必须包进 `Mono.fromCallable(...).subscribeOn(Schedulers.boundedElastic())` 切到弹性线程池。

## 四、鉴权为什么该放在网关

除了显而易见的「少写 N 遍代码」,还有三个更实质的理由。

**第一,信任边界只有一处。** 所有外部流量必须过网关,那网关就是系统唯一的外部入口。鉴权放在这里意味着「校验点」和「边界」重合,不存在某个接口忘记加注解就被绕过的可能。放在各个服务里则相反:新增一个接口、忘了加 `@PreAuthorize`,就是一个未授权访问漏洞。

**第二,拒绝成本最低。** 未登录、签名错误、权限不足的请求在网关就被挡回去了,不会占用后端服务的线程、连接和数据库资源。在网关被拒一个请求的代价,和穿透到订单服务、走完参数校验、查一次数据库再被拒,差着两三个数量级。

**第三,身份解析只做一次。** 一次业务请求可能串联五六个微服务。如果每个服务都独立解析 JWT,就要重复验签五六次,还要在每个服务里配置同一份密钥——密钥泄露面成倍扩大。网关解析一次、以请求头向下透传,链路后段的成本降为零。

### 但也别全都塞进网关

网关鉴权有两个明确的边界:

- **细粒度的数据权限不要放网关**。比如「只能查自己部门的订单」,这类判断依赖具体业务数据和查询条件,放网关只能靠调用后端接口来判断,反而多一次网络往返。
- **服务间调用不走网关**。内部 RPC 调用应该用自己的认证机制(比如内部 token、mTLS),让它绕开网关直连,否则所有内部调用都要多绕一跳,延迟和单点风险都不划算。

合理的分工是:**网关负责「你是谁、你有没有登录」,服务负责「你能不能操作这条数据」**。

## 五、网关和 Nginx 怎么分工

这是最常被混淆的一点。两者都能转发请求、都能做负载均衡,Nginx 甚至也能配 Lua 做鉴权和限流,看起来功能重叠。但它们的定位完全不同。

| 维度 | Nginx | API 网关(Spring Cloud Gateway) |
|---|---|---|
| 所在层次 | 接入层 / 边缘层 | 应用层 |
| 核心能力 | 静态资源、TLS 卸载、四层/七层代理、高性能转发 | 业务级路由、动态鉴权、服务发现集成 |
| 路由配置 | 静态配置文件,变更需 reload | 从注册中心动态获取,新服务上线自动可路由 |
| 服务发现 | 无,需要手工维护 upstream 列表 | 原生集成,`lb://service-name` 直接可用 |
| 扩展方式 | C/C++ 模块、OpenResty/Lua | Java 代码,和业务系统同一套语言与框架 |
| 性能 | 十万级 QPS,单机极高 | 万级 QPS,受 JVM 和业务逻辑影响 |
| 动态性 | 弱,配置变更多半要重载 | 强,规则可运行时下发(如接 Nacos 配置中心) |

合理的架构是**两者都留,各管一段**:

```
客户端
  ↓
Nginx(Layer 1)
  · TLS 卸载、HTTP/2、gzip
  · 静态资源直接返回
  · 按域名/路径做粗粒度分流
  · 扛住绝大部分无效流量(恶意扫描、超大包)
  ↓
API 网关(Layer 2)
  · 动态路由到微服务
  · JWT 验签、用户身份透传
  · 接口级限流、熔断降级
  · 请求日志、traceId 注入
  ↓
微服务集群
```

分工的原则是:**Nginx 处理「和业务无关的流量问题」,网关处理「和业务相关的路由与策略问题」**。

具体到几个易混淆的点:

- **限流放哪?** Nginx 做基于 IP、连接数的粗粒度限流(防爬虫、防 CC 攻击);网关做基于用户 ID、接口维度的细粒度限流(防单个用户刷接口)。前者保护基础设施,后者保护业务。
- **鉴权放哪?** 只在网关做。Nginx 层配置用户鉴权规则需要 reload,和业务系统的用户体系同步成本太高。
- **能不能不要网关?** 可以,但那样就得在 Nginx 里用 Lua 手搓一套服务发现 + 鉴权 + 限流。功能等价,可维护性差一大截——所有规则变成 Lua 脚本,业务团队改不动。

## 六、小结

- 网关的价值不在「转发」,而在**把横切逻辑从 N 个服务收敛到 1 处**;判断标准是「同一段鉴权代码有没有出现两遍」
- 六项职责:路由转发、负载均衡、统一鉴权、全局横切逻辑、流量管控、接口聚合
- Spring Cloud Gateway 的模型是**断言决定走哪条路由、过滤器决定路上做什么**;`GlobalFilter` 的 order 必须早于转发动作
- 网关鉴权必须**先删除客户端伪造的同名请求头,再注入验签结果**,否则等于开了任意身份的后门
- 网关基于 WebFlux,过滤器里**严禁阻塞调用**,否则会打满 Netty 事件循环
- 网关与 Nginx 是**分层互补**:Nginx 管和业务无关的流量,网关管和业务相关的策略
- 边界要守住:细粒度数据权限放回服务,内部 RPC 调用不绕网关

把「收敛」这两个字记住,网关的绝大部分设计问题都能自己推导出答案:凡是「每个服务都要写一遍」的逻辑,就应该往网关搬;凡是「只有这一个服务需要」的逻辑,搬上去就是过度设计。
