---
title: EXPLAIN 与慢查询优化实战
date: 2026-03-18
description: 一条 SQL 慢，通常不是"数据太多"，而是优化器没找到好的执行路径。这篇讲清 EXPLAIN 里 type、key、rows、Extra 四个关键字段怎么读，以及从 filesort、temporary 到深分页的五类实战优化手段。
tags: [MySQL, EXPLAIN, 慢查询, SQL优化]
category: 数据库
---

## 一、优化的第一步不是改 SQL

看到一条慢 SQL，很多人的第一反应是"加个索引试试"。

更有效的顺序是：**先看执行计划，再决定改什么。** 因为慢的成因至少有四类，对应的解法完全不同：

| 现象 | 常见成因 | 解法方向 |
|---|---|---|
| 扫了很多行但只返回几行 | 没走索引 / 索引选择性差 | 加或改索引 |
| 走了索引但依然慢 | 回表次数太多 | 覆盖索引、减少 `SELECT` 列 |
| `Extra` 里有 filesort / temporary | 排序或分组无法用索引 | 调整索引列顺序或改写 SQL |
| 返回行数本来就不该这么多 | SQL 语义有问题 | 改写 SQL、分页、加过滤条件 |

`EXPLAIN` 就是用来区分这四类的工具。

## 二、EXPLAIN 的四个关键字段

`EXPLAIN` 输出十来个字段，但日常优化真正需要盯紧的只有四个。

```sql
EXPLAIN SELECT o.id, o.amount
FROM `order` o
WHERE o.user_id = 1001 AND o.status = 1
ORDER BY o.created_at DESC
LIMIT 20;
```

| 字段 | 含义 | 关注点 |
|---|---|---|
| **type** | 访问类型，即"怎么找到这些行" | **最重要**，直接反映效率等级 |
| **key** | 实际使用的索引 | 是不是预期的索引？为 `NULL` 就是没用索引 |
| **rows** | 预估要扫描的行数 | 越小越好；与返回行数差距大说明选择性差 |
| **Extra** | 额外信息 | `Using filesort` / `Using temporary` 是重灾区 |

另外两个辅助字段也常看：

- **`possible_keys`**：理论上可用的索引。如果它非空但 `key` 为 `NULL`，说明**优化器主动放弃了索引**，这通常意味着代价估算认为全表扫描更划算。
- **`filtered`**：按索引条件过滤后剩余行的百分比。`rows × filtered%` 才是真正参与后续 JOIN 或返回的行数估算。

## 三、type 的等级

`type` 反映访问效率，从好到坏依次是：

```
system > const > eq_ref > ref > range > index > ALL
```

| type | 含义 | 典型场景 |
|---|---|---|
| **system** | 表只有一行，是 `const` 的特例 | 系统表、单行配置表 |
| **const** | 通过主键或唯一索引**等值**查询，最多一行 | `WHERE id = 1` |
| **eq_ref** | JOIN 时被驱动表走**主键或唯一索引**，每行匹配一条 | `JOIN ... ON a.id = b.id`（b.id 是主键） |
| **ref** | 走**普通索引**等值查询，可能匹配多行 | `WHERE status = 1`（status 有索引） |
| **range** | 索引上的**范围扫描** | `WHERE id > 100`、`BETWEEN`、`IN` |
| **index** | 扫**整棵索引树**（比 ALL 好一点：只读索引，不回表） | `SELECT id FROM t`（覆盖索引但全扫） |
| **ALL** | **全表扫描** | 无可用索引 |

几个容易踩的认知点：

### const 只认"唯一"

```sql
EXPLAIN SELECT * FROM users WHERE id = 1;
-- type: const —— 主键等值，优化器知道最多一行

EXPLAIN SELECT * FROM users WHERE name = 'lan';
-- name 是普通索引 → type: ref，不是 const，因为可能有重名
```

### eq_ref 与 ref 的区别在于"唯一性"

```sql
-- order.user_id → user.id（主键），每条 order 只对应一条 user
EXPLAIN SELECT * FROM `order` o JOIN user u ON o.user_id = u.id;
-- u 的 type 是 eq_ref

-- 反过来，一个 user 有多条 order
EXPLAIN SELECT * FROM user u JOIN `order` o ON o.user_id = u.id;
-- o 的 type 是 ref
```

`eq_ref` 之所以比 `ref` 高一级，是因为优化器**确定每次匹配最多一条**，可以省掉"继续找下一条"的动作。

### index 不等于"好"

`type: index` 容易被误认为"用了索引所以很快"。实际上它是**全索引扫描**——只是比 `ALL` 少读了一个数据文件而已。

```sql
-- 覆盖索引 + 无过滤条件 → 扫整棵索引树
EXPLAIN SELECT id FROM `order`;
-- type: index，Extra: Using index
-- 依然是 O(N)，只是常数更小
```

**看到 `index` 和 `ALL`，都应该当作"没有有效索引"来处理。**

### 目标线

> **在线业务查询，`type` 至少要到 `range`，理想是 `ref` 及以上。**
> 出现 `index` 或 `ALL` 且 `rows` 很大时，就是优化对象。

## 四、Extra：最有信息量的字段

`Extra` 里出现下面这些，各代表一个具体问题。

### 1. Using filesort —— 发生了额外排序

```sql
EXPLAIN SELECT id, amount FROM `order`
WHERE user_id = 1001
ORDER BY created_at DESC;
-- Extra: Using filesort
```

**"filesort" 不等于"用文件排序"**。它只是 MySQL 对"无法利用索引有序性、必须自己排一遍"的叫法，数据量小的时候在内存里排（sort buffer），大了才落磁盘。

它的出现意味着：**索引的顺序和 `ORDER BY` 要求的顺序不一致**。

解法是让 `ORDER BY` 的列进入联合索引，且排在等值列之后：

```sql
-- 索引 (user_id, created_at)
-- user_id 是等值条件 → created_at 在区间内天然有序 → 排序被索引满足
ALTER TABLE `order` ADD INDEX idx_user_time (user_id, created_at);

EXPLAIN SELECT id, amount FROM `order`
WHERE user_id = 1001
ORDER BY created_at DESC;
-- Extra 里不再有 Using filesort
```

### 2. Using temporary —— 用了临时表

```sql
EXPLAIN SELECT user_id, COUNT(*) FROM `order`
GROUP BY user_id;
-- Extra: Using temporary; Using filesort
```

`GROUP BY` 需要对数据分组，如果**分组列的顺序和索引顺序不一致**，MySQL 会建一张临时表来聚合。

```sql
-- 建 (user_id) 或 (user_id, ...) 的索引后，分组可以按索引顺序流式完成
ALTER TABLE `order` ADD INDEX idx_user (user_id);
```

> **`Using temporary` 通常伴随着 `Using filesort`**，因为 `GROUP BY` 在 MySQL 8.0 之前会隐式带上 `ORDER BY`。8.0 去掉了这个隐式排序，但临时表的问题仍在。

### 3. Using index —— 好消息，覆盖索引

表示查询的列全在索引上，**不需要回表**。这是应该追求的状态。

### 4. Using index condition —— 索引条件下推（ICP）

```sql
-- 索引 (status, create_time, user_id)
EXPLAIN SELECT * FROM `order`
WHERE status = 1 AND create_time > '2026-01-01' AND user_id = 5;
-- Extra: Using index condition
```

因为 `create_time` 是范围条件，后面的 `user_id` 无法用于索引定位。ICP 的作用是：**把 `user_id = 5` 这个过滤条件下推到存储引擎层**，在索引上就过滤掉不匹配的记录，**减少回表次数**。

效果是显著的：如果索引扫描出 1000 行、但只有 10 行满足 `user_id = 5`，没有 ICP 就要回表 1000 次，有了 ICP 只需回表 10 次。

### 5. Using where —— 需要留意

表示在存储引擎返回行之后，**Server 层还要再做一次过滤**。

如果 `key` 为 `NULL` 且出现 `Using where`，基本等同于全表扫描 + 逐行过滤。

### 6. Using join buffer / Using MRR

- **`Using join buffer (Block Nested Loop)`**：被驱动表没有可用索引，MySQL 把驱动表的结果缓存起来做嵌套循环。**这通常意味着 JOIN 的索引没建好。**
- **`Using MRR`**（Multi-Range Read）：把随机回表变成按主键排序后的顺序回表，减少随机 IO。

## 五、慢查询日志

`EXPLAIN` 是"针对已知的慢 SQL 做分析"，但第一步其实是**找出哪些 SQL 慢**。这靠慢查询日志。

```sql
-- 查看当前配置
SHOW VARIABLES LIKE 'slow_query%';
SHOW VARIABLES LIKE 'long_query_time';

-- 运行时开启（重启失效，永久生效要写 my.cnf）
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;             -- 超过 1 秒记录
SET GLOBAL log_queries_not_using_indexes = ON;  -- 记录未走索引的 SQL

-- 指定日志文件
SET GLOBAL slow_query_log_file = '/var/log/mysql/slow.log';
```

关键参数说明：

| 参数 | 建议值 | 说明 |
|---|---|---|
| `slow_query_log` | ON | 生产环境必须开启 |
| `long_query_time` | 0.5 ~ 1 秒 | 设成 0 会记录所有 SQL，日志爆炸 |
| `log_queries_not_using_indexes` | 谨慎开启 | 小表全扫也会被记录，容易刷屏 |
| `log_slow_admin_statements` | ON | 把 `ALTER TABLE` 等 DDL 也记上 |
| `min_examined_row_limit` | 如 100 | 扫描行数低于此值不记录，过滤噪音 |

日志本身不好读，通常用工具聚合。MySQL 官方自带的是 **`mysqldumpslow`**：

```bash
# 按总耗时排序，取前 10 条（把相同 SQL 归并，用 N 代替具体值）
mysqldumpslow -s t -t 10 /var/log/mysql/slow.log

# 按平均耗时排序
mysqldumpslow -s at -t 10 /var/log/mysql/slow.log
```

它会把参数不同的同类 SQL 归并成 `SELECT * FROM order WHERE user_id = N`，非常适合找"模式性"的慢查询。

线上更常用的还有 `pt-query-digest`（Percona Toolkit），能分析出每条 SQL 的耗时分布、扫描行数、是否走索引。

### 定位到某条 SQL 的执行计划

拿到慢 SQL 后，除了 `EXPLAIN`，还有两个更强的工具：

```sql
-- 1. EXPLAIN ANALYZE（8.0.18+）：真实执行并给出各步骤的实际耗时
EXPLAIN ANALYZE
SELECT * FROM `order` WHERE user_id = 1001 ORDER BY created_at DESC LIMIT 20;

-- 2. 查看正在运行的长事务 / 慢语句
SHOW FULL PROCESSLIST;
SELECT * FROM information_schema.INNODB_TRX WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 10;
```

`EXPLAIN` 给的是**估算**，`EXPLAIN ANALYZE` 给的是**实际**。当估算和实际差距很大（比如 `rows` 估 100，实际扫了 100 万），通常是**统计信息过期**，可以手动更新：

```sql
ANALYZE TABLE `order`;
```

## 六、五类实战优化手段

### 1. 加索引（第一位，但不是万能药）

```sql
-- 慢：WHERE status = 1 ORDER BY created_at DESC
-- 索引 (status, created_at) 同时解决过滤和排序
ALTER TABLE `order` ADD INDEX idx_status_time (status, created_at);
```

**索引列顺序三原则**：等值列在前、范围列在后、`ORDER BY` 列紧随等值列。同时记得**单表索引控制在 5~6 个以内**。

### 2. 改写 SQL

```sql
-- ❌ 索引列上做函数运算，索引失效
SELECT * FROM `order` WHERE DATE(created_at) = '2026-01-01';

-- ✅ 改成范围查询
SELECT * FROM `order`
WHERE created_at >= '2026-01-01 00:00:00'
  AND created_at <  '2026-01-02 00:00:00';


-- ❌ 隐式类型转换：phone 是 varchar，传了数字
SELECT * FROM users WHERE phone = 13800000000;

-- ✅ 类型对齐
SELECT * FROM users WHERE phone = '13800000000';


-- ❌ 前置通配符，无法走索引
SELECT * FROM product WHERE name LIKE '%洗地机%';

-- ✅ 前缀匹配可以走索引（需要全文检索时交给专门的搜索引擎）
SELECT * FROM product WHERE name LIKE '洗地机%';


-- ❌ 相关子查询：外层每行都要执行一次内层查询
SELECT * FROM `order` o
WHERE EXISTS (SELECT 1 FROM user u WHERE u.id = o.user_id AND u.vip = 1);

-- ✅ 改写成 JOIN，让优化器自己选驱动顺序
SELECT o.* FROM `order` o
JOIN user u ON u.id = o.user_id AND u.vip = 1;
```

### 3. 减少回表

```sql
-- ❌ SELECT *：无法覆盖，每一行都要回表
EXPLAIN SELECT * FROM `order` WHERE user_id = 1001;
-- Extra: NULL（需要回表）

-- ✅ 只取需要的列，让索引变覆盖
EXPLAIN SELECT user_id, created_at FROM `order` WHERE user_id = 1001;
-- Extra: Using index（无回表）
```

**如果必须取多列又不想回表**，可以建覆盖索引：

```sql
ALTER TABLE `order` ADD INDEX idx_user_time_amount (user_id, created_at, amount);
-- 三列都在索引上 → 无回表
SELECT user_id, created_at, amount FROM `order` WHERE user_id = 1001;
```

代价是索引变宽、写入变慢，要权衡。

### 4. 分页优化（深分页问题）

这是最经典的一类慢 SQL：

```sql
-- ❌ 深分页：扫描 1000020 行，只为返回最后 20 行
SELECT * FROM `order` ORDER BY id LIMIT 1000000, 20;
```

`LIMIT m, n` 的语义是"**先取出 m+n 行，再丢掉前 m 行**"。所以 `m` 越大，白扫的行越多，而且这些行往往还要回表。

三种优化思路：

**方案一：延迟关联（用覆盖索引先定位主键）**

```sql
-- ✅ 先用覆盖索引拿 id（不回表），再 JOIN 回原表取数据
SELECT o.* FROM `order` o
INNER JOIN (
    SELECT id FROM `order` ORDER BY id LIMIT 1000000, 20
) t ON o.id = t.id;
```

子查询里的排序和分页都在主键索引上完成，**不需要回表**；只有最终 20 行才回表。

**方案二：游标分页（记录上次的最大 ID）**

```sql
-- ✅ 用"上一页最后一条的 id"作为起点，避免 OFFSET
SELECT * FROM `order`
WHERE id > 1000000        -- 上次返回的最后一个 id
ORDER BY id
LIMIT 20;
```

这是**语义上更正确的做法**，因为深分页的 `OFFSET` 在大数据量下既慢、又容易因为并发插入而"漏行"或"重行"。缺点是**只能顺序翻页，不能跳页**——所以在 C 端列表（瀑布流、下拉加载）里非常合适，在需要跳页的后台管理里则要配合方案一。

**方案三：限制最大页数**

产品层面直接限定"最多只能翻到第 100 页"，超出的引导用户加筛选条件。这是最省事、也最符合业务实际的做法——**用户不会真的翻到第 5000 页**。

### 5. 拆分大查询

```sql
-- ❌ 一次性统计半年的数据，扫描量巨大
SELECT COUNT(*), status FROM `order`
WHERE created_at >= '2025-07-01'
GROUP BY status;

-- ✅ 按时间分片，逐段统计后累加（或从预聚合表读）
-- 配合定时任务把结果写进统计表，查询时直接读结果
```

对于报表类、统计类查询，**预聚合**往往比优化 SQL 更有效：把计算从"查询时"移到"写入时"或"定时任务里"。

## 七、小结

- 优化顺序：**慢查询日志定位 → EXPLAIN 分析 → 决定改索引还是改 SQL**，不要一上来就加索引
- 四个关键字段：**type**（访问类型）、**key**（实际索引）、**rows**（预估扫描行数）、**Extra**（额外动作）
- `type` 等级：**system > const > eq_ref > ref > range > index > ALL**，目标是 **range 及以上**；`index` 和 `ALL` 都应视为"没有有效索引"
- **`Using filesort`** = 索引顺序不满足 `ORDER BY`；**`Using temporary`** = `GROUP BY` 无法按索引顺序完成
- **`Using index`** 是覆盖索引（好事）；**`Using index condition`** 是索引条件下推，能显著减少回表
- 慢查询日志必须开，`long_query_time` 设 0.5~1 秒；用 `mysqldumpslow` 或 `pt-query-digest` 聚合
- `EXPLAIN` 给估算，**`EXPLAIN ANALYZE`（8.0.18+）给实际**；两者差距大说明统计信息过期，跑 `ANALYZE TABLE`
- 五类手段：**加索引、改写 SQL、减少回表、优化分页（延迟关联 / 游标分页）、拆分大查询**
- 深分页的本质是 `LIMIT m, n` 要**先扫 m+n 行再丢弃前 m 行**；C 端列表优先用**游标分页**

最后提醒一句：**优化前先量化**。跑一遍 `EXPLAIN`，记下 `rows` 和 `type`；改完再跑一遍对比。没有前后对比的"优化"，只是换了一种写法而已。
