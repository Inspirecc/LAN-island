---
title: SSE 流式输出：让大模型边想边说
date: 2026-09-16
description: 大模型生成一段长回答可能要十几秒，用户盯着空白页面会以为卡死。SSE 让内容边生成边推送，把"首字延迟"从十几秒压到一秒内。这篇文章讲清 SSE 的原理、实现和踩坑点。
tags: [SSE, 流式输出, 大模型, 前端交互]
category: AI 与大模型
---

## 一、一个体验问题

大模型生成一段 500 字的回答,大约需要 10~20 秒。如果是同步接口,用户会看到:

```
点击提问 → 页面空白(等待 15 秒) → 答案突然整段出现
```

**这 15 秒里用户不知道发生了什么**:是没点上?是网络卡了?还是程序崩了?大量用户会在第 5 秒就刷新页面。

而如果改成流式输出,体验完全不同:

```
点击提问 → 0.5 秒后开始出字 → 文字像打字一样逐渐出现 → 完成
```

**总耗时没变,但感知完全不同。** 这就是流式输出的价值——它优化的不是速度,而是**感知速度**。

## 二、三种推送方案的对比

| 方案 | 原理 | 适用 |
|---|---|---|
| **短轮询** | 客户端定时问"好了吗" | ❌ 延迟高、请求多 |
| **长轮询** | 请求挂起,有数据才返回 | 配置推送等低频场景 |
| **SSE** | 单条 HTTP 连接,服务端持续推送 | ✅ **大模型流式输出** |
| **WebSocket** | 全双工长连接 | 双向实时通信(聊天室、协作) |

### 为什么大模型场景选 SSE

大模型输出是**单向的**:服务端生成 → 客户端展示。这个方向性让 SSE 成为天然选择:

| 维度 | SSE | WebSocket |
|---|---|---|
| 通信方向 | 单向(服务端→客户端) | 双向 |
| 协议 | 纯 HTTP | 需协议升级 |
| 实现复杂度 | 低 | 中 |
| 断线重连 | **浏览器自动重连** | 需自己实现 |
| 代理/网关兼容 | 好(就是 HTTP) | 部分代理需配置 |
| 鉴权 | 复用现有 HTTP 鉴权 | 需单独处理 |

**结论:单向推送用 SSE,双向通信才用 WebSocket。** 大模型输出是单向的,SSE 更简单也更合适。

## 三、SSE 的数据格式

SSE 的协议非常简单,就是**特定格式的纯文本流**:

```
data: 你好

data: ,我是

data: 一个AI助手

data: [DONE]

```

规则:

| 要素 | 说明 |
|---|---|
| 每条消息以 `data: ` 开头 | 后跟内容 |
| 消息之间用**两个换行**分隔 | `\n\n` |
| `data: [DONE]` | 约定俗成的结束标记(非协议规定) |
| `event: xxx` | 可选,指定事件类型 |
| `id: xxx` | 可选,用于断线重连定位 |
| `:` 开头的行 | 注释,常用于**心跳保活** |

**为什么要有心跳?** 长连接如果长时间没有数据,中间的代理(nginx、网关、CDN)可能认为连接空闲而断开。定期发一个注释行可以保持连接:

```
: heartbeat

```

## 四、服务端实现

### Spring Boot 的三种写法

**写法一:`SseEmitter`(Spring MVC)**

```java
@GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter stream(@RequestParam String question) {
    // 超时时间:根据最长回答时间设置,建议 5 分钟以上
    SseEmitter emitter = new SseEmitter(300_000L);

    executor.execute(() -> {
        try {
            // 调用大模型,逐块回调
            llmClient.streamChat(question, chunk -> {
                try {
                    emitter.send(SseEmitter.event().data(chunk));
                } catch (IOException e) {
                    // 客户端可能已断开,停止推送
                    throw new RuntimeException(e);
                }
            });
            emitter.send(SseEmitter.event().data("[DONE]"));
            emitter.complete();
        } catch (Exception e) {
            emitter.completeWithError(e);
        }
    });

    return emitter;
}
```

**关键点**:

- 必须**异步执行**,不能在请求线程里同步等待(会阻塞 Tomcat 线程池)
- 客户端断开时 `send()` 会抛 `IOException`,要捕获并停止后续推送——**否则会白白消耗模型调用额度**
- 超时时间要设够,默认可能只有 30 秒

**写法二:`Flux`(WebFlux 响应式)**

```java
@GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<String> stream(@RequestParam String question) {
    return llmClient.streamChatReactive(question)
        .concatWith(Flux.just("[DONE]"));
}
```

**WebFlux 天然适合流式场景**:它是非阻塞的,不需要手动管理线程池,背压(backpressure)也由框架处理。

**写法三:直接透传上游流**

如果大模型 API 本身就是 SSE,最省事的做法是**直接转发**,不做应用层解析:

```java
// 上游返回 SSE,直接透传给前端
@GetMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public void proxyStream(@RequestParam String question, HttpServletResponse response) throws IOException {
    response.setContentType("text/event-stream");
    response.setCharacterEncoding("UTF-8");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("X-Accel-Buffering", "no");   // 关键:禁用 nginx 缓冲

    try (InputStream upstream = llmClient.rawStream(question);
         OutputStream out = response.getOutputStream()) {
        upstream.transferTo(out);
        out.flush();
    }
}
```

**注意 `X-Accel-Buffering: no`** —— 这是 nginx 的专用响应头,告诉它**不要缓冲响应**。没有这行,nginx 会攒够一个 buffer 才转发,流式效果就完全消失了。这是最常见的"本地正常、上线就不流式"的原因。

## 五、客户端实现

```javascript
async function chat(question, onChunk) {
  const response = await fetch('/api/chat/stream?question=' + encodeURIComponent(question), {
    method: 'GET',
    headers: { 'Accept': 'text/event-stream' },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 消息以两个换行分隔
    const parts = buffer.split('\n\n');
    buffer = parts.pop();        // 最后一段可能不完整,留到下次

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;

      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      onChunk(data);
    }
  }
}
```

**两个关键细节**:

1. **`decoder.decode(value, { stream: true })`** —— 必须传 `stream: true`。一个 UTF-8 中文字符占 3 字节,而网络分块可能正好切在字符中间。不加这个参数会解码出乱码。
2. **保留不完整的尾部** —— 分块可能切在两条消息中间,`buffer` 要留给下一次拼接。

## 六、五个常见坑

| 坑 | 现象 | 解决 |
|---|---|---|
| **nginx 缓冲** | 本地流式,上线变一次性返回 | 加 `X-Accel-Buffering: no`,或 nginx 配置 `proxy_buffering off` |
| **响应头缺失** | 浏览器不按流处理 | `Content-Type: text/event-stream` + `Cache-Control: no-cache` |
| **中文乱码** | 出现 `�` 等乱码 | 前端 `TextDecoder` 加 `{ stream: true }` |
| **连接被提前关闭** | 长回答中途截断 | 调大超时;加心跳 |
| **客户端断开仍继续生成** | 白白消耗额度 | 捕获 `IOException`,及时取消上游请求 |

### 关于"客户端断开"的补充

这是个容易忽略的成本问题:用户等不及关掉页面,但服务端的模型调用**还在继续跑**,并且照样计费。

正确的做法是**把客户端的断开信号传递到上游**:

```java
emitter.onCompletion(() -> log.info("客户端正常完成"));
emitter.onTimeout(() -> log.warn("SSE 超时"));
emitter.onError(e -> {
    log.info("客户端断开,取消模型调用");
    llmClient.cancel();          // ← 关键:取消上游请求
});
```

对 Agent 类应用尤其重要——一个 Agent 可能串行调用模型 5 次,如果用户在第 1 次就断开了,后面 4 次调用都是纯浪费。

## 七、SSE 与 Flux 的取舍

| | SseEmitter (MVC) | Flux (WebFlux) |
|---|---|---|
| 编程模型 | 命令式,直观 | 响应式,有学习成本 |
| 线程占用 | 每次连接占一个线程 | 非阻塞,少量线程支撑大量连接 |
| 背压支持 | 无 | 有 |
| 适合 | 中小并发 | 高并发流式 |

**判断标准**:并发连接数在几百以内,MVC + SseEmitter 完全够用;如果要支撑上万个并发流式连接,WebFlux 的非阻塞模型优势明显。

**注意**:同一个应用里混用 MVC 和 WebFlux 需要谨慎,两者的线程模型不同,配置也更容易出错。

## 小结

- 流式输出优化的是**感知速度**,不是真实耗时——15 秒的回答仍是 15 秒,但首字延迟从 15 秒降到 0.5 秒
- 大模型输出是**单向**的,所以选 **SSE** 而不是 WebSocket
- SSE 格式极简:`data: xxx` + 双换行分隔;`[DONE]` 是约定标记
- 服务端三写法:**SseEmitter**、**Flux**、**直接透传上游流**
- 必须**异步执行**,不能在请求线程里同步等待
- 前端两个关键点:**`TextDecoder` 传 `{ stream: true }`**、**保留不完整尾部**
- 最常见的坑是 **nginx 缓冲**——加 `X-Accel-Buffering: no` 或关掉 `proxy_buffering`
- **客户端断开要及时取消上游调用**,否则白白消耗模型额度;Agent 多轮调用时尤其重要
- 并发量决定选型:几百连接用 MVC,上万连接考虑 WebFlux

流式输出是"低成本、高感知收益"的典型优化——**代码改动不大,但用户体验的提升立竿见影**。
