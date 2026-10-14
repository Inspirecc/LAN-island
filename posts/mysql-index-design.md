---
title: 索引设计：从最左前缀到索引失效
date: 2026-02-14
description: 索引不是建得越多越快，建错了反而拖慢写入。这篇从聚簇索引与回表讲起，梳理联合索引的列顺序该怎么排、最左前缀法则为什么成立，以及七类常见的索引失效场景。
tags: [MySQL, 索引, 查询优化, 数据库]
category: 数据库
---

## 一、先建立一个正确的顺序

一个常见的错误做法是：表建好了，功能跑通了，然后回头"给常用的字段都加上索引"。

正确的顺序恰好相反：**先写下所有查询 SQL，再反推建什么索引。**

原因很简单——索引是"查询的投影"，脱离了具体的 SQL，你无法判断一个字段该不该建索引，更无法判断联合索引的列顺序。一个字段在 `WHERE` 里出现，不代表它就适合当索引的最左列。下面逐层拆开。

## 二、聚簇索引与二级索引

InnoDB 的表本身就是一个 B+ 树，这张树按主键组织，**叶子节点直接存整行数据**，这叫**聚簇索引**。

其他索引都是**二级索引**（辅助索引），它的叶子节点存的是**索引列的值 + 主键值**，不是整行数据。

| | 聚簇索引 | 二级索引 |
|---|---|---|
| 数量 | 一个表只有 1 个 | 可以有多个 |
| 叶子存什么 | 完整行数据 | 索引列 + 主键值 |
| 由什么决定 | 主键（无主键则用首个非空唯一索引，再没有则用隐藏 rowid） | 建索引时的列 |
| 查询代价 | 一次 B+ 树查找 | 可能两次（含回表） |

### 回表

在二级索引上查到主键后，还要回聚簇索引再查一次，才能拿到查询需要的其他列——这就是**回表**。

```sql
-- 表：users(id PK, name, age, city)，在 name 上建了二级索引 idx_name

SELECT * FROM users WHERE name = 'lan';
-- 步骤 1：在 idx_name 的 B+ 树上找到 name='lan' → 拿到 id=1001
-- 步骤 2：拿 id=1001 回聚簇索引，取出整行      ← 这就是回表
```

回表不是"多一次内存操作"，而是**多走一棵 B+ 树**。如果命中行数很多，回表会变成随机 IO，代价迅速放大。这也是为什么 `EXPLAIN` 里 rows 估算值很大的查询，往往需要重新设计索引。

### 覆盖索引

如果查询涉及的所有列都能从索引里直接拿到，就**不需要回表**，这个索引就叫**覆盖索引**。

```sql
-- 建联合索引
ALTER TABLE users ADD INDEX idx_name_age_city (name, age, city);

-- 查询的三列都在索引上 → 直接返回，无回表
SELECT name, age, city FROM users WHERE name = 'lan';

-- ⚠️ 这一条不覆盖：SELECT * 还要取其他列，仍然回表
SELECT * FROM users WHERE name = 'lan';
```

`EXPLAIN` 的 `Extra` 列出现 **`Using index`**，就代表用上了覆盖索引。

> 一个实用技巧：把 `SELECT *` 改成只查需要的列，有时候能"顺手"把一个索引变成覆盖索引，效果不亚于新建索引，而且没有额外的写入代价。

## 三、最左前缀法则

联合索引 `(a, b, c)` 的 B+ 树，是**先按 a 排序，a 相同再按 b 排序，b 相同再按 c 排序**。

理解这一点，最左前缀法则就是自然推论了：

```sql
ALTER TABLE orders ADD INDEX idx_status_time_user (status, create_time, user_id);
```

| 查询条件 | 能否用索引 | 用到了索引的哪几列 |
|---|---|---|
| `WHERE status = 1` | ✅ | status |
| `WHERE status = 1 AND create_time > '...'` | ✅ | status, create_time |
| `WHERE status = 1 AND create_time = '...' AND user_id = 5` | ✅ | 三列全用 |
| `WHERE create_time = '...'` | ❌ | 跳过了最左的 status |
| `WHERE user_id = 5` | ❌ | 跳过了前两列 |
| `WHERE status = 1 AND user_id = 5` | ⚠️ 部分 | 只用 status，user_id 用不上 |

为什么 `status` + `user_id` 这种"隔列"的情况只能用到一半？因为全局看，`user_id` 在 `status` 相同的前提下才有序，而中间隔着的 `create_time` 没有约束，导致 `user_id` 在整个待扫描区间里**不是有序的**，无法用二分定位，只能过滤。

### 范围查询会"截断"后面的列

```sql
-- status = 1 是等值 → 能用；create_time > ... 是范围 → 后面就断了
SELECT * FROM orders
WHERE status = 1 AND create_time > '2026-01-01' AND user_id = 5;
-- user_id 只能作为过滤条件在回表后判断（或索引下推时在引擎层过滤）
```

**口诀：等值列放前面，范围列放后面，排序列紧随等值列。**

### 联合索引的列顺序怎么排

三条经验规则：

1. **区分度高的列放左边**。区分度 = 不重复值 / 总行数。性别这种区分度接近 0 的列放最左，几乎等于没建索引。
2. **等值查询的列在前，范围查询的列在后**。上面已说明。
3. **兼顾排序**。如果查询固定带 `ORDER BY create_time`，把 `create_time` 放进联合索引可以顺带消掉文件排序：

```sql
-- 索引 (status, create_time)：既过滤 status，又天然满足排序
SELECT id, amount FROM orders
WHERE status = 1
ORDER BY create_time DESC
LIMIT 20;
-- 走索引后 Extra 里不会出现 Using filesort
```

## 四、索引失效的七种场景

索引建了不等于用得上。下面这些写法都会让优化器放弃索引。

### 1. 对索引列做函数运算

```sql
-- ❌ 失效：索引里存的是 create_time 原值，不是 YEAR(create_time)
SELECT * FROM orders WHERE YEAR(create_time) = 2026;

-- ✅ 改写：把运算移到常量侧，范围查询可以用索引
SELECT * FROM orders
WHERE create_time >= '2026-01-01' AND create_time < '2027-01-01';
```

同样的坑还有 `WHERE id + 1 = 10`（改成 `WHERE id = 9`）、`WHERE UPPER(name) = 'LAN'`。

### 2. 隐式类型转换

```sql
-- phone 是 varchar，这里传了数字
-- ❌ 失效：MySQL 把 varchar 转成数字比较，等价于对索引列做了 CAST
SELECT * FROM users WHERE phone = 13800000000;

-- ✅ 加引号，类型对齐
SELECT * FROM users WHERE phone = '13800000000';
```

**这条极易被忽略**，因为 SQL 能跑出正确结果，只是悄悄变成了全表扫描。反过来，如果 `phone` 是 `bigint`，传 `'13800000000'` 字符串，MySQL 会把字符串转成数字，索引**仍然有效**——因为转换发生在常量侧。

> 记住方向：**索引列被转换 → 失效；常量被转换 → 有效。**

### 3. 以通配符开头的 LIKE

```sql
SELECT * FROM products WHERE name LIKE '%洗地机%';   -- ❌ 前置 % 无法定位起点
SELECT * FROM products WHERE name LIKE '洗地机%';     -- ✅ 可以走索引
```

`%` 在前意味着"起点不确定"，B+ 树的有序性用不上。真要做全文模糊匹配，应该交给倒排索引（如 Elasticsearch），而不是在 MySQL 上硬撑。

### 4. 使用 OR 且有一侧无索引

```sql
-- 假设只有 status 有索引，remark 没有
-- ❌ 全表扫描：OR 要求两侧都能走索引，否则还不如扫全表
SELECT * FROM orders WHERE status = 1 OR remark = 'x';

-- ✅ 拆成 UNION ALL，让能走索引的那部分走索引
SELECT * FROM orders WHERE status = 1
UNION ALL
SELECT * FROM orders WHERE remark = 'x';
```

### 5. 违反最左前缀

前文已述。补充一个容易忽略的形态：**范围条件放在最左列**。

```sql
-- 索引 (create_time, status)
-- ❌ status 用不上，因为 create_time 是范围，后面的列在区间内无序
SELECT * FROM orders WHERE create_time > '2026-01-01' AND status = 1;
```

### 6. 使用 != 、NOT IN、NOT EXISTS

`!=` 和 `NOT IN` 意味着"要扫描所有不等于该值的区间"，通常覆盖的数据比例太高，优化器判断**不如直接全表扫描**。不过这属于**代价判断**而非硬性规则——如果 `!=` 过滤后剩下的行很少，优化器也可能走索引。用 `EXPLAIN` 确认，别凭直觉。

### 7. 索引列参与 IS NULL / IS NOT NULL

这条要分情况：

- **单列索引**：`IS NULL` 通常可以走索引。
- **联合索引**：如果 `IS NULL` 的列不是最左列，或者前面的列是范围条件，就可能失效。

它的本质仍然是"过滤后剩余比例"的代价估算问题。

## 五、索引不是越多越好

索引带来查询加速，代价在写入侧：**每多一个索引，插入/更新/删除就要多维护一棵 B+ 树。**

| 操作 | 每多一个索引的额外成本 |
|---|---|
| INSERT | 多一次索引页写入，可能触发页分裂 |
| UPDATE | 若更新的是索引列，要"删除旧键 + 插入新键" |
| DELETE | 每个索引都要标记删除，后续由 purge 清理 |
| 磁盘 | 索引本身占空间，`idx_name_age_city` 会冗余存主键 |

因此有一条广泛使用的经验值：

> **单表索引数量控制在 5~6 个以内。**

拒绝"给每个字段都加索引"这种偷懒做法。正确的取舍是：**优先用联合索引覆盖多个查询**，而不是为每个查询单独建一个索引。

```sql
-- ❌ 三个单列索引，维护三棵树
INDEX (status), INDEX (create_time), INDEX (user_id)

-- ✅ 一个联合索引，可能同时服务多个查询（最左前缀）
INDEX (status, create_time, user_id)
```

判断一个联合索引能否替代单列索引，就看你列的查询清单里，有多少条 SQL 的最左前缀能被它覆盖。**覆盖得越多，这个联合索引越值。**

## 六、小结

- 顺序不能反：**先有 SQL，后有索引**，索引是查询的投影
- 聚簇索引存整行，二级索引只存"索引列 + 主键"；二级索引取其他列要**回表**，多走一棵 B+ 树
- **覆盖索引**（`Extra: Using index`）能消除回表，把 `SELECT *` 改成按需取列有时就能做到
- 最左前缀法则的本质是**联合索引按列顺序排序**；中间断了一列，后面的列就无法二分定位
- 列顺序三原则：**等值在前、范围在后、兼顾排序**
- 索引失效七场景：**函数运算、隐式类型转换、前置 %、OR 无索引侧、违反最左前缀、!= / NOT IN、IS NULL**
- 隐式类型转换的方向要记牢：**索引列被转换才失效，常量被转换不影响**
- **单表索引不超过 5~6 个**，用联合索引替代多个单列索引，既覆盖查询又控制写入成本

最后一句：索引优化的尽头不是"加索引"，而是"**让查询尽量少扫、少回表**"。加索引只是手段之一，改写 SQL 和调整 `SELECT` 列表往往更划算。
