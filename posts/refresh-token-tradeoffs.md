---
title: Refresh Token 买的是体验，不是安全
date: 2026-03-09
description: 很多人以为配了 refresh token 就更安全，其实安全窗口完全没变——它买的是「用户不用反复登录」。这篇文章对比两种方案的真实差距，并拆解 refresh token 引入后的三个代价与六个必答问题。
tags: [JWT, 鉴权, 安全, 用户体验]
category: 微服务
---

## 一、先回答一个常见疑问

**不能直接设 JWT 的有效期吗?**

**能。** 设 TTL 就是设有效期,**refresh token 不是 JWT 的必需部分**,它是一个可选增强。

那它解决什么?

### 一个真实场景

用户连着逛 4 小时 App(家电比价很正常),access token 设 30 分钟:

| 时间点 | 方案A:只设 30 分钟 | 方案B:30 分钟 + refresh token |
|---|---|---|
| T+30 | 被强制登出 | 静默续期,无感 |
| T+60 | 被强制登出 | 静默续期,无感 |
| T+90 … T+210 | 每次都被强制登出 | 静默续期,无感 |
| **4 小时内被登出次数** | **7 次** | **0 次** |

从体验看,差距巨大——方案 A 的用户基本没法用。

### 但关键的是下面这两行

| | 方案A | 方案B |
|---|---|---|
| token 泄露后的可用窗口 | 30 分钟 | 30 分钟 |
| 用户点「退出」后的撤销窗口 | 30 分钟 | 30 分钟 |

> **★ 安全窗口完全一样。refresh token 买的是「用户体验」,不是「安全」。**

**撤销窗口始终由 access token 的 TTL 决定**;refresh token 的唯一作用是**让用户不用重新输密码**。

这句话是整块 JWT 知识里最值钱的一句——它说明你分得清「这个技术解决什么问题」和「它不解决什么问题」。多数人只会说「refresh token 用来刷新 token」,说不出它买的是什么。

## 二、为什么安全窗口没变

原因是**服务端的校验逻辑压根没变**。

网关每次请求做的还是那两件事:验签名、看过期时间。如果 access token 是 30 分钟,那么**任何一个已签发的 access token,无论用户做了什么,都能继续用满 30 分钟**。

refresh token 只是在 access token 过期**之后**提供了一个换取新 token 的途径。它管不到「已经签发出去的那个 access token 还能不能用」。

```
安全窗口 = access token 的 TTL
          ↑
     refresh token 改变不了这个值
```

想缩短安全窗口,唯一的办法是**把 access token 的 TTL 调小**——而 refresh token 的价值恰恰是让你**敢于把 TTL 调小**(因为用户体验由 refresh 兜住了)。

这是一个很微妙的因果:**refresh token 让「短 TTL」变得可行,但缩短窗口的是「短 TTL」本身,不是 refresh token。**

## 三、refresh token 的三个代价

引入它之后,复杂度是真实存在的:

| 代价 | 说明 |
|---|---|
| ① **必须安全存储** | 它是长期凭证,不能放 localStorage(XSS 能读),要放 HttpOnly Cookie 或 iOS Keychain / Android Keystore |
| ② **必须可撤销** | 它能持续换新 access token,**一旦被盗攻击者可以一直续期**。所以要存服务端(Redis / DB),退出登录时删掉 |
| ③ **并发刷新要处理** | 多个请求同时收到 401,客户端要加锁只发一次刷新,否则会刷出多个 token |

### 注意代价 ②

**这正是为什么「配了 refresh token 之后,退出登录才真正生效」**——撤销 refresh token 后,access token 一过期就**再也换不到新的**了。

但请注意措辞:是「**过期后**再也换不到」,不是「立刻失效」。当前那个 access token 在它剩余的 TTL 内依然有效。

## 四、完整实现:五个环节

### 1. 签发:双 token 一起给

```java
public TokenPair login(String username, String password) {
    User user = authenticate(username, password);

    // access token:短 TTL,用于业务请求
    String accessToken = Jwts.builder()
        .setSubject(user.getId())
        .claim("username", user.getUsername())
        .setId(UUID.randomUUID().toString())          // jti,供撤销用
        .setExpiration(new Date(System.currentTimeMillis() + 30 * 60 * 1000))
        .signWith(key)
        .compact();

    // refresh token:长 TTL,只用于换新 access token
    String refreshToken = UUID.randomUUID().toString().replace("-", "");

    // refresh token 必须存服务端,才可能撤销
    redis.setex("refresh:" + refreshToken, 7 * 24 * 3600,
                String.valueOf(user.getId()));

    return new TokenPair(accessToken, refreshToken);
}
```

**注意两个 token 的本质差异**:access token 是**自包含**的(JWT,服务端不存),refresh token 是**不透明字符串 + 服务端记录**(所以可撤销)。

### 2. 刷新:旧 refresh 换新的

```java
public TokenPair refresh(String refreshToken) {
    String userId = redis.get("refresh:" + refreshToken);
    if (userId == null) {
        throw new UnauthorizedException("刷新令牌无效或已过期");
    }

    // 轮换:立刻作废旧的 refresh token
    redis.del("refresh:" + refreshToken);

    // 签发新的双 token
    return issueTokens(userId);
}
```

**关键动作是 `del`**:每次刷新都换发新的 refresh token,旧的立刻作废。这叫 **refresh token 轮换(rotation)**。

### 3. 客户端:401 拦截 + 并发加锁

```javascript
let refreshing = null;   // 刷新中的 Promise,充当锁

axios.interceptors.response.use(null, async (error) => {
  const { config, response } = error;
  if (response?.status !== 401 || config._retried) {
    return Promise.reject(error);
  }

  // 多个请求同时 401 → 只发一次刷新,其余等同一个 Promise
  refreshing = refreshing || doRefresh();

  try {
    const newToken = await refreshing;
    config._retried = true;
    config.headers.Authorization = `Bearer ${newToken}`;
    return axios(config);            // 重放原请求
  } finally {
    refreshing = null;
  }
});
```

**这个 `refreshing` 变量就是「锁」**:第一个请求创建 Promise,后续请求直接复用,避免同时刷出多个 token。

### 4. 退出:删掉服务端记录

```java
public void logout(String accessToken, String refreshToken) {
    // ① refresh token 直接删,后续再也换不到新 token
    redis.del("refresh:" + refreshToken);

    // ② access token 进黑名单,让它剩余 TTL 内也失效
    Claims claims = parse(accessToken);
    long remain = claims.getExpiration().getTime() - System.currentTimeMillis();
    if (remain > 0) {
        redis.setex("black_token:" + claims.getId(), remain / 1000, "1");
    }
}
```

两步一起做,才能让「退出」立即生效。

### 5. 复用检测:被盗的兜底

如果**旧的 refresh token 被再次使用**,说明它已经被用过了——要么客户端有 bug,要么 token 被盗后攻击者在用旧的。

```java
public TokenPair refresh(String refreshToken) {
    String userId = redis.get("refresh:" + refreshToken);

    if (userId == null) {
        // 检查它是否是「曾经用过但已被轮换掉」的 token
        String usedBy = redis.get("refresh_used:" + refreshToken);
        if (usedBy != null) {
            // ⚠️ 复用检测命中:该用户的 refresh token 可能被盗
            // 作废整条会话链,强制重新登录
            redis.del("refresh_family:" + usedBy);
            log.warn("检测到 refresh token 复用,已作废用户 {} 的会话链", usedBy);
        }
        throw new UnauthorizedException("刷新令牌无效");
    }
    // ... 正常轮换逻辑
}
```

这个机制的思路是:合法客户端不会用旧的 refresh token(它在轮换时就拿到了新的)。出现复用,极可能是**同一个 token 被两方持有**。

## 五、如果要用它,先过这六关

| # | 问题 | 要能答 |
|---|---|---|
| 1 | refresh token 存在哪? | 客户端:HttpOnly Cookie / Keychain;服务端:Redis 或 DB |
| 2 | access token 过期怎么续? | 客户端拦截 401 → 调刷新接口 → 拿新 token → 重放原请求 |
| 3 | 多个请求同时 401? | 客户端加锁,只发一次刷新,其他请求等结果 |
| 4 | refresh token 自己也过期? | 跳登录页,重新登录 |
| 5 | 退出登录怎么让它失效? | 服务端删掉那条记录 |
| 6 | **refresh token 被盗怎么办?** | **轮换 + 复用检测**:每次刷新都换发新的 refresh、旧的作废;如果旧 refresh 被再次使用,说明被盗,**作废整条会话链** |

第 6 关是进阶项,能答出来说明对安全边界有真实理解——但它也说明:**refresh token 一旦引入,复杂度是真实存在的**。

## 六、四个容易混淆的问题

| 问题 | 怎么答 |
|---|---|
| 加了黑名单,跟用 Session 有什么区别? | 区别在两块:① JWT 不用存**全量会话**,黑名单里只有已撤销的那一小部分,量级小得多;② **token 自带用户信息**,网关验签就能拿到 user_id,下游服务透传身份也不用查存储。所以优势还在,只是不再是「完全无状态」 |
| 改密码之后,旧 token 还能用吗? | 纯 JWT 下能用——token 里只有 uid,没有密码版本这个概念,服务端验证时压根不看密码。要堵住就得加 `token_version`,改密码时 +1,旧 token 版本对不上就全部失效 |
| 手机上退出,希望电脑端也一起退出? | 不能只用 jti 黑名单——jti 是**单个 token** 的标识,拉黑只能拉黑手机那一个,电脑端完全不受影响。全端下线必须用**用户级版本号**;代价是网关每个请求要知道「当前版本号是多少」,可以用本地缓存 + 短过期降低开销 |
| 既然要加状态,当初为什么用 JWT 不用 Session? | 诚实反而更好:「如果只有一个单体应用、又要求强撤销,Session 更简单,我也认同。选 JWT 主要是微服务下 token 要跨服务传递,以及 App / 小程序 / H5 的多端场景。但 JWT 不是免费的——它把『撤销能力』换成了『无状态』。今天重新选,我会先问清业务对『即时下线』的要求有多强,再决定用哪套」 |

## 七、三个要避开的误区

| 误区 | 为什么错 |
|---|---|
| ❌「JWT 是无状态的,所以性能好」 | 下一句必然是「那退出登录怎么办」,立刻被动 |
| ❌「配了 refresh token 就更安全」 | 安全窗口完全一样,它买的是体验 |
| ❌「JWT 很安全,签名没法伪造」 | 签名防的是**篡改**,防不了**盗用**——这是两个不同的威胁 |

## 小结

- refresh token **不是 JWT 的必需部分**,是可选增强
- 它解决的是**用户体验**(不用反复登录),**不改变安全窗口**
- 安全窗口始终等于 **access token 的 TTL**——想缩短窗口就调小 TTL
- 三个代价:**必须安全存储**、**必须可撤销**、**并发刷新要加锁**
- 完整实现五环节:签发双 token → 轮换刷新 → 401 拦截加锁 → 退出双删 → 复用检测
- refresh token 是**不透明字符串 + 服务端记录**,这才能撤销;access token 是自包含 JWT,所以撤销要靠黑名单或版本号
- 说得出「它买的是体验不是安全」,才算真的理解了这个机制

很多技术方案的宣传语会强调它带来的好处,但理解一个方案的边界,往往比记住它的优点更重要。refresh token 就是一个典型例子。
