---
title: 建表规范：字段类型、范式与冗余
date: 2026-02-21
description: 建表是后端最容易埋雷的一步。金额用 float、状态用 varchar、多对多拿逗号拼 ID，上线时都没事，出问题时都是大问题。这篇给出六步建表法，并说明范式什么时候该让位于冗余。
tags: [MySQL, 建表, 数据库设计, 范式]
category: 数据库
---

## 一、建表是"无法回滚"的那一步

接口写错了，改代码发版就行；索引建错了，`DROP INDEX` 也能救。但**表结构一旦上线、数据一旦写进去，改动的成本就完全不是一个量级了**：

- 字段类型要改，可能触发整表重建（`ALTER TABLE` 的代价随数据量线性上升）
- 金额精度丢了，只能靠对账一点点补
- 该拆的表没拆，等到几千万行再拆，就得停机迁移

所以建表这件事值得"慢即是快"——**花在设计上的时间，远小于事后补救的时间**。下面是一套可以照着走的六步法。

## 二、第一步：理清实体与关系（ER 图）

先确定系统里有哪些核心对象，比如用户、订单、商品、库存。然后把关系标出来，重点是两类：

- **一对多**：一个用户有多个订单。外键放在"多"的一方，即订单表里存 `user_id`。
- **多对多**：一个订单有多个商品，一个商品属于多个订单。**必须引入中间表**。

```sql
-- ✅ 多对多：用中间表，结构清晰、可加属性、可建索引
CREATE TABLE order_item (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id    BIGINT UNSIGNED NOT NULL,
    product_id  BIGINT UNSIGNED NOT NULL,
    quantity    INT             NOT NULL DEFAULT 1,
    price       DECIMAL(10, 2)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_product (order_id, product_id),
    KEY idx_product (product_id)
);

-- ❌ 绝对不要这样：用逗号分隔存 ID
-- order 表里放一个 product_ids varchar 字段，值形如 "1001,1002,1003"
```

逗号分隔存 ID 的问题是全方位的：

| 问题 | 说明 |
|---|---|
| 无法建索引 | `WHERE FIND_IN_SET(1001, product_ids)` 必然全表扫描 |
| 无法保证引用完整性 | 删掉的商品 ID 还留在字符串里 |
| 无法携带属性 | 数量、单价这些中间表才能存的字段无处安放 |
| 无法聚合 | 统计"每个商品被下单多少次"需要字符串切割 |
| 长度受限 | 一个订单 500 个商品就撑爆字段 |

**宁可多一张表，也绝不使用逗号分隔存 ID。**

## 三、第二步：字段类型精打细算

类型的核心原则是：**用最小的类型装下业务范围，同时保证精度不出错。**

### 数值类型

```sql
-- 状态值：tinyint 足够（0~255）
status TINYINT NOT NULL DEFAULT 0 COMMENT '0待支付 1已支付 2已发货 3已完成 4已取消'

-- ❌ 反面教材：用 varchar 存"是/否"
-- is_vip VARCHAR(2)  -- 不仅浪费空间，还无法做范围比较和高效索引

-- 金额：绝对不用 float / double
amount DECIMAL(10, 2) NOT NULL COMMENT '订单金额，单位元'
-- 或者用"分"为单位的整数
amount_cent BIGINT NOT NULL COMMENT '订单金额，单位分'
```

**为什么金额不能用浮点？** `float`/`double` 遵循 IEEE 754 二进制浮点标准，无法精确表示十进制小数：

```sql
SELECT 0.1 + 0.2 = 0.3;   -- 用 DOUBLE 计算返回 0（false）
```

在涉及金额累加的场景里，这个误差会累积，最后表现为对账差几分钱。`DECIMAL` 是定点数，按十进制存储，没有这个问题。

### 类型选择速查

| 场景 | 推荐类型 | 说明 |
|---|---|---|
| 主键 / 外键 | `BIGINT UNSIGNED` | 自增，避免用 UUID 做主键（页分裂 + 占空间） |
| 状态、枚举 | `TINYINT` | 配合注释写清取值含义 |
| 金额 | `DECIMAL(10,2)` 或 `BIGINT`（分） | 禁用 `FLOAT`/`DOUBLE` |
| 布尔 | `TINYINT(1)` | 0/1 |
| 固定长度字符串 | `CHAR(n)` | 如手机号、身份证、MD5 |
| 可变长度字符串 | `VARCHAR(n)` | 按实际最大长度给，不要一律 `VARCHAR(255)` |
| 时间 | `DATETIME` / `TIMESTAMP` | `DATETIME` 范围到 9999 年，`TIMESTAMP` 只到 2038 年 |
| 超长文本 | 拆到独立的 `TEXT` 表 | 见下 |
| 非检索扩展字段 | `JSON` | 只用于展示，不用于查询条件 |

### 大字段一定要拆表

`TEXT`/`BLOB` 这类大字段如果和主表放在一起，会带来两个问题：

1. InnoDB 的行格式里，大字段可能溢出到**外部页**，读主表时要多一次 IO。
2. 即使不溢出，行变长也意味着**单个 16KB 页能放的行数变少**，扫描主表时 IO 次数上升。

```sql
-- ✅ 商品主表保持"瘦"，详情单独一张表
CREATE TABLE product (
    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name      VARCHAR(128)    NOT NULL,
    price     DECIMAL(10, 2)  NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE product_detail (
    product_id BIGINT UNSIGNED NOT NULL,
    detail     TEXT,
    PRIMARY KEY (product_id)
);
```

**列表页只查主表，详情页才 JOIN 到详情表**——这是分表最直接的收益。

## 四、第三步：遵守三大范式，但在冗余上开绿灯

### 三大范式

| 范式 | 要求 | 违反的后果 |
|---|---|---|
| **第一范式（1NF）** | 每个字段都是原子值，不可再分 | 出现"1001,1002"这种多值字段 |
| **第二范式（2NF）** | 非主键列完全依赖主键，而非依赖主键的一部分 | 联合主键下出现部分依赖，更新时容易不一致 |
| **第三范式（3NF）** | 非主键列不依赖其他非主键列（消除传递依赖） | 同一事实存多份，改一处忘一处 |

### 什么时候主动冗余

范式解决的是"数据一致性"和"存储浪费"，但它**用 JOIN 换来的**。在高并发读场景下，JOIN 的代价往往比那点冗余空间大得多。

所以有一类冗余是**被鼓励的**——**冗余"下单时刻的快照"**：

```sql
CREATE TABLE `order` (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_no       VARCHAR(32)     NOT NULL,
    user_id        BIGINT UNSIGNED NOT NULL,
    -- 冗余：下单时的用户信息快照
    user_nickname  VARCHAR(64)     NOT NULL COMMENT '下单时的昵称快照',
    user_phone     VARCHAR(20)     NOT NULL COMMENT '下单时的手机号快照',
    -- 冗余：下单时的商品信息快照
    product_name   VARCHAR(128)    NOT NULL COMMENT '下单时的商品名快照',
    amount         DECIMAL(10, 2)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no),
    KEY idx_user_time (user_id, created_at)
);
```

这里的关键认识是：

> **订单里的昵称，语义上不是"这个用户现在叫什么"，而是"下单那一刻他叫什么"。**

用户改了昵称，历史订单里的昵称**本来就不应该跟着变**。这不是为了性能牺牲范式，而是**业务语义本身要求快照**。性能提升只是顺带的收益：订单列表页不需要 JOIN 用户表和商品表。

### 冗余的判断标准

| 该冗余 | 不该冗余 |
|---|---|
| 时点快照（下单时的价格、昵称、地址） | 会持续变化且要求强一致的余额 |
| 变更极少的基础数据（商品名、分类名） | 高频更新的计数类字段（除非有明确的重算机制） |
| 用于避免高频 JOIN 的展示字段 | 大字段、长文本 |

冗余的代价是**一致性维护**。一旦冗余，就必须明确：**谁是权威源，冗余什么时候更新**。快照类冗余没有这个问题（写完就不变），这也是它安全的原因。

## 五、第四步：索引设计"慢即是快"

**先写下所有查询 SQL，再反推建索引。**

```sql
-- 已知查询：按状态 + 时间倒序查列表
-- SELECT ... WHERE status = ? ORDER BY created_at DESC LIMIT 20
KEY idx_status_time (status, created_at)

-- 已知查询：按用户查自己的订单
-- SELECT ... WHERE user_id = ? ORDER BY created_at DESC
KEY idx_user_time (user_id, created_at)
```

三条硬约束：

1. **遵循最左前缀法则**，联合索引的列顺序按"等值在前、范围在后、兼顾排序"排。
2. **严格控制索引数量，单表不超过 5~6 个**。每多一个索引，INSERT / UPDATE / DELETE 就多维护一棵 B+ 树。
3. **拒绝"无脑全字段索引"**，写性能和读性能同样重要。

另外，**主键的选择**在建表时就要定下来：

```sql
-- ✅ 自增 BIGINT 主键：单调递增，新数据总在 B+ 树最右侧插入，几乎不触发页分裂
id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY

-- ❌ UUID 主键：随机值导致插入位置分散，频繁页分裂 + 页空间利用率低
-- 且二级索引要存 36 字节的主键值，索引体积膨胀
```

## 六、第五步：必备"审计追踪"三字段

**每一张表**（哪怕是字典表）都应该包含这三个字段：

```sql
created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP               COMMENT '创建时间',
updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP                     COMMENT '更新时间',
is_deleted  TINYINT     NOT NULL DEFAULT 0                              COMMENT '0存在 1已删除'
```

为什么这三条几乎是强制的：

- **`created_at`**：没有它，线上排查"这条数据什么时候进来的"就只能靠猜。
- **`updated_at` + `ON UPDATE CURRENT_TIMESTAMP`**：由数据库自动维护，应用层忘记赋值也不会漏。排查"这条数据什么时候被改过"时是唯一线索。
- **`is_deleted` 软删除**：**坚决不用物理删除**。物理删掉之后，数据回溯时欲哭无泪——关联的流水、日志全都指向一个不存在的 ID。

软删除的代价是查询都要带 `is_deleted = 0`，所以它应该出现在联合索引的最左列：

```sql
KEY idx_deleted_status_time (is_deleted, status, created_at)
```

> 如果 `is_deleted` 的取值极度倾斜（99.9% 都是 0），把它放最左反而可能降低索引选择性。更彻底的做法是用**归档表**：删除时把行搬到 `xxx_archive` 表，主表保持干净。

## 七、第六步：预留扩展思维

### JSON 字段用在哪

对于**非检索性的扩展参数**，用独立的 JSON 字段比硬塞列要好——列太多会让表结构僵化，加一个属性就要 `ALTER TABLE`。

```sql
extra_info JSON COMMENT '扩展属性，仅用于展示，不参与查询条件'
```

**边界要划清**：JSON 字段里的内容**不要作为检索条件**。MySQL 对 JSON 内部字段建索引需要生成列（generated column），复杂度高且容易被误用。要检索的字段，就该老老实实抽成正式的列。

### 提前规划分库分表键

对于核心大表（订单表、流水表），在建表时就要预估数据量，并**在表设计中埋下水平扩展的伏笔**：

```sql
-- 分片键要提前想清楚，并且保证它出现在每个高频查询的 WHERE 里
-- 按 user_id 取模分片：
--   ✅ WHERE user_id = 1001                  → 能定位到单个分片
--   ✅ WHERE user_id = 1001 AND status = 1   → 能定位
--   ❌ WHERE status = 1                      → 需要扫全部分片
KEY idx_user_time (user_id, created_at)
```

这就是**分片键必须进索引**的原因——它决定了查询能否路由到单个分片。选分片键的三条标准：

1. **分布均匀**：避免热点分片（比如按 `status` 分片就是灾难，因为分布极度倾斜）。
2. **高频查询必带**：否则每次查询都要广播到所有分片。
3. **不可变**：`user_id` 不可变，`status` 会变——变了就要跨分片迁移数据。

## 八、小结

- 六步建表法：**ER 图 → 字段类型 → 范式与冗余 → 索引 → 审计三字段 → 扩展思维**
- 多对多**必须用中间表**，绝不用逗号分隔存 ID（无法索引、无法携带属性、无法聚合）
- 类型精打细算：状态用 `tinyint`，**金额禁用 `float`，用 `decimal` 或"分"为单位的 `bigint`**，超长文本拆到独立表
- 遵守三大范式，但**时点快照类字段要主动冗余**——订单里的昵称本质是"下单那一刻的名字"，不是当前值
- 索引**先有 SQL 再反推**，遵循最左前缀，**单表不超过 5~6 个**，主键用自增 `bigint` 而非 UUID
- **每张表必备 `created_at` / `updated_at` / `is_deleted`**，坚决不用物理删除
- 扩展用 JSON 字段承载非检索属性，**分片键要在建表时就定好并进索引**

建表没有"以后再改"，只有"现在想清楚"。这六步花掉的一两个小时，抵得上事后一次停机迁移。
