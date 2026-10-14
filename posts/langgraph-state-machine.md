---
title: 用 LangGraph 构建客服状态机
date: 2026-05-28
description: 把多轮流程写在提示词里,同一句话跑两次可能走两条不同路径,线上出问题还无法复现。LangGraph 用「显式状态 + 节点 + 条件边」把隐式流程变成可画、可测、可恢复的图,这篇讲清它的建模方式和分流判据该怎么选。
tags: [LangGraph, LangChain, Agent, 状态机]
category: AI 与大模型
---

## 一、从一次无法复现的故障说起

一个售后客服 Agent 接到用户这句话:「我买完就降价了,赔我 1.2 倍差价」。

流程是写在系统提示词里的:先确认身份,再抽取订单号,判断是否在保价期,最后生成答复。逻辑很清楚,提示词也写得很详细。但同一句话连跑五次,可能得到五条路径:

```
第 1 次:意图识别 → 判为「赔付」 → 询问订单号 → 规则判定 → 生成答复
第 2 次:意图识别 → 判为「闲聊」 → 推荐商品(跑偏了)
第 3 次:意图识别 → 判为「赔付」 → 跳过询问直接判定(缺订单号) → 判定失败
第 4 次:意图识别 → 判为「退货」 → 走退货流程(错的)
第 5 次:意图识别 → 判为「赔付」 → 询问订单号 → 又问了一遍 → … → 生成答复
```

最要命的不是这五条路径里有一条错了,而是**这件事无法复现**:用户投诉"AI 乱答",你在测试环境重跑一遍,可能一切正常。

根因很清楚:

> **流程是隐式的。提示词里写「你应该先确认订单号」,但模型不一定会听话。**

大模型每次生成都是采样,提示词是一段**建议**而不是**约束**。只要你把控制流交给它,同一输入跑出不同路径就是必然结果。

**解法不是把提示词写得更严厉,而是把控制流从模型手里拿回来。**

## 二、为什么需要图:LangChain 的边界在哪

LangChain 和 LangGraph 经常被放在一起提,但两者解决的问题不同。

| | LangChain | LangGraph |
|---|---|---|
| 抽象单位 | Chain(链):一串顺序执行的步骤 | Graph(图):节点 + 边 + 共享状态 |
| 控制流 | 基本是**线性**的,分支靠少量封装 | **任意**分支、循环、并行,显式声明 |
| 状态 | 在步骤间隐式传递 | **显式定义**的 State,所有节点共享 |
| 循环 | 不擅长,容易写成递归 | 原生支持,配合轮次上限可控 |
| 中断/恢复 | 无内建机制 | **checkpointer** 持久化,可按 thread 恢复 |
| 可观测性 | 步骤日志 | 每个节点可单独测试、整图可画出来评审 |

一句话概括:

> **LangChain 擅长「把一次调用串起来」,LangGraph 擅长「把一个有状态的多轮流程管起来」。**

售后客服恰好是后者的典型:它是有状态的(要记住抽到的订单号)、带分支的(能自动判定就生成答复,判不了就转人工)、可能需要循环的(信息不足就要再问一轮)、而且必须持久化(用户半小时后回来要接着聊)。

用链式调用实现它,最后一定会写成一大坨 `if/else` 加递归——**流程藏在代码里,既画不出来也测不了单个环节**。

## 三、三个基本元素:State、节点、边

LangGraph 的核心只有三个概念。

### State:单一可信状态源

State 是一份在所有节点间共享的结构化数据。设计它的关键是**分层**——把控制流字段、槽位字段、消息字段分开:

```python
from typing import TypedDict, Annotated, Literal
from langgraph.graph.message import add_messages

class AfterSalesState(TypedDict):
    # ── 控制字段:决定图往哪走 ──
    intent: Literal["after_sales", "shopping", "chitchat"] | None
    need_human: bool
    turn_count: int                      # 防止图跑飞的轮次计数

    # ── 槽位字段:从对话里抽取的结构化事实 ──
    order_no: str | None
    price_evidence: str | None
    issue_type: str | None
    missing_slots: list[str]             # 还缺哪些信息

    # ── 结果字段 ──
    rule_result: dict | None             # 规则引擎的确定性判定结果
    rag_hits: list[dict]                 # 召回的政策片段
    reply: str | None

    # ── 消息字段:给模型看的对话历史 ──
    messages: Annotated[list, add_messages]
```

三条设计原则:

1. **控制字段和内容字段分开。** 路由判断只读控制字段,不去解析自然语言。这样"为什么走了这条路"永远可查。
2. **槽位字段是结构化的,不是文本。** 订单号是 `order_no` 这个字段,不是历史里的一句话。字段可以被校验、被查询、被传给规则引擎。
3. **`messages` 用 reducer 累加。** `Annotated[list, add_messages]` 表示这个字段的更新方式是**追加合并**而非覆盖。这是 LangGraph 的一个关键机制,下面会展开。

### 节点:一个纯函数

节点是图上的一个处理步骤,签名统一为 `State → 部分更新`:

```python
def extract_info(state: AfterSalesState) -> dict:
    """从用户消息里抽取订单号等结构化信息"""
    resp = llm.invoke(build_extract_prompt(state["messages"]))
    data = parse_json_safely(resp)          # 解析失败要有兜底

    missing = [k for k in ("order_no", "issue_type") if not data.get(k)]
    return {
        "order_no": data.get("order_no"),   # 只返回要更新的字段
        "issue_type": data.get("issue_type"),
        "missing_slots": missing,
    }
```

节点只返回**自己要改的字段**,不用返回整个 State。这种"部分更新"的写法让每个节点的职责边界非常清楚。

### 边:决定下一步去哪

边分两种:

- **普通边**(`add_edge`):固定跳转,A 做完一定到 B
- **条件边**(`add_conditional_edges`):根据 State 里的字段动态选路

条件边是整张图的灵魂,它把"分支判断"从模型手里拿回到代码里:

```python
def route_after_extract(state: AfterSalesState) -> str:
    """抽取完信息后,决定接着干什么"""
    if state["need_human"]:
        return "handoff"                     # 已经是人工流程,直接转
    if state["missing_slots"]:
        return "ask_missing"                 # 信息不全 → 再问一轮
    return "rule_check"                      # 信息齐了 → 走规则判定
```

注意这个函数的性质:**它是一个普通的、可单元测试的 Python 函数**。输入 State,输出一个字符串,没有模型参与,没有随机性。这就是整张图能够"跑五次路径完全一致"的根本原因。

### 把图拼起来

```python
from langgraph.graph import StateGraph, START, END

builder = StateGraph(AfterSalesState)

builder.add_node("classify", classify_intent)      # 意图识别
builder.add_node("extract", extract_info)          # 信息提取
builder.add_node("ask_missing", ask_missing)       # 索取缺失信息
builder.add_node("rule_check", rule_engine_check)  # 规则引擎判定
builder.add_node("rag_policy", rag_lookup)         # 查赔付政策
builder.add_node("generate", generate_reply)       # 生成答复
builder.add_node("handoff", to_human)              # 转人工

builder.add_edge(START, "classify")
builder.add_conditional_edges("classify", route_by_intent,
    {"after_sales": "extract", "shopping": "generate", "chitchat": "generate"})
builder.add_edge("extract", "ask_missing")   # 占位,真实跳转见条件边
builder.add_conditional_edges("extract", route_after_extract,
    {"ask_missing": "ask_missing", "rule_check": "rule_check", "handoff": "handoff"})

# 问完再回到抽取节点 —— 这就是一个受控的循环
builder.add_edge("ask_missing", "extract")

builder.add_conditional_edges("rule_check", route_after_rule,
    {"generate": "rag_policy", "handoff": "handoff"})
builder.add_edge("rag_policy", "generate")
builder.add_edge("generate", END)
builder.add_edge("handoff", END)

graph = builder.compile(checkpointer=checkpointer)
```

画出来是这样:

```
                        ┌──────────┐
        START ─────────▶│ classify │  意图识别
                        └────┬─────┘
              ┌──────────────┼──────────────┐
       售后 │        导购/闲聊 │              │
              ▼              ▼              │
        ┌──────────┐   ┌──────────┐         │
        │ extract  │   │ generate │◀────────┘
        └────┬─────┘   └──────────┘
             │
     ┌───────┼────────────┐
  缺信息   判不了      信息齐
     │       │            │
     ▼       ▼            ▼
┌──────────┐ │      ┌────────────┐
│ask_missi │ │      │ rule_check │  规则引擎(确定性)
└────┬─────┘ │      └──────┬─────┘
     │       │      ┌──────┴──────┐
     │       │   能自动判定    超权限/证据不足
     │       │      │             │
     └───────┼──────┼─────────────┼──▶ ┌──────────┐
      回 extract   ▼              └───▶│ handoff  │ 转人工
              ┌────────────┐           └──────────┘
              │ rag_policy │ 查政策
              └──────┬─────┘
                     ▼
              ┌────────────┐
              │  generate  │ 生成答复
              └──────┬─────┘
                     ▼
                    END
```

> **这张图能直接拿去和业务方评审。** 这是把流程显式化最直接的收益——以前流程藏在提示词和代码里,只有开发者自己知道;现在它是一张谁都能看的图。

## 四、分流判据:为什么不用置信度阈值

"什么时候该转人工"是这类系统里最关键的一个决策点。一个很自然的设计是:**让模型给自己打一个 0~1 的置信度分数,低于阈值就转人工。**

**这个方案不可靠。** 原因有三层:

| | 传统分类模型 | 大模型 |
|---|---|---|
| 输出 | 概率分布 `[0.92, 0.05, 0.03]` | 一段自然语言文本 |
| 置信度从哪来 | 模型内部归一化算出来的 | **没有统一的置信度** |
| token logprob | — | 只反映"这个词出现的概率",**不等于"答案正确"的概率** |

更麻烦的是**过度自信**:模型编造一个订单号时,和给出正确订单号时的"自我感觉"是一样的。让它自评一个 0~1 的分数,高分区也达不到它声称的水平。

把三种可行的判据放在一起比:

| 判据 | 自动处理中出错的风险 | 说明 |
|---|---|---|
| **模型自评置信度** | **高** | 过度自信,阈值形同虚设 |
| **外部模型分数**(如重排得分) | 中 | 仍是概率性的,分布会有重叠 |
| **确定性校验** | **最低** | 是/否判断,不是概率 |

> **判断标准只有一条:这个信号是「概率」还是「确定的是/否」?**
>
> **概率只能当参考,是/否才能做分流依据。**

所以条件边的判据应该落在**确定性校验**上:

```python
def rule_engine_check(state: AfterSalesState) -> dict:
    """规则引擎做确定性判定 —— 不用任何模型分数"""
    order = order_mapper.selectByNo(state["order_no"])

    # 校验 1:订单号必须能回库查到
    if order is None:
        return {"need_human": True, "rule_result": {"reason": "订单不存在"}}

    # 校验 2:金额必须对得上
    if order.getUserId() != state["user_id"]:
        return {"need_human": True, "rule_result": {"reason": "订单归属不符"}}

    # 校验 3:是否在保价期内 —— 日期比较,确定性的
    days = (order.getPayTime().date() - today()).days
    if days < -PRICE_PROTECT_DAYS:
        return {"need_human": True, "rule_result": {"reason": "超出保价期"}}

    # 赔付金额是确定性计算,不交给模型算
    diff = order.getPayAmount() - current_price(order.getSkuId())
    return {"rule_result": {"refund": diff, "within_period": True},
            "need_human": False}
```

这里有一个容易被忽略的重点:**"订单号回库查"不是额外加的一道机制,而是这个业务流程本来就要求的一步。**

规则引擎要算"买贵赔付",本来就必须拿到真实的订单数据——订单号、购买时间、下单金额。这些数据**只能回库查,不可能靠模型编**。所以用"能不能查到"作为分流判据,不增加任何额外复杂度,却把可靠性从"概率"提到了"是/否"。

**还有一个反过来的原则:确定性计算不要交给大模型。**

赔付金额 = 差价 × 1.2。这是一次乘法和一次比较,应该在规则引擎里用代码算完,把结果作为事实塞进 Prompt 让模型组织语言。让模型"算"这个数字,等于主动引入一个不确定的环节——它可能算对,也可能算错,而且错得毫无规律。

> **模型负责「怎么说」,规则引擎负责「是多少」。**

## 五、循环与终止条件

图里最容易出事的地方是**环**。上面的 `ask_missing → extract` 就是一个环:信息不全就再问一轮,问完再抽取。

它能带来正确的行为(反复询问直到信息齐全),但也可能永远转下去。防护有两个层次:

| 层次 | 手段 | 作用 |
|---|---|---|
| **提示层** | 同一槽位最多询问 N 次(如 2 次),超了就转人工 | 避免用户体验上被反复盘问 |
| **兜底层** | 整图 `turn_count` 上限(如 10 轮),超出强制终止 | 防止各种原因导致的无限循环 |

```python
MAX_TURNS = 10
MAX_ASK_PER_SLOT = 2

def route_after_extract(state: AfterSalesState) -> str:
    # 兜底:总轮次超限,无论如何都终止
    if state["turn_count"] >= MAX_TURNS:
        return "handoff"
    # 提示层:同一件事问过两遍还问不出来,交给人工
    if state["missing_slots"] and state["ask_count"].get(
            state["missing_slots"][0], 0) >= MAX_ASK_PER_SLOT:
        return "handoff"
    if state["missing_slots"]:
        return "ask_missing"
    return "rule_check"
```

**终止条件必须显式写出来,不能指望"模型会自己结束"。** 这是显式状态机相对隐式流程最大的优势之一:循环是图上的一个环,你能看见它、能数它转了几圈、能在任何一圈把它掐掉。

## 六、持久化与人工介入

### 持久化:checkpointer

不带持久化的图是有状态的,但状态只在内存里——服务一重启、用户一离开,全丢。用户的感受是"我刚才不是说了订单号吗"。

LangGraph 的做法是 **checkpointer**:每一步状态变更都落盘,并和 `thread_id` 关联:

```python
from langgraph.checkpoint.redis import RedisSaver

checkpointer = RedisSaver.from_conn_string("redis://localhost:6379")
graph = builder.compile(checkpointer=checkpointer)

# 同一个 thread_id = 同一个会话
config = {"configurable": {"thread_id": f"session:{session_id}"}}

# 第一次调用
graph.invoke({"messages": [user_msg], "turn_count": 0}, config)

# 用户半小时后回来 —— 直接从上次的状态继续
graph.invoke({"messages": [new_msg]}, config)
```

它带来三个直接好处:

1. **服务重启不丢状态**——状态在 Redis/MySQL 里,不在进程内存里
2. **用户可以中断再回来**——不需要重说一遍
3. **可以回溯**——每一步的 State 快照都留着,线上出问题能查"当时到底走到哪个节点、State 是什么"

第 3 点解决的就是开头那个"无法复现"的问题:**有了每步快照,路径不一致这件事从"偶发玄学"变成了"可查数据"。**

### 人工介入:human-in-the-loop

转人工不是"把对话扔给客服"这么简单。关键是**把完整的 State 一起交过去**——客服打开工作台时应该看到:

- 用户的原始诉求是什么
- 已经抽取到的订单号、金额、凭证
- 规则引擎为什么判不了(具体是哪一条校验没过)
- 已经给用户回复过什么

```python
def to_human(state: AfterSalesState) -> dict:
    ticket = {
        "thread_id": state["thread_id"],
        "intent": state["intent"],
        "slots": {k: state[k] for k in ("order_no", "issue_type", "price_evidence")},
        "rule_reason": (state["rule_result"] or {}).get("reason"),
        "rag_hits": [h["title"] for h in state["rag_hits"]],
        "history": state["messages"][-6:],       # 最近几轮原文
    }
    ticket_service.create(ticket)
    return {"reply": "已为您转接人工客服,请稍候。"}
```

LangGraph 还可以在**图执行到一半时中断**,由人工确认后再继续——比如"模型建议赔付 120 元"这个动作,可以先 suspend,等客服点了确认再往下走。这个能力在涉及金额的场景里很有价值。

## 七、小结

- 流程写在提示词里是**隐式的**:同一输入会跑出不同路径,而且线上问题无法复现
- **LangChain 管「把一次调用串起来」,LangGraph 管「把有状态的多轮流程管起来」**——需要分支、循环、状态持久化时选后者
- 三个基本元素:**State**(单一可信状态源)、**节点**(纯函数,只返回要改的字段)、**边**(普通边 + 条件边)
- State 分三层:**控制字段**(决定路由)、**槽位字段**(结构化事实)、**消息字段**(给模型看的对话),控制字段和内容字段必须分开
- **条件边是普通函数**,无模型参与、无随机性——这是路径可复现的根本原因
- 分流判据用**确定性校验,不用置信度阈值**:模型自评过度自信,logprob 不等于正确率
- 判据的本质区别是**「概率」还是「确定的是/否」**——只有后者能做分流依据
- **确定性计算(赔付金额)交给规则引擎,不交给模型**;模型负责"怎么说",规则引擎负责"是多少"
- 凡是环都要有终止条件:**单槽位询问次数上限 + 整图轮次上限**,双重防护
- **checkpointer + thread_id** 让状态可恢复、可回溯,把"路径不一致"从玄学变成可查数据
- 转人工要把**完整 State** 交给工作台,而不是只丢一句对话

把流程从提示词里搬进图里,本质上做了一件事:**把「希望模型听话」换成了「代码保证一定这样走」。** 模型仍然负责它擅长的部分——理解语言、抽取信息、组织答复;而"下一步去哪"这种确定性的事,交回给确定性代码。
